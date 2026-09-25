/**
 * The database: where everything is stored, and how its layout is kept up
 * to date.
 *
 * Aettica uses SQLite, a database that lives in a single file
 * (`data/aettica.db`) and is built into Bun, so there is nothing to install
 * or run alongside the server.
 *
 * A database stores data in *tables*. Each table has fixed *columns*, and
 * each item is a *row*. Tables point at each other through ids; that is what
 * "data relationships" means. In Aettica:
 *
 *   channels ──< messages ──< message_characters
 *
 * reads as "a channel has many messages, and a message has many characters
 * it voices". Each message row stores its channel's id (`channel_id`), and
 * each message_characters row stores its message's id (`message_id`).
 *
 * This file only knows about the *layout* of the tables. Reading and
 * writing actual data happens in `src/store.ts`.
 */

import { Database } from "bun:sqlite";

/**
 * Every change ever made to the database layout, oldest first.
 *
 * A *migration* is a step that moves the layout from one version to the
 * next. SQLite keeps a version number in the file itself (`user_version`).
 * On startup, any migrations newer than that number run, in order, and the
 * number is updated. So an old database is upgraded automatically, and a new
 * one is built by running every step from the start.
 *
 * Never edit a migration once it has been released: databases that already
 * ran it won't run it again. Add a new one to the end instead.
 */
const MIGRATIONS: string[] = [
  // ---------------------------------------------------------------- 1
  // Stage 2: settings, channels, messages, and the characters each message
  // voices.
  `
  -- Server-wide settings as key/value pairs. Each value is stored as JSON,
  -- so numbers stay numbers and text stays text.
  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE channels (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    -- CHECK makes the database itself refuse any other value.
    kind            TEXT NOT NULL CHECK (kind IN ('rp', 'ooc')),
    position        INTEGER NOT NULL,
    character_name  TEXT NOT NULL DEFAULT '',
    character_sheet TEXT NOT NULL DEFAULT '',
    created_at      TEXT NOT NULL
  );

  CREATE TABLE messages (
    -- seq counts up by one for every message ever saved, so ordering by it
    -- gives the order messages were written in.
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    id         TEXT NOT NULL UNIQUE,
    -- REFERENCES ties each message to a real channel. ON DELETE CASCADE
    -- means deleting a channel deletes its messages too, instead of leaving
    -- orphans behind.
    channel_id TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    author     TEXT NOT NULL CHECK (author IN ('user', 'partner')),
    content    TEXT NOT NULL,
    created_at TEXT NOT NULL,
    edited_at  TEXT,
    model      TEXT
  );

  -- An index is like the index at the back of a book: it lets SQLite jump
  -- straight to one channel's messages instead of reading every message.
  CREATE INDEX messages_by_channel ON messages (channel_id, seq);

  -- Which character(s) each message voices. One row per character, so a
  -- message can voice none, one or several. Stage 4 will point these at
  -- notebook entries instead of plain names.
  CREATE TABLE message_characters (
    message_id     TEXT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
    character_name TEXT NOT NULL,
    -- Keeps the characters in the order they were given.
    position       INTEGER NOT NULL,
    PRIMARY KEY (message_id, character_name)
  );
  `,
];

/**
 * Open (or create) the database file and bring its layout up to date.
 *
 * @param path  File path, or `":memory:"` for a throwaway in-memory database.
 */
export function openDatabase(path: string): Database {
  // `strict: true` lets queries use `$name` placeholders filled from plain
  // objects like `{ name: "story" }`, and makes a missing value an error.
  const db = new Database(path, { create: true, strict: true });

  // SQLite doesn't enforce REFERENCES unless asked to, once per connection.
  db.exec("PRAGMA foreign_keys = ON");
  // WAL ("write-ahead log") mode makes saves faster and safer if the phone
  // dies mid-write. It adds `-wal` and `-shm` files next to the database;
  // they belong to it, so copy all three if you back up while the server runs.
  db.exec("PRAGMA journal_mode = WAL");

  migrate(db);
  return db;
}

/** Run any migrations the database hasn't had yet. */
function migrate(db: Database): void {
  const { user_version: current } = db.query("PRAGMA user_version").get() as { user_version: number };

  if (current > MIGRATIONS.length) {
    throw new Error(
      `The database was created by a newer version of Aettica (layout version ${current}, ` +
        `this version knows up to ${MIGRATIONS.length}). Update Aettica before opening it.`,
    );
  }

  for (let version = current; version < MIGRATIONS.length; version++) {
    // A transaction makes the whole step happen completely or not at all, so
    // a crash can't leave the database half-upgraded.
    db.transaction(() => {
      db.exec(MIGRATIONS[version]!);
      // PRAGMA doesn't accept placeholders, but `version + 1` is our own
      // number, so building the text directly is safe here.
      db.exec(`PRAGMA user_version = ${version + 1}`);
    })();
  }
}

/** The latest layout version. Exported for tests. */
export const SCHEMA_VERSION = MIGRATIONS.length;
