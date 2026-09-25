/**
 * The Aettica server.
 *
 * This is a small web server, run by Bun in Termux on your phone. It does two
 * jobs:
 *
 *   1. Serves the web app (the files in `public/`) to your browser.
 *   2. Answers the app's API requests under `/api/...`: reading channels and
 *      messages, saving changes, and asking your partner to write.
 *
 * The browser never talks to nanoGPT itself. Your API key stays on the server,
 * and the server is the only thing that reads or writes your data.
 *
 * API overview (all request and response bodies are JSON):
 *
 *   GET    /api/state                          Settings, channels, and where the partner is writing
 *   PUT    /api/settings                       Change settings (any subset of fields)
 *   GET    /api/models                         List models available on nanoGPT
 *
 *   POST   /api/channels                       Create a channel
 *   PATCH  /api/channels/:id                   Rename a channel or change its character
 *   DELETE /api/channels/:id                   Delete a channel and all its messages
 *   PUT    /api/channels/order                 Put the channels in a new order
 *
 *   GET    /api/channels/:id/messages          Every message in a channel
 *   POST   /api/channels/:id/messages          Send your message, then the partner replies
 *   DELETE /api/channels/:id/messages          Delete every message in a channel
 *   POST   /api/channels/:id/turn              Partner takes a turn without a new message from you
 *   POST   /api/channels/:id/regenerate        Replace the partner's last reply with a new one
 *   POST   /api/channels/:id/cancel            Stop the partner's turn in progress (the Stop button)
 *   GET    /api/channels/:id/prompt            The exact prompt stack the next turn would send
 *
 *   PATCH  /api/messages/:id                   Edit a message's text
 *   DELETE /api/messages/:id                   Delete one message
 *
 * Run it with `bun start`.
 */

import { join, normalize, sep } from "node:path";
import { loadConfig, type Config } from "./config.ts";
import { ApiError, CancelledError, listModels, type ApiOptions } from "./nanogpt.ts";
import { BusyError, Partner, promptForChannel } from "./partner.ts";
import {
  NotFoundError,
  Store,
  ValidationError,
  validateChannelUpdate,
  validateNewChannel,
  validateSettings,
} from "./store.ts";

/** Longest message you can send, in characters. A generous guard against accidents. */
const MAX_MESSAGE_LENGTH = 100_000;

/**
 * An error that should be sent to the browser with a specific HTTP status.
 * Thrown by route handlers; turned into a JSON response by `fetch`.
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
 * One API route: a method, a path pattern, and what to do.
 *
 * In a pattern, `:id` matches one path segment, and its value arrives in
 * `params.id`. So `/api/channels/:id/turn` matches `/api/channels/abc/turn`
 * with `params.id === "abc"`.
 */
interface Route {
  method: string;
  pattern: string;
  handler: (request: Request, params: Record<string, string>) => Promise<Response> | Response;
}

/**
 * Check a request's method and path against a route.
 * Returns the `:name` values if it matches, or `null` if it doesn't.
 */
export function matchRoute(route: Pick<Route, "method" | "pattern">, method: string, path: string) {
  if (route.method !== method) return null;
  const want = route.pattern.split("/");
  const got = path.split("/");
  if (want.length !== got.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i++) {
    if (want[i]!.startsWith(":")) {
      if (got[i] === "") return null;
      try {
        params[want[i]!.slice(1)] = decodeURIComponent(got[i]!);
      } catch {
        return null; // badly encoded, like "%zz": treat as no match
      }
    } else if (want[i] !== got[i]) {
      return null;
    }
  }
  return params;
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

  /** Refuse to change a channel's messages while the partner is writing there. */
  function ensureIdle(channelId: string): void {
    if (partner.isBusy(channelId)) throw new BusyError();
  }

  // Routes are checked in order and the first match wins, so fixed paths
  // (`/api/channels/order`) must come before patterns that would also match
  // them (`/api/channels/:id`).
  const routes: Route[] = [
    // ------------------------------------------------------- server-wide
    {
      method: "GET",
      pattern: "/api/state",
      handler: () =>
        json({ settings: store.getSettings(), channels: store.listChannels(), busyChannels: partner.busyChannels() }),
    },
    {
      method: "PUT",
      pattern: "/api/settings",
      handler: async (request) => json({ settings: store.updateSettings(validateSettings(await readJson(request))) }),
    },
    {
      method: "GET",
      pattern: "/api/models",
      handler: async () => json({ models: await listModels(api) }),
    },

    // ---------------------------------------------------------- channels
    {
      method: "POST",
      pattern: "/api/channels",
      handler: async (request) => json({ channel: store.createChannel(validateNewChannel(await readJson(request))) }),
    },
    {
      method: "PUT",
      pattern: "/api/channels/order",
      handler: async (request) => {
        const body = (await readJson(request)) as { ids?: unknown };
        if (!Array.isArray(body?.ids) || !body.ids.every((id) => typeof id === "string")) {
          throw new HttpError(400, '"ids" must be a list of channel ids.');
        }
        return json({ channels: store.reorderChannels(body.ids) });
      },
    },
    {
      method: "PATCH",
      pattern: "/api/channels/:id",
      handler: async (request, { id }) =>
        json({ channel: store.updateChannel(id!, validateChannelUpdate(await readJson(request))) }),
    },
    {
      method: "DELETE",
      pattern: "/api/channels/:id",
      handler: (_request, { id }) => {
        // A turn in progress would try to save its reply into a channel that
        // no longer exists, so wait for it to finish.
        ensureIdle(id!);
        store.deleteChannel(id!);
        return json({ ok: true });
      },
    },

    // ------------------------------------------------ channel messages
    {
      method: "GET",
      pattern: "/api/channels/:id/messages",
      handler: (_request, { id }) => json({ messages: store.getMessages(id!) }),
    },
    {
      method: "POST",
      pattern: "/api/channels/:id/messages",
      handler: async (request, { id }) => {
        const content = requireText(await readJson(request), "content");
        store.getChannel(id!); // 404 for an unknown channel
        // Refuse *before* saving, so a message sent while the partner is busy
        // isn't saved without a reply attached.
        ensureIdle(id!);
        const userMessage = store.addMessage({ channelId: id!, author: "user", content });
        // The reply is attempted separately: if it fails, your message is still
        // saved and the app offers to retry with a partner turn.
        const reply = await tryTurn(() => partner.takeTurn(id!, "user-message"));
        return json({ userMessage, ...reply });
      },
    },
    {
      method: "DELETE",
      pattern: "/api/channels/:id/messages",
      handler: (_request, { id }) => {
        ensureIdle(id!);
        store.clearMessages(id!);
        return json({ ok: true });
      },
    },
    {
      method: "POST",
      pattern: "/api/channels/:id/turn",
      handler: async (_request, { id }) => json({ partnerMessage: await partner.takeTurn(id!, "continue") }),
    },
    {
      method: "POST",
      pattern: "/api/channels/:id/regenerate",
      handler: async (_request, { id }) => {
        ensureIdle(id!);
        const last = store.lastMessage(id!);
        if (!last || last.author !== "partner") {
          throw new HttpError(400, "The last message isn't from your partner, so there's nothing to regenerate.");
        }
        // Generate first, and only delete the old reply once the new one exists.
        // If generation fails you keep the reply you had.
        const message = await partner.takeTurn(id!, "regenerate", { replacing: last.id });
        return json({ partnerMessage: message, replacedId: last.id });
      },
    },
    {
      method: "POST",
      pattern: "/api/channels/:id/cancel",
      handler: (_request, { id }) => {
        store.getChannel(id!); // 404 for an unknown channel
        // `cancelled` is false if nothing was running, e.g. the reply
        // arrived just before you pressed Stop.
        return json({ cancelled: partner.cancel(id!) });
      },
    },
    {
      method: "GET",
      pattern: "/api/channels/:id/prompt",
      handler: (_request, { id }) => json({ messages: promptForChannel(store, id!) }),
    },

    // ---------------------------------------------------------- messages
    {
      method: "PATCH",
      pattern: "/api/messages/:id",
      handler: async (request, { id }) => {
        const content = requireText(await readJson(request), "content");
        return json({ message: store.editMessage(id!, content) });
      },
    },
    {
      method: "DELETE",
      pattern: "/api/messages/:id",
      handler: (_request, { id }) => {
        ensureIdle(store.getMessage(id!).channelId);
        store.deleteMessage(id!);
        return json({ ok: true });
      },
    },
  ];

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
      for (const route of routes) {
        const params = matchRoute(route, request.method, url.pathname);
        if (params) return await route.handler(request, params);
      }
      return errorResponse(404, "No such API route.");
    } catch (error) {
      if (error instanceof HttpError) return errorResponse(error.status, error.message);
      if (error instanceof NotFoundError) return errorResponse(404, error.message);
      if (error instanceof BusyError) return errorResponse(409, error.message);
      if (error instanceof ValidationError) return errorResponse(400, error.message);
      // A turn you stopped isn't an error: the request that started it just
      // learns that nothing was written.
      if (error instanceof CancelledError) return json({ cancelled: true });
      if (error instanceof ApiError) return errorResponse(502, error.message);
      // Anything else is a bug, not something you did. Log the details for
      // debugging, and send a general message.
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
async function tryTurn(
  turn: () => Promise<unknown>,
): Promise<{ partnerMessage?: unknown; error?: string; cancelled?: true }> {
  try {
    return { partnerMessage: await turn() };
  } catch (error) {
    if (error instanceof CancelledError) return { cancelled: true };
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
  console.log(`Saving your data in ${config.dataDir}`);
  if (!config.apiKey) {
    console.warn("Warning: NANOGPT_API_KEY is not set, so your partner can't reply yet. See .env.example.");
  }
}

// `import.meta.main` is true when this file is run with `bun run src/server.ts`,
// and false when the tests import it. That way importing doesn't start a server.
if (import.meta.main) {
  main();
}
