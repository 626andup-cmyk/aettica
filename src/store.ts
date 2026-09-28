/**
 * The store: reading and writing Aettica's data.
 *
 * Everything lives in an SQLite database (`data/aettica.db`); the table
 * layout is described in `src/db.ts`. The rest of the server only talks to
 * the store through the methods of the `Store` class below, and never writes
 * SQL itself. That keeps every query in one place.
 *
 * All methods are synchronous. Bun's SQLite driver answers immediately
 * (there is no network in between), so there is nothing to wait for.
 */

import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { openDatabase } from "./db.ts";
import { NotFoundError, ValidationError } from "./errors.ts";
import { Notebook } from "./notebook.ts";
import { Profiles } from "./profiles.ts";
import { Comments, Proposals, ToolLog } from "./activity.ts";
import { parseSheet } from "./sheets.ts";
import { Summaries } from "./summaries.ts";
import { importLegacyChat } from "./legacy.ts";
import type {
  Author,
  Channel,
  ChannelKind,
  ChannelMode,
  Message,
  MessageKind,
  Settings,
} from "./types.ts";

// The error types live in their own file (so the notebook can use them
// too); re-exported here, where most code already imports them from.
export { NotFoundError, ValidationError };

/** Where the starting partner prompt and character sheet are kept. */
const DEFAULTS_DIR = resolve(import.meta.dir, "..", "defaults");



// ------------------------------------------------------------- defaults

/**
 * Settings used until you change them. The partner prompts come from
 * `defaults/*.md` so they're easy to read and edit as plain text.
 *
 * Settings are merged over these every time they're read, so a setting added
 * in a newer version of Aettica quietly gets its default.
 */
export function defaultSettings(): Settings {
  return {
    partnerName: "Arlo",
    // Which profile writes each job. "" means the first profile. (Models and
    // their settings live in connection profiles; see src/profiles.ts.)
    rpAssignment: "",
    oocAssignment: "",
    themeOptions: {},
    partnerPrompt: readDefault("partner.md"),
    literaryPrompt: readDefault("literary.md"),
    casualPrompt: readDefault("casual.md"),
    oocPrompt: readDefault("ooc.md"),
    historyLimit: 40,
    summaries: true,
    summaryEvery: 20,
    summaryAssignment: "",
    appTheme: "classic",
  };
}

/** The character sheet a brand-new server's first RP channel starts with. */
export function defaultCharacter(): { name: string; sheet: string } {
  return { name: "Ilse Marrow", sheet: readDefault("character.md") };
}

function readDefault(fileName: string): string {
  const path = join(DEFAULTS_DIR, fileName);
  return existsSync(path) ? readFileSync(path, "utf8").trim() : "";
}

// ------------------------------------------------------------ validation

/**
 * Limits for each field. The validators below use these to reject nonsense
 * (a negative temperature, a 10 MB channel name) before it is saved.
 */
const LIMITS = {
  historyLimit: { min: 1, max: 1000 },
  summaryEvery: { min: 2, max: 500 },
  /** Longest partner prompt, in characters. */
  longText: 100_000,
  /** Longest name (channel, partner), in characters. */
  name: 100,
} as const;

/**
 * Check a partial settings update coming from the browser.
 *
 * Anything arriving over the network is untrusted, even from your own app, so
 * each field is checked for the right type and range. Unknown fields are
 * dropped. Returns the cleaned update, or throws an error describing the first
 * problem found.
 */
export function validateSettings(input: unknown): Partial<Settings> {
  const raw = requireObject(input, "Settings");
  const clean: Partial<Settings> = {};

  if (raw.partnerName !== undefined) clean.partnerName = name(raw.partnerName, "partnerName");
  for (const key of ["partnerPrompt", "literaryPrompt", "casualPrompt", "oocPrompt"] as const) {
    if (raw[key] !== undefined) clean[key] = longText(raw[key], key);
  }

  // Only the form is checked here; the server checks the profile or
  // roulette exists.
  if (raw.rpAssignment !== undefined) clean.rpAssignment = assignment(raw.rpAssignment, "rpAssignment") ?? "";
  if (raw.oocAssignment !== undefined) clean.oocAssignment = assignment(raw.oocAssignment, "oocAssignment") ?? "";
  if (raw.summaryAssignment !== undefined) {
    clean.summaryAssignment = assignment(raw.summaryAssignment, "summaryAssignment") ?? "";
  }
  if (raw.historyLimit !== undefined) {
    clean.historyLimit = numberInRange(raw.historyLimit, "historyLimit", LIMITS.historyLimit, true);
  }
  if (raw.summaryEvery !== undefined) {
    clean.summaryEvery = numberInRange(raw.summaryEvery, "summaryEvery", LIMITS.summaryEvery, true);
  }
  if (raw.summaries !== undefined) {
    if (typeof raw.summaries !== "boolean") throw new ValidationError("summaries must be true or false");
    clean.summaries = raw.summaries;
  }
  // Only the id's form is checked here; the server checks the theme exists.
  if (raw.appTheme !== undefined) clean.appTheme = themeId(raw.appTheme, "appTheme");
  if (raw.themeOptions !== undefined) clean.themeOptions = themeOptions(raw.themeOptions);

  return clean;
}

/**
 * A profile or roulette assignment: `"profile:<id>"` or `"roulette:<id>"`.
 * `null` or `""` means none (returned as `null`).
 */
function assignment(value: unknown, field: string): string | null {
  if (value === null || value === "") return null;
  if (typeof value !== "string" || !/^(profile|roulette):[\w-]{1,100}$/.test(value)) {
    throw new ValidationError(`${field} must be "profile:<id>" or "roulette:<id>"`);
  }
  return value;
}

/**
 * Slider values for themes: `{ "rainy-window": { "bubble-transparency": 0.6 } }`.
 * Only the shape is checked; each theme's own ranges are applied by the app.
 */
function themeOptions(value: unknown): Settings["themeOptions"] {
  const themes = requireObject(value, "themeOptions");
  const entries = Object.entries(themes);
  if (entries.length > 100) throw new ValidationError("themeOptions has too many themes");
  return Object.fromEntries(
    entries.map(([id, options]) => {
      themeId(id, "themeOptions");
      const values = Object.entries(requireObject(options, "themeOptions"));
      if (values.length > 20) throw new ValidationError("themeOptions has too many options for one theme");
      for (const [key, number] of values) {
        if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(key) || typeof number !== "number" || !Number.isFinite(number)) {
          throw new ValidationError("themeOptions values must be numbers, by option id");
        }
      }
      return [id, Object.fromEntries(values) as Record<string, number>];
    }),
  );
}

/** A theme id: lowercase letters, digits and dashes. */
function themeId(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value)) {
    throw new ValidationError(`${field} must be a theme id`);
  }
  return value;
}

/** Check a channel mode. */
function mode(value: unknown): ChannelMode {
  if (value !== "literary" && value !== "casual") throw new ValidationError('mode must be "literary" or "casual"');
  return value;
}

/** The fields you give when creating a channel. */
export interface NewChannel {
  name: string;
  kind: ChannelKind;
  /** RP channels: the first scene's mode. Defaults to literary. */
  mode?: ChannelMode;
}

/** Check the body of a "create channel" request. */
export function validateNewChannel(input: unknown): NewChannel {
  const raw = requireObject(input, "Channel");
  if (raw.kind !== "rp" && raw.kind !== "ooc") {
    throw new ValidationError('kind must be "rp" or "ooc"');
  }
  return {
    name: name(raw.name, "name"),
    kind: raw.kind,
    ...(raw.mode !== undefined ? { mode: mode(raw.mode) } : {}),
  };
}

/**
 * The channel fields that can be changed after creation. `mode` is the mode
 * you *ask* for; see `Store.updateChannel` for when it takes effect.
 */
export type ChannelUpdate = Partial<Pick<Channel, "name" | "mode" | "theme" | "assignment">>;

/** Check a partial channel update. The kind can't be changed, so it's ignored. */
export function validateChannelUpdate(input: unknown): ChannelUpdate {
  const raw = requireObject(input, "Channel");
  const clean: ChannelUpdate = {};
  if (raw.name !== undefined) clean.name = name(raw.name, "name");
  if (raw.mode !== undefined) clean.mode = mode(raw.mode);
  // `null` (or "") means "use the app theme".
  if (raw.theme !== undefined) clean.theme = raw.theme === null || raw.theme === "" ? null : themeId(raw.theme, "theme");
  // `null` (or "") means "use the server-wide profile for this kind of channel".
  if (raw.assignment !== undefined) clean.assignment = assignment(raw.assignment, "assignment");
  return clean;
}

function requireObject(input: unknown, what: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ValidationError(`${what} must be a JSON object`);
  }
  return input as Record<string, unknown>;
}

/** A required, non-empty, reasonably short piece of text, trimmed. */
function name(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new ValidationError(`${field} must be non-empty text`);
  if (value.trim().length > LIMITS.name) throw new ValidationError(`${field} is too long`);
  return value.trim();
}

function longText(value: unknown, field: string): string {
  if (typeof value !== "string") throw new ValidationError(`${field} must be text`);
  if (value.length > LIMITS.longText) throw new ValidationError(`${field} is too long`);
  return value;
}

function numberInRange(
  value: unknown,
  field: string,
  range: { min: number; max: number },
  wholeNumber: boolean,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ValidationError(`${field} must be a number`);
  }
  if (wholeNumber && !Number.isInteger(value)) {
    throw new ValidationError(`${field} must be a whole number`);
  }
  if (value < range.min || value > range.max) {
    throw new ValidationError(`${field} must be between ${range.min} and ${range.max}`);
  }
  return value;
}

// ----------------------------------------------------------- row mapping

/*
 * The database uses snake_case column names (`channel_id`), while the rest
 * of the code uses camelCase (`channelId`). These types describe rows exactly
 * as SQLite returns them, and the functions below convert them.
 */

interface ChannelRow {
  id: string;
  name: string;
  kind: ChannelKind;
  mode: ChannelMode;
  pending_mode: ChannelMode | null;
  theme: string | null;
  assignment: string | null;
  position: number;
  created_at: string;
}

interface MessageRow {
  id: string;
  channel_id: string;
  kind: MessageKind;
  mode: ChannelMode | null;
  turn_id: string | null;
  author: Author;
  content: string;
  created_at: string;
  edited_at: string | null;
  model: string | null;
  profile: string | null;
  /** A JSON array of character names, built by the query itself. */
  characters: string;
  /** A JSON array of attached notebook entry ids, built by the query itself. */
  attachments: string;
}

function toChannel(row: ChannelRow): Channel {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    mode: row.mode,
    pendingMode: row.pending_mode,
    theme: row.theme,
    assignment: row.assignment,
    position: row.position,
    createdAt: row.created_at,
  };
}

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    channelId: row.channel_id,
    kind: row.kind,
    author: row.author,
    content: row.content,
    mode: row.mode,
    turnId: row.turn_id,
    characters: JSON.parse(row.characters) as string[],
    attachments: JSON.parse(row.attachments) as string[],
    createdAt: row.created_at,
    // Only include optional fields when they have a value.
    ...(row.edited_at ? { editedAt: row.edited_at } : {}),
    ...(row.model ? { model: row.model } : {}),
    ...(row.profile ? { profile: row.profile } : {}),
  };
}

/**
 * The start of every query that reads messages. For each message, the inner
 * `SELECT` gathers the characters it voices from `message_characters`, in
 * order, into one JSON array (`json_group_array`), so one query returns
 * everything about a message.
 */
const SELECT_MESSAGES = `
  SELECT m.id, m.channel_id, m.kind, m.mode, m.turn_id, m.author, m.content, m.created_at, m.edited_at, m.model, m.profile,
    (SELECT json_group_array(character_name)
       FROM (SELECT character_name FROM message_characters
              WHERE message_id = m.id ORDER BY position)) AS characters,
    (SELECT json_group_array(entry_id) FROM message_attachments WHERE message_id = m.id) AS attachments
  FROM messages m`;

// ----------------------------------------------------------------- store

/** The fields you give when adding a message. */
export interface NewMessage {
  channelId: string;
  author: Author;
  content: string;
  characters?: string[];
  model?: string;
  /** The name of the profile that wrote it (partner messages). */
  profile?: string;
  /** Defaults to "post". Use `addSceneBreak` for scene breaks. */
  kind?: MessageKind;
  /** RP channels: the mode it was written in. Defaults to `null`. */
  mode?: ChannelMode | null;
  /** Shared by messages written together. Defaults to `null`. */
  turnId?: string | null;
}

export class Store {
  readonly db: Database;
  /** Characters, lore and each channel's cast (see `src/notebook.ts`). */
  readonly notebook: Notebook;
  /** Connection profiles and roulettes (see `src/profiles.ts`). */
  readonly profiles: Profiles;
  /** Every tool call your partner makes (see `src/activity.ts`). */
  readonly toolLog: ToolLog;
  /** Comment threads on messages. */
  readonly comments: Comments;
  /** Things your partner asked you to approve. */
  readonly proposals: Proposals;
  /** Scene summaries, the story so far and the digest (see `src/summaries.ts`). */
  readonly summaries: Summaries;
  /**
   * Called after a channel's messages change (added, edited, deleted), so
   * summaries can catch up (see src/summarizer.ts).
   */
  onMessagesChanged: ((channelId: string) => void) | null = null;

  /**
   * Open (or create) the database inside `dataDir`.
   *
   * The very first time, the database is filled with starting content: your
   * stage 1 chat if there is one (see `src/legacy.ts`), otherwise a `#story`
   * channel with the example character pinned to it, and an `#ooc` channel.
   *
   * @param dataDir  Folder for the database. Created if it doesn't exist.
   *                 Pass `":memory:"` for a throwaway database (for tests).
   */
  constructor(dataDir: string) {
    const inMemory = dataDir === ":memory:";
    if (!inMemory) mkdirSync(dataDir, { recursive: true });
    const path = inMemory ? ":memory:" : join(dataDir, "aettica.db");

    const isNew = inMemory || !existsSync(path);
    this.db = openDatabase(path);
    this.notebook = new Notebook(this.db);
    this.profiles = new Profiles(this.db);
    this.toolLog = new ToolLog(this.db);
    this.comments = new Comments(this.db);
    this.proposals = new Proposals(this.db);
    this.summaries = new Summaries(this.db);

    if (isNew) {
      const imported = !inMemory && importLegacyChat(this, dataDir);
      if (!imported) this.seed();
    }
  }

  /** Starting content for a brand-new server. */
  private seed(): void {
    const story = this.createChannel({ name: "story", kind: "rp" });
    this.createChannel({ name: "ooc", kind: "ooc" });
    const character = defaultCharacter();
    this.addCharacterFromSheet(character.name, character.sheet, story.id);
  }

  /**
   * Make a character entry of your partner's from a plain-text sheet, and
   * pin it to a channel. Used for the example character and for importing
   * a stage 1 chat.
   */
  addCharacterFromSheet(name: string, sheet: string, channelId: string): void {
    const parsed = parseSheet(sheet);
    const entry = this.notebook.createEntry("user", {
      kind: "character",
      owner: "partner",
      name: name || parsed.name || "Unnamed character",
      fields: parsed.fields,
    });
    this.notebook.pin("user", channelId, entry.id);
  }

  /** Close the database. Only needed in tests, which open many. */
  close(): void {
    this.db.close();
  }

  // -------------------------------------------------------------- settings

  /** The current settings, with defaults for anything never changed. */
  getSettings(): Settings {
    const rows = this.db.query("SELECT key, value FROM settings").all() as { key: string; value: string }[];
    const saved = Object.fromEntries(rows.map((row) => [row.key, JSON.parse(row.value)]));
    return { ...defaultSettings(), ...saved };
  }

  /** Save an already-validated settings update. Returns the new settings. */
  updateSettings(update: Partial<Settings>): Settings {
    // "Upsert": insert the key, or if it already exists, update its value.
    const upsert = this.db.query(
      "INSERT INTO settings (key, value) VALUES ($key, $value) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    );
    this.db.transaction(() => {
      for (const [key, value] of Object.entries(update)) {
        if (value !== undefined) upsert.run({ key, value: JSON.stringify(value) });
      }
    })();
    return this.getSettings();
  }

  // -------------------------------------------------------------- channels

  /** Every channel, in sidebar order. */
  listChannels(): Channel[] {
    const rows = this.db.query("SELECT * FROM channels ORDER BY position").all() as ChannelRow[];
    return rows.map(toChannel);
  }

  /** One channel. Throws `NotFoundError` if there's no such channel. */
  getChannel(id: string): Channel {
    const row = this.db.query("SELECT * FROM channels WHERE id = $id").get({ id }) as ChannelRow | null;
    if (!row) throw new NotFoundError("channel");
    return toChannel(row);
  }

  /** Create a channel at the bottom of the sidebar. */
  createChannel(input: NewChannel): Channel {
    const { next } = this.db.query("SELECT COALESCE(MAX(position) + 1, 0) AS next FROM channels").get() as {
      next: number;
    };
    const id = crypto.randomUUID();
    this.db
      .query(
        `INSERT INTO channels (id, name, kind, mode, position, created_at)
         VALUES ($id, $name, $kind, $mode, $position, $createdAt)`,
      )
      .run({
        id,
        name: input.name,
        kind: input.kind,
        mode: input.mode ?? "literary",
        position: next,
        createdAt: new Date().toISOString(),
      });
    return this.getChannel(id);
  }

  /**
   * Change a channel's name, mode or theme. Returns the updated channel.
   * (Its cast is changed by pinning entries; see `src/notebook.ts`.)
   *
   * A mode change follows the design's rule that a scene never mixes
   * styles:
   *
   *   - If the current scene has no messages yet (a new channel, or just
   *     after a scene break), the new mode applies right away.
   *   - Otherwise it's saved as `pendingMode` and applies at the next scene
   *     break (`addSceneBreak`). Asking for the current mode again cancels
   *     a pending change.
   */
  updateChannel(id: string, update: ChannelUpdate): Channel {
    const channel = this.getChannel(id); // throws if missing
    const { mode: requestedMode, ...rest } = update;
    const merged = { ...channel, ...rest };
    if (requestedMode !== undefined && channel.kind === "rp") {
      if (this.currentSceneIsEmpty(id)) {
        merged.mode = requestedMode;
        merged.pendingMode = null;
      } else {
        merged.pendingMode = requestedMode === channel.mode ? null : requestedMode;
      }
    }
    this.db
      .query(
        `UPDATE channels SET name = $name, mode = $mode, pending_mode = $pendingMode, theme = $theme,
                assignment = $assignment
         WHERE id = $id`,
      )
      .run({
        id,
        name: merged.name,
        mode: merged.mode,
        pendingMode: merged.pendingMode,
        theme: merged.theme,
        assignment: merged.assignment,
      });
    return this.getChannel(id);
  }

  /**
   * Stop using a theme that's been deleted: the app theme goes back to
   * Classic, and channels using it go back to the app theme.
   */
  forgetTheme(themeId: string): void {
    this.db.transaction(() => {
      const settings = this.getSettings();
      if (settings.appTheme === themeId) this.updateSettings({ appTheme: "classic" });
      if (settings.themeOptions[themeId]) {
        const { [themeId]: _gone, ...rest } = settings.themeOptions;
        this.updateSettings({ themeOptions: rest });
      }
      this.db.query("UPDATE channels SET theme = NULL WHERE theme = $themeId").run({ themeId });
    })();
  }

  /**
   * Whether the channel's current scene has no messages yet: nothing after
   * its latest scene break, or nothing at all if it has none.
   */
  currentSceneIsEmpty(channelId: string): boolean {
    const { count } = this.db
      .query(
        `SELECT COUNT(*) AS count FROM messages
          WHERE channel_id = $channelId AND kind = 'post'
            AND seq > COALESCE(
              (SELECT MAX(seq) FROM messages WHERE channel_id = $channelId AND kind = 'scene_break'), 0)`,
      )
      .get({ channelId }) as { count: number };
    return count === 0;
  }

  /**
   * Put the channels in a new order.
   *
   * @param ids  Every channel id, in the new order. Leaving one out or adding
   *             an unknown one is an error, so the order can never end up
   *             with gaps or duplicates.
   */
  reorderChannels(ids: string[]): Channel[] {
    const existing = new Set(this.listChannels().map((c) => c.id));
    const given = new Set(ids);
    if (given.size !== ids.length || given.size !== existing.size || ids.some((id) => !existing.has(id))) {
      throw new ValidationError("The new order must list every channel exactly once.");
    }
    const setPosition = this.db.query("UPDATE channels SET position = $position WHERE id = $id");
    this.db.transaction(() => {
      ids.forEach((id, position) => setPosition.run({ id, position }));
    })();
    return this.listChannels();
  }

  /**
   * Delete a channel and, through `ON DELETE CASCADE`, all its messages.
   * Throws `NotFoundError` if there's no such channel.
   */
  deleteChannel(id: string): void {
    const result = this.db.query("DELETE FROM channels WHERE id = $id").run({ id });
    if (result.changes === 0) throw new NotFoundError("channel");
  }

  // -------------------------------------------------------------- messages

  /** Every message in a channel, oldest first. */
  getMessages(channelId: string): Message[] {
    this.getChannel(channelId); // throws NotFoundError for an unknown channel
    const rows = this.db.query(`${SELECT_MESSAGES} WHERE m.channel_id = $channelId ORDER BY m.seq`).all({
      channelId,
    }) as MessageRow[];
    return rows.map(toMessage);
  }

  /** One message. Throws `NotFoundError` if there's no such message. */
  getMessage(id: string): Message {
    const row = this.db.query(`${SELECT_MESSAGES} WHERE m.id = $id`).get({ id }) as MessageRow | null;
    if (!row) throw new NotFoundError("message");
    return toMessage(row);
  }

  /** The newest message in a channel, or `undefined` if it's empty. */
  lastMessage(channelId: string): Message | undefined {
    const row = this.db
      .query(`${SELECT_MESSAGES} WHERE m.channel_id = $channelId ORDER BY m.seq DESC LIMIT 1`)
      .get({ channelId }) as MessageRow | null;
    return row ? toMessage(row) : undefined;
  }

  /**
   * Add a message to the end of a channel.
   *
   * @param createdAt  Only for importing old messages; new ones get "now".
   */
  addMessage(input: NewMessage & { id?: string; createdAt?: string; editedAt?: string }): Message {
    const id = input.id ?? crypto.randomUUID();
    const insertMessage = this.db.query(
      `INSERT INTO messages (id, channel_id, kind, mode, turn_id, author, content, created_at, edited_at, model, profile)
       VALUES ($id, $channelId, $kind, $mode, $turnId, $author, $content, $createdAt, $editedAt, $model, $profile)`,
    );
    const insertCharacter = this.db.query(
      "INSERT OR IGNORE INTO message_characters (message_id, character_name, position) VALUES ($id, $name, $position)",
    );

    // The message and its characters are saved together or not at all.
    this.db.transaction(() => {
      insertMessage.run({
        id,
        channelId: input.channelId,
        kind: input.kind ?? "post",
        mode: input.mode ?? null,
        turnId: input.turnId ?? null,
        author: input.author,
        content: input.content,
        createdAt: input.createdAt ?? new Date().toISOString(),
        editedAt: input.editedAt ?? null,
        model: input.model ?? null,
        profile: input.profile ?? null,
      });
      (input.characters ?? []).forEach((name, position) => insertCharacter.run({ id, name, position }));
    })();

    this.onMessagesChanged?.(input.channelId);
    return this.getMessage(id);
  }

  /**
   * Add several messages at once, all or nothing, sharing a new turn id.
   * Used for a casual reply's bubbles, or several lines you sent together.
   */
  addTurn(messages: Omit<NewMessage, "turnId">[], turnId: string = crypto.randomUUID()): Message[] {
    return this.db.transaction(() => messages.map((m) => this.addMessage({ ...m, turnId })))();
  }

  /**
   * Put a scene break at the end of a channel.
   *
   * If a mode change is waiting (`pendingMode`), this is where it takes
   * effect: the new scene starts in the new mode. Both happen in one
   * transaction.
   *
   * @returns The scene break, and the channel as it is afterwards.
   */
  addSceneBreak(channelId: string, author: Author, title: string): { sceneBreak: Message; channel: Channel } {
    const channel = this.getChannel(channelId); // throws if missing
    if (channel.kind !== "rp") throw new ValidationError("Scene breaks are only for roleplay channels.");

    return this.db.transaction(() => {
      const sceneBreak = this.addMessage({ channelId, author, content: title.trim(), kind: "scene_break" });
      if (channel.pendingMode) {
        this.db
          .query("UPDATE channels SET mode = pending_mode, pending_mode = NULL WHERE id = $channelId")
          .run({ channelId });
      }
      return { sceneBreak, channel: this.getChannel(channelId) };
    })();
  }

  /**
   * The partner's most recent turn in a channel: every message of it (one
   * for a literary post, several bubbles for a casual reply), oldest first.
   * Empty if the channel doesn't end on a partner post.
   */
  lastPartnerTurn(channelId: string): Message[] {
    const last = this.lastMessage(channelId);
    if (!last || last.kind !== "post" || last.author !== "partner") return [];
    if (!last.turnId) return [last];
    const rows = this.db
      .query(`${SELECT_MESSAGES} WHERE m.channel_id = $channelId AND m.turn_id = $turnId ORDER BY m.seq`)
      .all({ channelId, turnId: last.turnId }) as MessageRow[];
    return rows.map(toMessage);
  }

  /** Replace a message's text. Throws `NotFoundError` if it doesn't exist. */
  editMessage(id: string, content: string): Message {
    this.summaries.messageChanging(this.getMessage(id), false);
    const result = this.db
      .query("UPDATE messages SET content = $content, edited_at = $editedAt WHERE id = $id")
      .run({ id, content, editedAt: new Date().toISOString() });
    if (result.changes === 0) throw new NotFoundError("message");
    const message = this.getMessage(id);
    this.onMessagesChanged?.(message.channelId);
    return message;
  }

  /** Delete one message. Throws `NotFoundError` if it doesn't exist. */
  deleteMessage(id: string): void {
    const message = this.getMessage(id); // throws NotFoundError
    this.summaries.messageChanging(message, true);
    this.db.query("DELETE FROM messages WHERE id = $id").run({ id });
    this.onMessagesChanged?.(message.channelId);
  }

  /**
   * Attach notebook entries to a message, so they're sent to your partner
   * with it. Entries already attached are skipped.
   */
  attach(messageId: string, entryIds: string[]): Message {
    const insert = this.db.query(
      "INSERT OR IGNORE INTO message_attachments (message_id, entry_id) VALUES ($messageId, $entryId)",
    );
    this.db.transaction(() => {
      for (const entryId of entryIds) insert.run({ messageId, entryId });
    })();
    return this.getMessage(messageId);
  }

  /**
   * Approve or deny one of your partner's proposals. Approving carries it
   * out: for a channel deletion, the channel is deleted (if it still exists).
   */
  resolveProposal(id: string, approve: boolean): void {
    this.db.transaction(() => {
      const proposal = this.proposals.resolve(id, approve ? "approved" : "denied");
      if (approve && proposal.kind === "delete_channel") {
        this.db.query("DELETE FROM channels WHERE id = $id").run({ id: proposal.targetId });
      }
    })();
  }

  /** Delete every message in a channel, keeping the channel itself. */
  clearMessages(channelId: string): void {
    this.getChannel(channelId); // throws NotFoundError for an unknown channel
    this.db.query("DELETE FROM messages WHERE channel_id = $channelId").run({ channelId });
    this.summaries.clear(channelId);
  }
}
