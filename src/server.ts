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
 *   GET    /api/state                          Settings, channels, where the partner is writing, and the app version
 *   PUT    /api/settings                       Change settings (any subset of fields)
 *   GET    /api/models                         List models available on nanoGPT
 *
 *   POST   /api/channels                       Create a channel
 *   PATCH  /api/channels/:id                   Rename a channel, or change its style or theme
 *   DELETE /api/channels/:id                   Delete a channel and all its messages
 *   PUT    /api/channels/order                 Put the channels in a new order
 *
 *   GET    /api/channels/:id/messages          Every message in a channel
 *   POST   /api/channels/:id/messages          Send your message, then the partner replies
 *                                              (or add a scene break, if the message is `=====`)
 *   POST   /api/channels/:id/scene-breaks      Add a scene break
 *   DELETE /api/channels/:id/messages          Delete every message in a channel
 *   POST   /api/channels/:id/turn              Partner takes a turn without a new message from you
 *   POST   /api/channels/:id/regenerate        Replace the partner's last reply with a new one
 *   POST   /api/channels/:id/cancel            Stop the partner's turn in progress (the Stop button)
 *   GET    /api/channels/:id/prompt            The exact prompt stack the next turn would send
 *   PUT    /api/channels/:id/cast/:entryId     Pin a notebook entry to a channel (add it to the cast)
 *   DELETE /api/channels/:id/cast/:entryId     Unpin it
 *
 *   PATCH  /api/messages/:id                   Edit a message's text
 *   DELETE /api/messages/:id                   Delete one message
 *
 *   GET    /api/notebook                       Folders, entries and suggestions you can see, and field templates
 *   POST   /api/notebook/entries               Make an entry (a character or lore)
 *   PATCH  /api/notebook/entries/:id           Change an entry's contents (or suggest a change)
 *   PUT    /api/notebook/entries/:id/settings  Change its owner, visibility, editing or folder (owner only)
 *   DELETE /api/notebook/entries/:id           Delete an entry (or suggest deleting it)
 *   POST   /api/notebook/folders               Make a folder
 *   PATCH  /api/notebook/folders/:id           Rename a folder or change its settings
 *   DELETE /api/notebook/folders/:id           Delete a folder (its entries are kept)
 *   POST   /api/notebook/suggestions/:id/:action  accept, reject or withdraw a suggestion
 *
 * Every channel in a response comes with its `cast`: the entries pinned to
 * it, as you see them (see `ChannelView`). The notebook acts as you
 * ("user"); your partner gets tools for it in stage 6.
 *
 *   GET    /api/themes                         Every theme, for the theme picker
 *   POST   /api/themes                         Make a new theme, copying another
 *   GET    /api/themes/:id                     One theme's CSS and files, for the editor
 *   PATCH  /api/themes/:id                     Change one of your themes
 *   DELETE /api/themes/:id                     Delete one of your themes
 *   POST   /api/themes/:id/files               Add an image or font to one of your themes
 *   DELETE /api/themes/:id/files/:name         Remove one
 *
 * Theme files themselves are served at /themes/<id>/<file> (see src/themes.ts).
 *
 * Run it with `bun start`.
 */

import { readFileSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import { loadConfig, type Config } from "./config.ts";
import { ApiError, CancelledError, listModels, type ApiOptions } from "./nanogpt.ts";
import { BusyError, Partner, pickProfile, promptForChannel } from "./partner.ts";
import { parseSceneBreak, postToMessages } from "./posts.ts";
import { DEFAULT_THEME, ThemeLibrary } from "./themes.ts";
import { ENTRY_TEMPLATES } from "./notebook.ts";
import type { CastMember, Channel, Message } from "./types.ts";
import { PermissionError } from "./errors.ts";
import {
  NotFoundError,
  Store,
  ValidationError,
  validateChannelUpdate,
  validateNewChannel,
  validateSettings,
} from "./store.ts";

/** A channel as the app receives it: with its cast, as you see it. */
export type ChannelView = Channel & { cast: CastMember[] };

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
  themes: ThemeLibrary;
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
 * A fingerprint of the web app's files: it changes whenever any file in
 * `public/` changes.
 *
 * An installed app can stay open in the background for days. After you
 * update Aettica and restart the server, that open page is still running the
 * old code. The page compares this fingerprint with the one it started with,
 * and reloads when they differ (see `checkForUpdate` in public/app.js).
 */
export function appVersion(publicDir: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  // Sorted, so the same files always give the same fingerprint.
  const files = [...new Bun.Glob("**/*").scanSync({ cwd: publicDir })].sort();
  for (const file of files) {
    hasher.update(file);
    hasher.update(readFileSync(join(publicDir, file)));
  }
  // The first 12 characters are plenty to tell versions apart.
  return hasher.digest("hex").slice(0, 12);
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
  const version = appVersion(config.publicDir);
  const themes = new ThemeLibrary(
    config.themesDir,
    join(config.dataDir, "themes"),
    readFileSync(join(config.publicDir, "style.css"), "utf8"),
  );

  /** Refuse a theme id that doesn't exist (for settings and channels). */
  function ensureTheme(id: string | null | undefined): void {
    if (id && !themes.exists(id)) throw new HttpError(400, "That theme doesn't exist.");
  }

  /** A channel, with its cast as you see it (hidden entries shown as "??? (hidden)"). */
  function channelView(channel: Channel): ChannelView {
    return { ...channel, cast: store.notebook.castFor("user", channel.id) };
  }

  function channelViews(): ChannelView[] {
    return store.listChannels().map(channelView);
  }

  function sceneBreakResult(result: { sceneBreak: Message; channel: Channel }) {
    return { sceneBreak: result.sceneBreak, channel: channelView(result.channel) };
  }

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
        json({
          settings: store.getSettings(),
          channels: channelViews(),
          profiles: store.profiles.list(),
          roulettes: store.profiles.listRoulettes(),
          busyChannels: partner.busyChannels(),
          appVersion: version,
        }),
    },
    {
      method: "PUT",
      pattern: "/api/settings",
      handler: async (request) => {
        const update = validateSettings(await readJson(request));
        ensureTheme(update.appTheme);
        for (const assignment of [update.rpAssignment, update.oocAssignment]) {
          if (assignment) store.profiles.checkAssignment(assignment);
        }
        return json({ settings: store.updateSettings(update) });
      },
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
      handler: async (request) =>
        json({ channel: channelView(store.createChannel(validateNewChannel(await readJson(request)))) }),
    },
    {
      method: "PUT",
      pattern: "/api/channels/order",
      handler: async (request) => {
        const body = (await readJson(request)) as { ids?: unknown };
        if (!Array.isArray(body?.ids) || !body.ids.every((id) => typeof id === "string")) {
          throw new HttpError(400, '"ids" must be a list of channel ids.');
        }
        store.reorderChannels(body.ids);
        return json({ channels: channelViews() });
      },
    },
    {
      method: "PATCH",
      pattern: "/api/channels/:id",
      handler: async (request, { id }) => {
        const update = validateChannelUpdate(await readJson(request));
        ensureTheme(update.theme);
        if (update.assignment) store.profiles.checkAssignment(update.assignment);
        return json({ channel: channelView(store.updateChannel(id!, update)) });
      },
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
        const body = await readJson(request);
        const content = requireText(body, "content");
        const channel = store.getChannel(id!); // 404 for an unknown channel
        // Refuse *before* saving, so a message sent while the partner is busy
        // isn't saved without a reply attached.
        ensureIdle(id!);

        // `=====` (with an optional title) in an RP channel is a scene break,
        // not a post, and the partner doesn't reply to it.
        const sceneTitle = channel.kind === "rp" ? parseSceneBreak(content) : null;
        if (sceneTitle !== null) return json(sceneBreakResult(store.addSceneBreak(id!, "user", sceneTitle)));

        const yourCharacters = store.notebook.postableCharacters();
        const postingAs = readPostingAs(body, yourCharacters);
        const messages = postToMessages(channel, content, yourCharacters, postingAs);
        if (messages.length === 0) throw new HttpError(400, "There's nothing to send after the character tags.");
        const userMessages = store.addTurn(messages);

        // Posting as one of your characters puts them in the channel's cast,
        // if they aren't already.
        for (const name of new Set(userMessages.flatMap((m) => m.characters))) {
          const entry = yourCharacters.find((c) => c.name === name);
          if (entry) store.notebook.pin("user", id!, entry.id);
        }

        // The reply is attempted separately: if it fails, your message is still
        // saved and the app offers to retry with a partner turn.
        const reply = await tryTurn(() => partner.takeTurn(id!, "user-message"));
        return json({ userMessages, ...reply, channel: channelView(store.getChannel(id!)) });
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
      handler: async (_request, { id }) => json({ partnerMessages: await partner.takeTurn(id!, "continue") }),
    },
    {
      method: "POST",
      pattern: "/api/channels/:id/scene-breaks",
      handler: async (request, { id }) => {
        const body = (await readJson(request)) as { title?: unknown } | null;
        const title = body?.title ?? "";
        if (typeof title !== "string" || title.length > 200) {
          throw new HttpError(400, '"title" must be text of 200 characters at most.');
        }
        // Waits for a turn in progress, so the break can't land in the middle
        // of a reply.
        ensureIdle(id!);
        return json(sceneBreakResult(store.addSceneBreak(id!, "user", title)));
      },
    },
    {
      method: "POST",
      pattern: "/api/channels/:id/regenerate",
      handler: async (request, { id }) => {
        ensureIdle(id!);
        // Optional: the profile to write with ("Regenerate with..."). Without
        // one, the channel's profile or roulette picks again.
        const body = (await readJson(request)) as { profileId?: unknown } | null;
        const profileId = typeof body?.profileId === "string" && body.profileId ? body.profileId : undefined;
        if (profileId) store.profiles.get(profileId); // 404 for an unknown profile
        // The whole last reply: one post, or every bubble of a casual reply.
        const replacedIds = store.lastPartnerTurn(id!).map((m) => m.id);
        if (replacedIds.length === 0) {
          throw new HttpError(400, "The last message isn't from your partner, so there's nothing to regenerate.");
        }
        // Generate first, and only delete the old reply once the new one exists.
        // If generation fails you keep the reply you had.
        const partnerMessages = await partner.takeTurn(id!, "regenerate", { replacing: replacedIds, profileId });
        return json({ partnerMessages, replacedIds });
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
      handler: (request, { id }) => {
        // For a roulette, the model notes depend on the profile picked, so
        // the preview shows a given profile (`?profile=<id>`), or the one a
        // roulette would pick first.
        const profileId = new URL(request.url).searchParams.get("profile");
        const profile = profileId ? store.profiles.get(profileId) : pickProfile(store, store.getChannel(id!), 0);
        return json({ messages: promptForChannel(store, id!, [], profile), profile });
      },
    },

    // ---------------------------------------------------------- messages
    {
      method: "PATCH",
      pattern: "/api/messages/:id",
      handler: async (request, { id }) => {
        const body = await readJson(request);
        // A scene break's "content" is its title, which may be empty.
        if (store.getMessage(id!).kind === "scene_break") {
          const title = (body as { content?: unknown } | null)?.content;
          if (typeof title !== "string" || title.length > 200) {
            throw new HttpError(400, '"content" must be text of 200 characters at most.');
          }
          return json({ message: store.editMessage(id!, title.trim()) });
        }
        return json({ message: store.editMessage(id!, requireText(body, "content")) });
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

    // ------------------------------------------- profiles and roulettes
    {
      method: "GET",
      pattern: "/api/profiles",
      handler: () => json({ profiles: store.profiles.list(), roulettes: store.profiles.listRoulettes() }),
    },
    {
      method: "POST",
      pattern: "/api/profiles",
      handler: async (request) => json({ profile: store.profiles.create(await readObject(request)) }),
    },
    {
      method: "PATCH",
      pattern: "/api/profiles/:id",
      handler: async (request, { id }) => json({ profile: store.profiles.update(id!, await readObject(request)) }),
    },
    {
      method: "DELETE",
      pattern: "/api/profiles/:id",
      handler: (_request, { id }) => {
        store.profiles.delete(id!);
        return json({ settings: store.getSettings(), channels: channelViews() });
      },
    },
    {
      method: "POST",
      pattern: "/api/roulettes",
      handler: async (request) => json({ roulette: store.profiles.createRoulette(await readObject(request)) }),
    },
    {
      method: "PATCH",
      pattern: "/api/roulettes/:id",
      handler: async (request, { id }) =>
        json({ roulette: store.profiles.updateRoulette(id!, await readObject(request)) }),
    },
    {
      method: "DELETE",
      pattern: "/api/roulettes/:id",
      handler: (_request, { id }) => {
        store.profiles.deleteRoulette(id!);
        return json({ settings: store.getSettings(), channels: channelViews() });
      },
    },

    // ------------------------------------------------------ notebook & cast
    // Everything here acts as you ("user"): the notebook checks what you're
    // allowed to do (see src/permissions.ts).
    {
      method: "GET",
      pattern: "/api/notebook",
      handler: () =>
        json({
          folders: store.notebook.listFolders("user"),
          entries: store.notebook.listEntries("user"),
          suggestions: store.notebook.listSuggestions("user"),
          templates: ENTRY_TEMPLATES,
        }),
    },
    {
      method: "POST",
      pattern: "/api/notebook/entries",
      handler: async (request) => json({ entry: store.notebook.createEntry("user", await readObject(request)) }),
    },
    {
      method: "PATCH",
      pattern: "/api/notebook/entries/:id",
      // Returns { entry } if saved, or { suggestion } if you can only suggest changes.
      handler: async (request, { id }) => json(store.notebook.editEntry("user", id!, await readObject(request))),
    },
    {
      method: "PUT",
      pattern: "/api/notebook/entries/:id/settings",
      handler: async (request, { id }) =>
        json({ entry: store.notebook.updateEntrySettings("user", id!, await readObject(request)) }),
    },
    {
      method: "DELETE",
      pattern: "/api/notebook/entries/:id",
      // Returns { deleted: true }, or { suggestion } for shared lore.
      handler: (_request, { id }) => json(store.notebook.deleteEntry("user", id!)),
    },
    {
      method: "POST",
      pattern: "/api/notebook/folders",
      handler: async (request) => json({ folder: store.notebook.createFolder("user", await readObject(request)) }),
    },
    {
      method: "PATCH",
      pattern: "/api/notebook/folders/:id",
      handler: async (request, { id }) =>
        json({ folder: store.notebook.updateFolder("user", id!, await readObject(request)) }),
    },
    {
      method: "DELETE",
      pattern: "/api/notebook/folders/:id",
      handler: (_request, { id }) => {
        store.notebook.deleteFolder("user", id!);
        return json({ ok: true });
      },
    },
    {
      method: "POST",
      pattern: "/api/notebook/suggestions/:id/:action",
      handler: (_request, { id, action }) => {
        if (action === "withdraw") {
          store.notebook.withdrawSuggestion("user", id!);
          return json({ ok: true });
        }
        if (action !== "accept" && action !== "reject") throw new HttpError(404, "No such API route.");
        const decision = action === "accept" ? "accepted" : "rejected";
        return json({ suggestion: store.notebook.reviewSuggestion("user", id!, decision) });
      },
    },
    {
      method: "PUT",
      pattern: "/api/channels/:id/cast/:entryId",
      handler: (_request, { id, entryId }) => {
        const channel = store.getChannel(id!);
        store.notebook.pin("user", id!, entryId!);
        return json({ channel: channelView(channel) });
      },
    },
    {
      method: "DELETE",
      pattern: "/api/channels/:id/cast/:entryId",
      handler: (_request, { id, entryId }) => {
        const channel = store.getChannel(id!);
        store.notebook.unpin("user", id!, entryId!);
        return json({ channel: channelView(channel) });
      },
    },

    // ------------------------------------------------------------ themes
    {
      method: "GET",
      pattern: "/api/themes",
      handler: () => json({ themes: themes.list() }),
    },
    {
      method: "POST",
      pattern: "/api/themes",
      handler: async (request) => {
        const body = (await readJson(request)) as { name?: unknown; from?: unknown } | null;
        const from = typeof body?.from === "string" ? body.from : DEFAULT_THEME;
        return json({ theme: themes.create(body?.name as string, from) });
      },
    },
    {
      method: "GET",
      pattern: "/api/themes/:id",
      handler: (_request, { id }) => json({ theme: themes.details(id!) }),
    },
    {
      method: "PATCH",
      pattern: "/api/themes/:id",
      handler: async (request, { id }) => {
        const body = ((await readJson(request)) ?? {}) as Record<string, unknown>;
        return json({ theme: themes.update(id!, body) });
      },
    },
    {
      method: "DELETE",
      pattern: "/api/themes/:id",
      handler: (_request, { id }) => {
        themes.remove(id!);
        // Anything using the theme goes back to the default.
        store.forgetTheme(id!);
        return json({ settings: store.getSettings(), channels: channelViews() });
      },
    },
    {
      method: "POST",
      pattern: "/api/themes/:id/files",
      handler: async (request, { id }) => {
        // Files arrive as base64 text inside JSON, so every request that
        // changes something stays JSON (see checkRequestIsFromTheApp).
        const body = (await readJson(request)) as { name?: unknown; data?: unknown } | null;
        if (typeof body?.name !== "string" || typeof body?.data !== "string") {
          throw new HttpError(400, '"name" and "data" (base64) are required.');
        }
        return json({ files: themes.addFile(id!, body.name, Buffer.from(body.data, "base64")) });
      },
    },
    {
      method: "DELETE",
      pattern: "/api/themes/:id/files/:name",
      handler: (_request, { id, name }) => json({ files: themes.removeFile(id!, name!) }),
    },
  ];

  /**
   * The top-level request handler: API routes, then static files, and turn
   * any thrown error into a JSON error response.
   */
  async function fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Theme files: /themes/<id>/<file>.
    const themeFile = url.pathname.match(/^\/themes\/([^/]+)\/([^/]+)$/);
    if (themeFile && (request.method === "GET" || request.method === "HEAD")) {
      return themes.serve(themeFile[1]!, themeFile[2]!) ?? new Response("Not found", { status: 404 });
    }

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
      if (error instanceof PermissionError) return errorResponse(403, error.message);
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

  return { fetch, store, partner, themes };
}

/**
 * Run a partner turn, but report failure as data instead of throwing.
 * Used after sending a message, where the message itself has already been
 * saved successfully and only the reply failed.
 */
async function tryTurn(
  turn: () => Promise<unknown>,
): Promise<{ partnerMessages?: unknown; error?: string; cancelled?: true }> {
  try {
    return { partnerMessages: await turn() };
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

/**
 * Read the optional `postingAs` field of a message: the name of one of your
 * characters (for casual scenes), or nothing to post as yourself.
 */
function readPostingAs(body: unknown, characters: { name: string }[]): string | null {
  const value = (body as Record<string, unknown> | null)?.postingAs;
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !characters.some((c) => c.name === value)) {
    throw new HttpError(400, `"postingAs" must be one of your characters.`);
  }
  return value;
}

/** Read a JSON body that must be an object. */
async function readObject(request: Request): Promise<Record<string, unknown>> {
  const body = await readJson(request);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "The request body must be a JSON object.");
  }
  return body as Record<string, unknown>;
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
