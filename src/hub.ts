/**
 * The hub: several partners, each with their own memory, grouped into
 * servers.
 *
 * A **partner** is a whole Aettica of their own: their own database and
 * folder, so their own notebook (and secrets), settings and prompts,
 * channels and messages, summaries, idea drawer, heartbeat, reference
 * library, custom emojis and logs. Nothing one partner knows can reach
 * another, because nothing is shared: each is a separate app (`createApp`
 * in src/server.ts), exactly as Aettica was with one partner.
 *
 * A **server** is a group of partners in the rail on the left. Usually a
 * server has one partner (their own place, like a Discord server of your
 * own), but it can have several: its sidebar then shows each partner's
 * channels under their name. Each channel belongs to one partner.
 *
 * The hub keeps the list in `<dataDir>/hub.json`, runs one app per partner,
 * and sends each request to the right one:
 *
 *   /p/<partnerId>/api/...   that partner's API (and /p/<id>/emojis/...)
 *   /api/hub/...             the servers and partners themselves (below)
 *   anything else            the first partner's app (the web app's files,
 *                            themes, and the API for older pages)
 *
 * The very first partner lives in the data folder itself (where Aettica
 * always kept its database), so upgrading changes nothing. New partners
 * live in `<dataDir>/partners/<id>/`. Your own themes are shared by
 * everyone (`<dataDir>/themes`). A new partner starts with a copy of your
 * connection profiles, roulettes and preferences (models, Jev, reaching
 * out, texting, the look), but not the old partner's identity, prompts or
 * anything they remember.
 *
 * Deleting a partner moves their files to `<dataDir>/trash/`, not away for
 * good, in case you change your mind.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Config } from "./config.ts";
import { keepAwake } from "./notify.ts";
import { createApp, type App } from "./server.ts";
import { validateSettings } from "./store.ts";
import type { Settings } from "./types.ts";

export interface HubServer {
  id: string;
  /** Its name; "" shows its first partner's name. */
  name: string;
  /** Its partners' ids, in sidebar order. */
  partners: string[];
}

export interface HubPartner {
  id: string;
  /** Their folder, relative to the data folder ("." for the first partner). */
  dir: string;
}

interface Registry {
  servers: HubServer[];
  partners: HubPartner[];
}

/** Settings that are the partner themselves: never copied to a new partner. */
export const PARTNER_KEYS: (keyof Settings)[] = [
  "partnerName",
  "partnerPrompt",
  "literaryPrompt",
  "casualPrompt",
  "oocPrompt",
  "partnerAvatar",
  "partnerColor",
];

/** A partner as the rail and sidebar show them, with their channels. */
export interface PartnerSummary {
  id: string;
  name: string;
  avatar: string;
  color: number;
  channels: { id: string; name: string; kind: string; categoryId: string | null; position: number }[];
  categories: { id: string; name: string; position: number; collapsed: boolean }[];
  /** Each channel's newest message, for unread dots. */
  activity: Record<string, { lastId: string; author: string; at: string } | null>;
  busy: string[];
}

export interface Hub {
  fetch: (request: Request) => Promise<Response>;
  /** Each partner's app, by id. */
  apps: Map<string, App>;
  servers: () => HubServer[];
  /** Start every partner's timers (summaries, heartbeat): `main()` does this. */
  start: () => void;
  /** Stop timers and close every database (tests). */
  close: () => void;
}

class HubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const json = (data: unknown, status = 200) => Response.json(data, { status });

export function createHub(config: Config, makeApp: (config: Config) => App = createApp): Hub {
  const root = config.dataDir;
  mkdirSync(root, { recursive: true });
  const registryPath = join(root, "hub.json");
  const apps = new Map<string, App>();
  let started = false;

  // ------------------------------------------------------------ the list

  function load(): Registry {
    if (existsSync(registryPath)) return JSON.parse(readFileSync(registryPath, "utf8")) as Registry;
    return { partners: [{ id: "home", dir: "." }], servers: [{ id: crypto.randomUUID(), name: "", partners: ["home"] }] };
  }
  const registry = load();

  function save(): void {
    // Written whole, then renamed over the old one: never half-written.
    const temp = `${registryPath}.tmp`;
    writeFileSync(temp, JSON.stringify(registry, null, 2));
    renameSync(temp, registryPath);
  }
  if (!existsSync(registryPath)) save();

  function open(partner: HubPartner): App {
    const app = makeApp({
      ...config,
      dataDir: resolve(root, partner.dir),
      userThemesDir: join(root, "themes"),
      partnerId: partner.id,
      example: partner.id === "home",
    });
    apps.set(partner.id, app);
    if (started) startApp(app);
    return app;
  }
  for (const partner of registry.partners) open(partner);

  function startApp(app: App): void {
    app.summarizer.scheduleAll(15_000);
    app.heartbeat.start();
    if (app.store.getSettings().heartbeatHours > 0) keepAwake();
  }

  function stopApp(app: App): void {
    app.heartbeat.stop();
    app.summarizer.stop();
    app.keeper.stop();
    app.store.close();
  }

  const defaultApp = () => apps.get(registry.servers[0]!.partners[0]!)!;
  const server = (id: string) => {
    const found = registry.servers.find((s) => s.id === id);
    if (!found) throw new HubError(404, "There's no such server.");
    return found;
  };
  const partnerApp = (id: string) => {
    const app = apps.get(id);
    if (!app) throw new HubError(404, "There's no such partner.");
    return app;
  };

  // --------------------------------------------------------- summaries

  function summary(id: string): PartnerSummary {
    const { store, partner } = partnerApp(id);
    const settings = store.getSettings();
    const channels = store.listChannels();
    return {
      id,
      name: settings.partnerName,
      avatar: settings.partnerAvatar,
      color: settings.partnerColor,
      channels: channels.map((c) => ({ id: c.id, name: c.name, kind: c.kind, categoryId: c.categoryId, position: c.position })),
      categories: store.listCategories().map((c) => ({ id: c.id, name: c.name, position: c.position, collapsed: c.collapsed })),
      activity: Object.fromEntries(
        channels.map((c) => {
          const last = store.lastMessage(c.id);
          return [c.id, last ? { lastId: last.id, author: last.author, at: last.createdAt } : null];
        }),
      ),
      busy: partner.busyChannels(),
    };
  }

  function view() {
    return { servers: registry.servers.map((s) => ({ ...s, partners: s.partners.map(summary) })) };
  }

  // ------------------------------------------------------- new partners

  /** Make a partner, copying profiles and preferences from another. */
  function makePartner(input: Record<string, unknown>): string {
    const source = partnerApp(typeof input.copyFrom === "string" ? input.copyFrom : registry.servers[0]!.partners[0]!);
    const identity = validateSettings({
      partnerName: input.name ?? "New partner",
      ...(input.prompt !== undefined ? { partnerPrompt: input.prompt } : {}),
      ...(input.avatar !== undefined ? { partnerAvatar: input.avatar } : {}),
      ...(input.color !== undefined ? { partnerColor: input.color } : {}),
    });
    const id = `p-${crypto.randomUUID().slice(0, 8)}`;
    const partner: HubPartner = { id, dir: join("partners", id) };
    const app = open(partner);
    copyProfiles(source, app);
    const preferences = Object.fromEntries(
      Object.entries(source.store.getSettings()).filter(([key]) => !PARTNER_KEYS.includes(key as keyof Settings)),
    );
    app.store.updateSettings({ ...(preferences as Partial<Settings>), ...identity });
    registry.partners.push(partner);
    return id;
  }

  // ------------------------------------------------------------- routes

  async function body(request: Request): Promise<Record<string, unknown>> {
    if (!(request.headers.get("content-type") ?? "").includes("application/json")) {
      throw new HubError(415, "API requests that change data must be sent as JSON.");
    }
    try {
      const value = await request.json();
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
      return value as Record<string, unknown>;
    } catch {
      throw new HubError(400, "The request body must be a JSON object.");
    }
  }

  function removePartnerFiles(partner: HubPartner): void {
    const trash = join(root, "trash", `${partner.id}-${Date.now()}`);
    mkdirSync(trash, { recursive: true });
    if (partner.dir === ".") {
      // The first partner lives in the data folder itself: move just their files.
      for (const name of ["aettica.db", "aettica.db-wal", "aettica.db-shm", "emojis", "chat.json"]) {
        if (existsSync(join(root, name))) renameSync(join(root, name), join(trash, name));
      }
    } else {
      renameSync(resolve(root, partner.dir), join(trash, "files"));
    }
  }

  /** Remove a partner from everywhere; their files go to the trash. */
  function deletePartner(id: string): void {
    if (registry.partners.length === 1) throw new HubError(400, "You need at least one partner, so the last one can't be deleted.");
    const app = partnerApp(id);
    const partner = registry.partners.find((p) => p.id === id)!;
    stopApp(app);
    apps.delete(id);
    removePartnerFiles(partner);
    registry.partners = registry.partners.filter((p) => p.id !== id);
    for (const s of registry.servers) s.partners = s.partners.filter((p) => p !== id);
    registry.servers = registry.servers.filter((s) => s.partners.length > 0);
  }

  async function hubRoute(request: Request, path: string): Promise<Response> {
    const method = request.method;
    const parts = path.split("/").slice(3); // after /api/hub
    if (method === "GET" && parts.length === 0) return json(view());

    if (parts[0] === "servers") {
      if (method === "POST" && parts.length === 1) {
        // A new server, with a new partner of its own.
        const input = await body(request);
        const partnerId = makePartner(input);
        const created: HubServer = { id: crypto.randomUUID(), name: typeof input.serverName === "string" ? input.serverName.trim().slice(0, 100) : "", partners: [partnerId] };
        registry.servers.push(created);
        save();
        return json({ server: created, partnerId, ...view() });
      }
      if (method === "PUT" && parts[1] === "order") {
        const ids = (await body(request)).ids;
        if (!Array.isArray(ids) || ids.length !== registry.servers.length || !registry.servers.every((s) => ids.includes(s.id))) {
          throw new HubError(400, "The new order must list every server exactly once.");
        }
        registry.servers.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
        save();
        return json(view());
      }
      const target = server(parts[1] ?? "");
      if (method === "PATCH" && parts.length === 2) {
        const input = await body(request);
        if (input.name !== undefined) {
          if (typeof input.name !== "string" || input.name.length > 100) throw new HubError(400, "A server's name is text, 100 characters at most.");
          target.name = input.name.trim();
        }
        if (input.partners !== undefined) {
          // Reorder its partners.
          const ids = input.partners;
          if (!Array.isArray(ids) || ids.length !== target.partners.length || !target.partners.every((p) => ids.includes(p))) {
            throw new HubError(400, "partners must list the server's partners, in the new order.");
          }
          target.partners = ids as string[];
        }
        save();
        return json(view());
      }
      if (method === "POST" && parts[2] === "partners" && parts.length === 3) {
        // Another partner in this server.
        const partnerId = makePartner(await body(request));
        target.partners.push(partnerId);
        save();
        return json({ partnerId, ...view() });
      }
      if (method === "DELETE" && parts.length === 2) {
        if (registry.servers.length === 1) throw new HubError(400, "You need at least one server, so the last one can't be deleted.");
        if (registry.partners.length === target.partners.length) throw new HubError(400, "That would delete every partner.");
        for (const id of [...target.partners]) deletePartner(id);
        registry.servers = registry.servers.filter((s) => s.id !== target.id);
        save();
        return json(view());
      }
    }

    if (parts[0] === "partners" && parts[1]) {
      const id = parts[1];
      partnerApp(id);
      if (method === "DELETE" && parts.length === 2) {
        deletePartner(id);
        save();
        return json(view());
      }
      if (method === "POST" && parts[2] === "move") {
        // Move a partner to another server, or into a server of their own.
        const to = (await body(request)).serverId;
        for (const s of registry.servers) s.partners = s.partners.filter((p) => p !== id);
        if (typeof to === "string") server(to).partners.push(id);
        else registry.servers.push({ id: crypto.randomUUID(), name: "", partners: [id] });
        registry.servers = registry.servers.filter((s) => s.partners.length > 0);
        save();
        return json(view());
      }
    }
    throw new HubError(404, "No such API route.");
  }

  async function fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/hub" || url.pathname.startsWith("/api/hub/")) return await hubRoute(request, url.pathname);
      // /p/<id>/...: that partner's app, with the rest of the path.
      const scoped = url.pathname.match(/^\/p\/([^/]+)(\/.*)$/);
      if (scoped) {
        const app = partnerApp(decodeURIComponent(scoped[1]!));
        url.pathname = scoped[2]!;
        return await app.fetch(new Request(url.toString(), request));
      }
      return await defaultApp().fetch(request);
    } catch (error) {
      if (error instanceof HubError) return json({ error: error.message }, error.status);
      const message = error instanceof Error ? error.message : String(error);
      if (/must be|is too long|non-empty/.test(message)) return json({ error: message }, 400);
      console.error("[hub]", error);
      return json({ error: "Something went wrong on the server." }, 500);
    }
  }

  return {
    fetch,
    apps,
    servers: () => registry.servers,
    start: () => {
      started = true;
      for (const app of apps.values()) startApp(app);
    },
    close: () => {
      for (const app of apps.values()) stopApp(app);
    },
  };
}

/**
 * Give a new partner the same connection profiles and roulettes as another
 * (same ids, so assignments carry over), replacing the default one.
 */
function copyProfiles(from: App, to: App): void {
  const source = from.store.db;
  const target = to.store.db;
  const rows = (table: string) => source.query(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
  const copy = (table: string, list: Record<string, unknown>[]) => {
    for (const row of list) {
      const columns = Object.keys(row);
      target
        .query(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map((c) => `$${c}`).join(", ")})`)
        .run(Object.fromEntries(columns.map((c) => [c, row[c] as string | number | null])));
    }
  };
  const profiles = rows("profiles");
  const roulettes = rows("roulettes");
  const entries = rows("roulette_profiles");
  target.transaction(() => {
    target.query("DELETE FROM roulette_profiles").run();
    target.query("DELETE FROM roulettes").run();
    target.query("DELETE FROM profiles").run();
    copy("profiles", profiles);
    copy("roulettes", roulettes);
    copy("roulette_profiles", entries);
  })();
}
