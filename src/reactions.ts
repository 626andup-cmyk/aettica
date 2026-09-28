/**
 * Emoji reactions on messages, from you and your partner, and custom emojis.
 *
 * A reaction is an emoji on a message from one of you: 👍 on your partner's
 * post, 😂 from them on yours. Each of you can put several different emojis
 * on a message, once each. Your partner reacts with a tool
 * (`react_to_message`, src/tools.ts), and sees your reactions to recent
 * messages in their prompt: a quiet kind of feedback ("the user reacted ❤️
 * to your message: ...").
 *
 * **Custom emojis** are small images you upload with a name, used as
 * `:name:`, like Discord's: as reactions, and in messages (the app shows
 * the image; the model sees the `:name:`). They're saved as files in the
 * data folder (`emojis/`), and served at `/emojis/<file>`.
 */

import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NotFoundError, ValidationError } from "./errors.ts";
import type { Author, Reaction } from "./types.ts";

/** A custom emoji. */
export interface CustomEmoji {
  name: string;
  /** Its file under /emojis/. */
  file: string;
  createdAt: string;
}

/** Most different emojis one of you can put on one message. */
export const MAX_REACTIONS_EACH = 6;

/** Largest custom emoji image, in bytes. */
export const MAX_EMOJI_BYTES = 512 * 1024;

/** Most custom emojis. */
export const MAX_CUSTOM_EMOJIS = 300;

/** A custom emoji's name: letters, digits and underscores, like Discord's. */
const EMOJI_NAME = /^[a-z0-9_]{2,32}$/;

/** Image types, told apart by their first bytes (not the file name). */
const IMAGE_TYPES: { ext: string; type: string; test: (b: Uint8Array) => boolean }[] = [
  { ext: "png", type: "image/png", test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { ext: "gif", type: "image/gif", test: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 },
  { ext: "jpg", type: "image/jpeg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    ext: "webp",
    type: "image/webp",
    test: (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
  },
];

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

/**
 * Whether text is exactly one emoji (one grapheme that's pictographic, a
 * flag, or a keycap), like "👍", "❤️", "👩🏽‍💻" or "🇯🇵".
 */
export function isEmoji(text: string): boolean {
  const graphemes = [...segmenter.segment(text)];
  if (graphemes.length !== 1 || text.length > 32) return false;
  return /\p{Extended_Pictographic}|\p{Regional_Indicator}{2}|[0-9#*]️?⃣/u.test(text);
}

interface EmojiRow {
  name: string;
  file: string;
  created_at: string;
}

export class Reactions {
  private readonly folder: string;

  constructor(
    private readonly db: Database,
    dataDir: string,
    /** Told when reactions change, so the app notices (Store.revision). */
    private readonly changed: () => void = () => {},
  ) {
    this.folder = join(dataDir, "emojis");
  }

  // ------------------------------------------------------------ reactions

  /**
   * Check an emoji for a reaction: one emoji, or `:name:` of a custom one.
   * Returns it cleaned (trimmed).
   */
  cleanEmoji(input: unknown): string {
    if (typeof input !== "string") throw new ValidationError("A reaction must be an emoji.");
    const emoji = input.trim();
    const custom = /^:([a-z0-9_]{2,32}):$/.exec(emoji);
    if (custom) {
      if (!this.getEmoji(custom[1]!)) throw new ValidationError(`There's no custom emoji called :${custom[1]}:.`);
      return emoji;
    }
    if (!isEmoji(emoji)) throw new ValidationError("A reaction must be a single emoji, or :name: of a custom one.");
    return emoji;
  }

  /** A message's reactions, oldest first. */
  forMessage(messageId: string): Reaction[] {
    return this.db
      .query("SELECT emoji, author FROM reactions WHERE message_id = $messageId ORDER BY created_at, rowid")
      .all({ messageId }) as Reaction[];
  }

  /** Whether an author already reacted to a message with an emoji. */
  has(messageId: string, author: Author, emoji: string): boolean {
    return (
      this.db
        .query("SELECT 1 FROM reactions WHERE message_id = $messageId AND author = $author AND emoji = $emoji")
        .get({ messageId, author, emoji }) !== null
    );
  }

  /**
   * React to a message (if not already). The message must exist; the
   * caller checks it. Throws when that author already has
   * `MAX_REACTIONS_EACH` different reactions on it.
   */
  add(messageId: string, author: Author, input: unknown): Reaction[] {
    const emoji = this.cleanEmoji(input);
    if (!this.has(messageId, author, emoji)) {
      const { n } = this.db.query("SELECT COUNT(*) AS n FROM reactions WHERE message_id = $messageId AND author = $author").get({
        messageId,
        author,
      }) as { n: number };
      if (n >= MAX_REACTIONS_EACH) throw new ValidationError(`That's ${MAX_REACTIONS_EACH} reactions on one message already.`);
      this.db
        .query("INSERT INTO reactions (message_id, author, emoji, created_at) VALUES ($messageId, $author, $emoji, $now)")
        .run({ messageId, author, emoji, now: new Date().toISOString() });
      this.changed();
    }
    return this.forMessage(messageId);
  }

  /** Take a reaction back. */
  remove(messageId: string, author: Author, emoji: string): Reaction[] {
    this.db.query("DELETE FROM reactions WHERE message_id = $messageId AND author = $author AND emoji = $emoji").run({ messageId, author, emoji });
    this.changed();
    return this.forMessage(messageId);
  }

  /** Add a reaction, or take it back if it's there. */
  toggle(messageId: string, author: Author, input: unknown): Reaction[] {
    const emoji = typeof input === "string" ? input.trim() : input;
    if (typeof emoji === "string" && this.has(messageId, author, emoji)) return this.remove(messageId, author, emoji);
    return this.add(messageId, author, emoji);
  }

  // -------------------------------------------------------- custom emojis

  /** Every custom emoji, by name. */
  listEmojis(): CustomEmoji[] {
    const rows = this.db.query("SELECT * FROM custom_emojis ORDER BY name").all() as EmojiRow[];
    return rows.map((r) => ({ name: r.name, file: r.file, createdAt: r.created_at }));
  }

  getEmoji(name: string): CustomEmoji | null {
    const row = this.db.query("SELECT * FROM custom_emojis WHERE name = $name").get({ name }) as EmojiRow | null;
    return row ? { name: row.name, file: row.file, createdAt: row.created_at } : null;
  }

  /** Add a custom emoji (or replace the image of one with that name). */
  addEmoji(nameInput: unknown, bytes: Uint8Array): CustomEmoji {
    const name = typeof nameInput === "string" ? nameInput.trim().replace(/^:|:$/g, "").toLowerCase() : "";
    if (!EMOJI_NAME.test(name)) throw new ValidationError("An emoji's name is 2 to 32 letters, digits or underscores, like blob_wave.");
    if (bytes.length === 0) throw new ValidationError("The image is empty.");
    if (bytes.length > MAX_EMOJI_BYTES) throw new ValidationError("Emoji images can be 512 KB at most.");
    const type = IMAGE_TYPES.find((t) => t.test(bytes));
    if (!type) throw new ValidationError("Emojis must be PNG, GIF, JPEG or WebP images.");
    const existing = this.getEmoji(name);
    if (!existing && this.listEmojis().length >= MAX_CUSTOM_EMOJIS) {
      throw new ValidationError(`That's ${MAX_CUSTOM_EMOJIS} custom emojis already.`);
    }
    mkdirSync(this.folder, { recursive: true });
    // A new file name each time, so browsers don't show an old cached image.
    const file = `${name}-${Date.now().toString(36)}.${type.ext}`;
    writeFileSync(join(this.folder, file), bytes);
    if (existing) rmSync(join(this.folder, existing.file), { force: true });
    this.db
      .query(
        `INSERT INTO custom_emojis (name, file, created_at) VALUES ($name, $file, $now)
         ON CONFLICT (name) DO UPDATE SET file = excluded.file`,
      )
      .run({ name, file, now: new Date().toISOString() });
    return this.getEmoji(name)!;
  }

  /** Delete a custom emoji, and every reaction with it. */
  removeEmoji(name: string): void {
    const emoji = this.getEmoji(name);
    if (!emoji) throw new NotFoundError("custom emoji");
    this.db.transaction(() => {
      this.db.query("DELETE FROM reactions WHERE emoji = $emoji").run({ emoji: `:${name}:` });
      this.db.query("DELETE FROM custom_emojis WHERE name = $name").run({ name });
    })();
    this.changed();
    rmSync(join(this.folder, emoji.file), { force: true });
  }

  /** Serve `/emojis/<file>`, or `null` if there's no such file. */
  serve(file: string): Response | null {
    if (!/^[a-z0-9_]{2,32}-[a-z0-9]+\.(png|gif|jpg|webp)$/.test(file)) return null;
    const path = join(this.folder, file);
    if (!existsSync(path)) return null;
    const type = IMAGE_TYPES.find((t) => file.endsWith(`.${t.ext}`))!.type;
    // Each image's name changes when it does, so it can be cached for good.
    return new Response(readFileSync(path), { headers: { "Content-Type": type, "Cache-Control": "public, max-age=31536000, immutable" } });
  }
}
