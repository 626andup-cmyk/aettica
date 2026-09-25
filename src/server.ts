/**
 * The Aettica server.
 *
 * This is a small web server, run by Bun in Termux on your phone. It does two
 * jobs:
 *
 *   1. Serves the web app (the files in `public/`) to your browser.
 *   2. Answers the app's API requests under `/api/...`: reading the chat,
 *      saving messages, changing settings, and asking your partner to write.
 *
 * The browser never talks to nanoGPT itself. Your API key stays on the server,
 * and the server is the only thing that reads or writes your data.
 *
 * API overview (all request and response bodies are JSON):
 *
 *   GET    /api/state              Settings, all messages, and whether the partner is writing
 *   PUT    /api/settings           Change settings (any subset of fields)
 *   POST   /api/messages           Send your message, then the partner replies
 *   PATCH  /api/messages/:id       Edit a message's text
 *   DELETE /api/messages/:id       Delete one message
 *   DELETE /api/messages           Delete every message
 *   POST   /api/turn               Partner takes a turn without a new message from you
 *   POST   /api/regenerate         Replace the partner's last reply with a new one
 *   GET    /api/prompt             Show the exact prompt stack the next turn would send
 *   GET    /api/models             List models available on nanoGPT
 *
 * Run it with `bun start`.
 */

import { join, normalize, sep } from "node:path";
import { loadConfig, type Config } from "./config.ts";
import { ApiError, listModels, type ApiOptions } from "./nanogpt.ts";
import { BusyError, Partner } from "./partner.ts";
import { buildPromptStack } from "./prompt.ts";
import { Store, validateSettings } from "./store.ts";

/** Longest message you can send, in characters. A generous guard against accidents. */
const MAX_MESSAGE_LENGTH = 100_000;

/**
 * An error that should be sent to the browser with a specific HTTP status.
 * Thrown by route handlers; turned into a JSON response by `handle`.
 */
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The pieces a running app is made of, returned so tests can reach into them. */
export interface App {
  /** Handles one HTTP request. This is what `Bun.serve` calls. */
  fetch: (request: Request) => Promise<Response>;
  store: Store;
  partner: Partner;
}

/**
 * Wire everything together: open the store, create the partner, and build the
 * request handler. Nothing is listening yet; `main()` does that.
 */
export function createApp(config: Config): App {
  const store = new Store(config.dataDir);
  const api: ApiOptions = {
    apiKey: config.apiKey,
    baseUrl: config.apiBaseUrl,
    timeoutMs: config.requestTimeoutMs,
  };
  const partner = new Partner(store, api);

  /** Handle one API request, or return `null` if no route matches. */
  async function route(request: Request, url: URL): Promise<Response | null> {
    const { method } = request;
    const path = url.pathname;

    if (method === "GET" && path === "/api/state") {
      return json({ settings: store.getSettings(), messages: store.getMessages(), busy: partner.busy });
    }

    if (method === "PUT" && path === "/api/settings") {
      const update = validateSettings(await readJson(request));
      return json({ settings: store.updateSettings(update) });
    }

    if (method === "POST" && path === "/api/messages") {
      const body = await readJson(request);
      const content = requireText(body, "content");
      // Refuse *before* saving, so a message sent while the partner is busy
      // isn't saved without a reply attached.
      if (partner.busy) throw new BusyError();
      const userMessage = store.addMessage("user", content);
      // The reply is attempted separately: if it fails, your message is still
      // saved and the app offers to retry with a partner turn.
      const reply = await tryTurn(() => partner.takeTurn("user-message"));
      return json({ userMessage, ...reply });
    }

    if (method === "DELETE" && path === "/api/messages") {
      if (partner.busy) throw new BusyError();
      store.clearMessages();
      return json({ ok: true });
    }

    // Routes with an id in the path: /api/messages/<id>
    const idMatch = path.match(/^\/api\/messages\/([\w-]+)$/);
    if (idMatch) {
      const id = idMatch[1]!;
      if (method === "PATCH") {
        const content = requireText(await readJson(request), "content");
        const message = store.editMessage(id, content);
        if (!message) throw new HttpError(404, "That message doesn't exist.");
        return json({ message });
      }
      if (method === "DELETE") {
        if (partner.busy) throw new BusyError();
        if (!store.deleteMessage(id)) throw new HttpError(404, "That message doesn't exist.");
        return json({ ok: true });
      }
    }

    if (method === "POST" && path === "/api/turn") {
      const message = await partner.takeTurn("continue");
      return json({ partnerMessage: message });
    }

    if (method === "POST" && path === "/api/regenerate") {
      if (partner.busy) throw new BusyError();
      const last = store.lastMessage();
      if (!last || last.author !== "partner") {
        throw new HttpError(400, "The last message isn't from your partner, so there's nothing to regenerate.");
      }
      // Generate first, and only delete the old reply once the new one exists.
      // If generation fails you keep the reply you had.
      const message = await partner.takeTurn("regenerate", { replacing: last.id });
      return json({ partnerMessage: message, replacedId: last.id });
    }

    if (method === "GET" && path === "/api/prompt") {
      return json({ messages: buildPromptStack(store.getSettings(), store.getMessages()) });
    }

    if (method === "GET" && path === "/api/models") {
      return json({ models: await listModels(api) });
    }

    return null;
  }

  /**
   * The top-level request handler: API routes, then static files, and turn
   * any thrown error into a JSON error response.
   */
  async function fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (!url.pathname.startsWith("/api/")) {
      return serveStatic(config.publicDir, url.pathname);
    }

    try {
      checkRequestIsFromTheApp(request);
      return (await route(request, url)) ?? errorResponse(404, "No such API route.");
    } catch (error) {
      if (error instanceof HttpError) return errorResponse(error.status, error.message);
      if (error instanceof BusyError) return errorResponse(409, error.message);
      if (error instanceof ApiError) return errorResponse(502, error.message);
      if (error instanceof Error && error.message) {
        // Validation errors from the store are plain Errors with a readable message.
        return errorResponse(400, error.message);
      }
      console.error("[server] unexpected error", error);
      return errorResponse(500, "Something went wrong on the server.");
    }
  }

  return { fetch, store, partner };
}

/**
 * Run a partner turn, but report failure as data instead of throwing.
 * Used after sending a message, where the message itself has already been
 * saved successfully and only the reply failed.
 */
async function tryTurn(turn: () => Promise<unknown>): Promise<{ partnerMessage?: unknown; error?: string }> {
  try {
    return { partnerMessage: await turn() };
  } catch (error) {
    if (error instanceof ApiError || error instanceof BusyError) return { error: error.message };
    throw error;
  }
}

// -------------------------------------------------------- request helpers

/**
 * Basic protection against other websites using your server.
 *
 * Any web page open in your phone's browser could try to send requests to
 * `http://127.0.0.1:3000`. Browsers block such pages from *reading* the
 * answers, but a simple form-style POST could still make your partner take a
 * turn (and spend your nanoGPT balance). Requiring a JSON content type on
 * every request that changes something stops that: browsers won't send a
 * cross-site JSON request without first asking the server for permission,
 * and this server never gives it.
 */
function checkRequestIsFromTheApp(request: Request): void {
  if (request.method === "GET" || request.method === "HEAD") return;
  const type = request.headers.get("content-type") ?? "";
  if (!type.startsWith("application/json")) {
    throw new HttpError(415, "API requests that change data must be sent as JSON.");
  }
}

/** Parse the request body as JSON, with a clear error if it isn't. */
async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, "The request body isn't valid JSON.");
  }
}

/** Read a required, non-empty text field from a JSON body. */
function requireText(body: unknown, field: string): string {
  const value = (body as Record<string, unknown> | null)?.[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpError(400, `"${field}" must be non-empty text.`);
  }
  if (value.length > MAX_MESSAGE_LENGTH) {
    throw new HttpError(400, `"${field}" is too long.`);
  }
  return value;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function errorResponse(status: number, message: string): Response {
  return json({ error: message }, status);
}

// ------------------------------------------------------------ static files

/**
 * Serve a file from `public/`.
 *
 * `/` serves `index.html`. The path is normalised and checked to stay inside
 * the public folder, so a request like `/../.env` can't read files elsewhere.
 */
async function serveStatic(publicDir: string, pathname: string): Promise<Response> {
  let relative: string;
  try {
    relative = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  const filePath = normalize(join(publicDir, relative));
  if (!filePath.startsWith(publicDir + sep)) {
    return new Response("Not found", { status: 404 });
  }

  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    return new Response("Not found", { status: 404 });
  }

  // `no-cache` means "check with the server before using a cached copy", so
  // updates to the app show up on the next load instead of being stuck behind
  // a stale cache.
  return new Response(file, { headers: { "Cache-Control": "no-cache" } });
}

// --------------------------------------------------------------- start up

/** Start listening. Only runs when this file is executed directly. */
function main(): void {
  const config = loadConfig();
  const app = createApp(config);

  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    fetch: app.fetch,
    // Model replies can take a while; don't let Bun close the connection on
    // a slow generation. (Bun's limit is in seconds, 255 at most; 0 = never.)
    idleTimeout: 0,
  });

  console.log(`Aettica is running at http://${server.hostname}:${server.port}`);
  console.log(`Saving your chat in ${config.dataDir}`);
  if (!config.apiKey) {
    console.warn("Warning: NANOGPT_API_KEY is not set, so your partner can't reply yet. See .env.example.");
  }
}

// `import.meta.main` is true when this file is run with `bun run src/server.ts`,
// and false when the tests import it. That way importing doesn't start a server.
if (import.meta.main) {
  main();
}
