/**
 * The store: where the chat and its settings live, and how they are saved.
 *
 * Stage 1 keeps everything in one JSON file (`data/chat.json`). The whole file
 * is loaded into memory when the server starts, and rewritten after every
 * change. For one chat of a few thousand messages that is perfectly fast, and
 * it means you can open the file and read exactly what is stored.
 *
 * Stage 2 (multiple channels) is where a real database arrives. To make that
 * swap painless, the rest of the server only talks to the store through the
 * methods of the `Store` class below and never touches the file itself.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Author, Message, SaveData, Settings } from "./types.ts";

/** Where the starting partner prompt and character sheet are kept. */
const DEFAULTS_DIR = resolve(import.meta.dir, "..", "defaults");

/**
 * Settings used the first time the server runs, before you change anything.
 * The partner prompt and character sheet come from `defaults/*.md` so they are
 * easy to read and edit as plain text.
 */
export function defaultSettings(): Settings {
  return {
    partnerPrompt: readDefault("partner.md"),
    characterSheet: readDefault("character.md"),
    // Check https://nano-gpt.com/api/v1/models (or the model list in the
    // settings panel) for the exact ids available to your account.
    model: "deepseek-ai/DeepSeek-V3.1-Terminus",
    temperature: 0.9,
    maxTokens: 1024,
    historyLimit: 40,
  };
}

function readDefault(fileName: string): string {
  const path = join(DEFAULTS_DIR, fileName);
  return existsSync(path) ? readFileSync(path, "utf8").trim() : "";
}

/**
 * Limits for each setting. `validateSettings` uses these to reject nonsense
 * (a negative temperature, a history limit of a million) before it is saved.
 */
const LIMITS = {
  temperature: { min: 0, max: 2 },
  maxTokens: { min: 16, max: 32000 },
  historyLimit: { min: 1, max: 1000 },
  /** Longest allowed text for the prompt and sheet, in characters. */
  textLength: 100_000,
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
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Settings must be a JSON object");
  }
  const raw = input as Record<string, unknown>;
  const clean: Partial<Settings> = {};

  for (const key of ["partnerPrompt", "characterSheet"] as const) {
    if (raw[key] === undefined) continue;
    const value = raw[key];
    if (typeof value !== "string") throw new Error(`${key} must be text`);
    if (value.length > LIMITS.textLength) throw new Error(`${key} is too long`);
    clean[key] = value;
  }

  if (raw.model !== undefined) {
    if (typeof raw.model !== "string" || raw.model.trim() === "") {
      throw new Error("model must be a non-empty model id");
    }
    clean.model = raw.model.trim();
  }

  if (raw.temperature !== undefined) {
    clean.temperature = numberInRange(raw.temperature, "temperature", LIMITS.temperature, false);
  }
  if (raw.maxTokens !== undefined) {
    clean.maxTokens = numberInRange(raw.maxTokens, "maxTokens", LIMITS.maxTokens, true);
  }
  if (raw.historyLimit !== undefined) {
    clean.historyLimit = numberInRange(raw.historyLimit, "historyLimit", LIMITS.historyLimit, true);
  }

  return clean;
}

function numberInRange(
  value: unknown,
  name: string,
  range: { min: number; max: number },
  wholeNumber: boolean,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be a number`);
  }
  if (wholeNumber && !Number.isInteger(value)) {
    throw new Error(`${name} must be a whole number`);
  }
  if (value < range.min || value > range.max) {
    throw new Error(`${name} must be between ${range.min} and ${range.max}`);
  }
  return value;
}

/**
 * Holds the chat in memory and writes it to disk after every change.
 *
 * All methods are synchronous: the file is small and written in one go, so
 * there is no moment where two changes can interleave and corrupt it.
 */
export class Store {
  private data: SaveData;
  private readonly filePath: string;

  /**
   * Open (or create) the save file inside `dataDir`.
   * The folder is created if it does not exist yet.
   */
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.filePath = join(dataDir, "chat.json");
    this.data = this.load();
  }

  // ---------------------------------------------------------------- reading

  /** A copy of the current settings. */
  getSettings(): Settings {
    return { ...this.data.settings };
  }

  /** A copy of every message, oldest first. */
  getMessages(): Message[] {
    return this.data.messages.map((m) => ({ ...m }));
  }

  /** The newest message, or `undefined` if the chat is empty. */
  lastMessage(): Message | undefined {
    const last = this.data.messages.at(-1);
    return last ? { ...last } : undefined;
  }

  // ---------------------------------------------------------------- writing

  /** Apply an already-validated settings update and save. */
  updateSettings(update: Partial<Settings>): Settings {
    this.data.settings = { ...this.data.settings, ...update };
    this.save();
    return this.getSettings();
  }

  /** Append a new message to the end of the chat and save. */
  addMessage(author: Author, content: string, model?: string): Message {
    const message: Message = {
      id: crypto.randomUUID(),
      author,
      content,
      createdAt: new Date().toISOString(),
      // Only include `model` when there is one, to keep the file tidy.
      ...(model ? { model } : {}),
    };
    this.data.messages.push(message);
    this.save();
    return { ...message };
  }

  /** Replace a message's text. Returns the updated message, or `undefined` if no message has that id. */
  editMessage(id: string, content: string): Message | undefined {
    const message = this.data.messages.find((m) => m.id === id);
    if (!message) return undefined;
    message.content = content;
    message.editedAt = new Date().toISOString();
    this.save();
    return { ...message };
  }

  /** Remove one message. Returns `false` if no message has that id. */
  deleteMessage(id: string): boolean {
    const before = this.data.messages.length;
    this.data.messages = this.data.messages.filter((m) => m.id !== id);
    if (this.data.messages.length === before) return false;
    this.save();
    return true;
  }

  /** Remove every message (settings are kept). */
  clearMessages(): void {
    this.data.messages = [];
    this.save();
  }

  // ------------------------------------------------------------ file access

  /**
   * Read the save file, or start fresh if there isn't one.
   *
   * A file that exists but can't be parsed is *not* silently replaced: that
   * would throw away your chat. The server refuses to start instead, so you
   * can look at the file and fix or move it.
   */
  private load(): SaveData {
    if (!existsSync(this.filePath)) {
      const fresh: SaveData = { version: 1, settings: defaultSettings(), messages: [] };
      this.data = fresh;
      this.save();
      return fresh;
    }

    let parsed: SaveData;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
    } catch (error) {
      throw new Error(
        `Could not read ${this.filePath}: ${(error as Error).message}. ` +
          "Fix or move the file, then restart the server.",
      );
    }

    // Fill in any settings added in newer versions of Aettica, so an older
    // save file keeps working after an update.
    return {
      version: 1,
      settings: { ...defaultSettings(), ...parsed.settings },
      messages: Array.isArray(parsed.messages) ? parsed.messages : [],
    };
  }

  /**
   * Write the save file safely.
   *
   * Writing straight over `chat.json` has a risk: if the phone dies halfway
   * through, the file is left half-written and the chat is lost. Instead we
   * write a temporary file and then rename it over the old one. A rename is
   * atomic: afterwards the file is either entirely old or entirely new.
   */
  private save(): void {
    const tempPath = `${this.filePath}.tmp`;
    writeFileSync(tempPath, JSON.stringify(this.data, null, 2));
    renameSync(tempPath, this.filePath);
  }
}
