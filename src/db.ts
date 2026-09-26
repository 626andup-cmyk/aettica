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
import { parseSheet } from "./sheets.ts";

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
 *
 * Most steps are SQL. A step can also be a function, for moving data around
 * in ways that are easier to write in TypeScript (see step 4).
 */
export type Migration = string | ((db: Database) => void);

export const MIGRATIONS: Migration[] = [
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

  // ---------------------------------------------------------------- 2
  // Stage 3: channel modes (literary/casual), scene breaks, and turns.
  //
  // ALTER TABLE ... ADD COLUMN adds a column to an existing table. Every
  // existing row gets the DEFAULT value, so old data stays valid.
  `
  -- The mode of each channel's current scene, and a change waiting for the
  -- next scene break (NULL when none is waiting).
  ALTER TABLE channels ADD COLUMN mode TEXT NOT NULL DEFAULT 'literary'
    CHECK (mode IN ('literary', 'casual'));
  ALTER TABLE channels ADD COLUMN pending_mode TEXT
    CHECK (pending_mode IN ('literary', 'casual'));

  -- Scene breaks are rows in the messages table, so they stay in order with
  -- the messages around them. For a scene break, content is its title.
  ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'post'
    CHECK (kind IN ('post', 'scene_break'));

  -- The mode each message was written in (NULL outside RP channels).
  ALTER TABLE messages ADD COLUMN mode TEXT
    CHECK (mode IN ('literary', 'casual'));

  -- Messages written together (one casual reply's bubbles) share a turn id.
  ALTER TABLE messages ADD COLUMN turn_id TEXT;

  -- Everything written in RP channels so far was literary.
  UPDATE messages SET mode = 'literary'
   WHERE channel_id IN (SELECT id FROM channels WHERE kind = 'rp');
  `,

  // ---------------------------------------------------------------- 3
  // Stage 3.5: each channel can have its own theme (NULL: the app theme).
  // Themes themselves are folders, not rows; see src/themes.ts.
  `
  ALTER TABLE channels ADD COLUMN theme TEXT;
  `,

  // ---------------------------------------------------------------- 4
  // Stage 4: the notebook, and the cast of each channel.
  (db) => {
    db.exec(`
    -- Folders group entries, and pass their visibility and editing settings
    -- down to them.
    CREATE TABLE notebook_folders (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      owner      TEXT NOT NULL CHECK (owner IN ('user', 'partner', 'joint')),
      visibility TEXT NOT NULL DEFAULT 'visible' CHECK (visibility IN ('visible', 'hidden')),
      editing    TEXT NOT NULL DEFAULT 'open' CHECK (editing IN ('open', 'suggest', 'locked')),
      position   INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE notebook_entries (
      id            TEXT PRIMARY KEY,
      kind          TEXT NOT NULL CHECK (kind IN ('character', 'lore')),
      name          TEXT NOT NULL,
      -- The labelled fields, as a JSON list of {label, value}.
      fields        TEXT NOT NULL DEFAULT '[]',
      system_prompt TEXT NOT NULL DEFAULT '',
      proxy_prefix  TEXT,
      -- Deleting a folder moves its entries out of it rather than deleting them.
      folder_id     TEXT REFERENCES notebook_folders (id) ON DELETE SET NULL,
      owner         TEXT NOT NULL CHECK (owner IN ('user', 'partner', 'joint')),
      -- NULL means "use the folder's setting".
      visibility    TEXT CHECK (visibility IN ('visible', 'hidden')),
      editing       TEXT CHECK (editing IN ('open', 'suggest', 'locked')),
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );

    -- Which entries are pinned to which channels: the channel's cast (and
    -- its lore). A many-to-many relationship: an entry can be pinned to many
    -- channels, and a channel can have many entries pinned.
    CREATE TABLE channel_cast (
      channel_id TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
      entry_id   TEXT NOT NULL REFERENCES notebook_entries (id) ON DELETE CASCADE,
      position   INTEGER NOT NULL,
      PRIMARY KEY (channel_id, entry_id)
    );

    -- Suggested changes to entries someone can't edit directly.
    CREATE TABLE notebook_suggestions (
      id          TEXT PRIMARY KEY,
      entry_id    TEXT NOT NULL REFERENCES notebook_entries (id) ON DELETE CASCADE,
      author      TEXT NOT NULL CHECK (author IN ('user', 'partner')),
      -- What would change, as JSON (see SuggestedChange in src/types.ts).
      change      TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'accepted', 'rejected', 'withdrawn')),
      created_at  TEXT NOT NULL,
      resolved_at TEXT
    );
    `);

    const now = new Date().toISOString();
    const insertEntry = db.query(
      `INSERT INTO notebook_entries (id, kind, name, fields, proxy_prefix, owner, created_at, updated_at)
       VALUES ($id, 'character', $name, $fields, $prefix, $owner, $now, $now)`,
    );
    const pin = db.query(
      "INSERT OR IGNORE INTO channel_cast (channel_id, entry_id, position) VALUES ($channel, $entry, $position)",
    );

    // Each RP channel's character becomes an entry of your partner's, pinned
    // to that channel. Identical characters in several channels become one
    // entry pinned to each.
    const rpChannels = db
      .query("SELECT id, name, character_name, character_sheet FROM channels WHERE kind = 'rp' ORDER BY position")
      .all() as { id: string; name: string; character_name: string; character_sheet: string }[];
    const made = new Map<string, string>(); // name + sheet -> entry id
    for (const channel of rpChannels) {
      if (!channel.character_name.trim() && !channel.character_sheet.trim()) continue;
      const key = `${channel.character_name}\n${channel.character_sheet}`;
      let entryId = made.get(key);
      if (!entryId) {
        const sheet = parseSheet(channel.character_sheet);
        entryId = crypto.randomUUID();
        insertEntry.run({
          id: entryId,
          name: channel.character_name.trim() || sheet.name || `${channel.name} character`,
          fields: JSON.stringify(sheet.fields),
          prefix: null,
          owner: "partner",
          now,
        });
        made.set(key, entryId);
      }
      pin.run({ channel: channel.id, entry: entryId, position: 0 });
    }

    // Your casual characters (a list in settings until now) become entries
    // of yours, keeping their proxy prefixes, pinned to every RP channel.
    const saved = db.query("SELECT value FROM settings WHERE key = 'userCharacters'").get() as { value: string } | null;
    const yours = saved ? (JSON.parse(saved.value) as { name: string; prefix: string }[]) : [];
    yours.forEach((character, index) => {
      const entryId = crypto.randomUUID();
      insertEntry.run({ id: entryId, name: character.name, fields: "[]", prefix: character.prefix, owner: "user", now });
      for (const channel of rpChannels) pin.run({ channel: channel.id, entry: entryId, position: index + 1 });
    });
    db.exec("DELETE FROM settings WHERE key = 'userCharacters'");

    // The old per-channel character columns are no longer used.
    db.exec("ALTER TABLE channels DROP COLUMN character_name");
    db.exec("ALTER TABLE channels DROP COLUMN character_sheet");
  },

  // ---------------------------------------------------------------- 5
  // Stage 5: connection profiles and roulettes.
  (db) => {
    db.exec(`
    -- A connection profile: one model and its settings (see src/profiles.ts).
    CREATE TABLE profiles (
      id               TEXT PRIMARY KEY,
      name             TEXT NOT NULL,
      model            TEXT NOT NULL,
      temperature      REAL NOT NULL,
      max_tokens       INTEGER NOT NULL,
      top_p            REAL,
      reasoning_effort TEXT CHECK (reasoning_effort IN ('low', 'medium', 'high')),
      -- SQLite has no true/false type: 1 is true, 0 is false.
      supports_tools   INTEGER NOT NULL DEFAULT 1,
      quirk_prompt     TEXT NOT NULL DEFAULT '',
      extra_params     TEXT NOT NULL DEFAULT '',
      position         INTEGER NOT NULL,
      created_at       TEXT NOT NULL
    );

    -- A roulette: a weighted set of profiles.
    CREATE TABLE roulettes (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      position   INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE roulette_profiles (
      roulette_id TEXT NOT NULL REFERENCES roulettes (id) ON DELETE CASCADE,
      profile_id  TEXT NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
      weight      REAL NOT NULL CHECK (weight > 0),
      PRIMARY KEY (roulette_id, profile_id)
    );

    -- A channel's own profile or roulette ("profile:<id>" or
    -- "roulette:<id>"), overriding the server-wide one. NULL: no override.
    ALTER TABLE channels ADD COLUMN assignment TEXT;

    -- The name of the profile that wrote each partner message.
    ALTER TABLE messages ADD COLUMN profile TEXT;
    `);

    // The model settings become the first profile, which then writes both
    // jobs, so nothing changes until you change it. (A brand-new server has
    // no saved settings, and gets the defaults.)
    const saved = (key: string): unknown => {
      const row = db.query("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | null;
      return row ? JSON.parse(row.value) : undefined;
    };
    const model = (saved("model") as string | undefined) ?? "deepseek-ai/DeepSeek-V3.1-Terminus";
    const id = crypto.randomUUID();
    db.query(
      `INSERT INTO profiles (id, name, model, temperature, max_tokens, position, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?)`,
    ).run(
      id,
      model.split("/").at(-1) || model,
      model,
      (saved("temperature") as number | undefined) ?? 0.9,
      (saved("maxTokens") as number | undefined) ?? 1024,
      new Date().toISOString(),
    );
    db.exec("DELETE FROM settings WHERE key IN ('model', 'temperature', 'maxTokens')");
    const assign = db.query("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
    assign.run("rpAssignment", JSON.stringify(`profile:${id}`));
    assign.run("oocAssignment", JSON.stringify(`profile:${id}`));
  },
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
      const step = MIGRATIONS[version]!;
      if (typeof step === "string") db.exec(step);
      else step(db);
      // PRAGMA doesn't accept placeholders, but `version + 1` is our own
      // number, so building the text directly is safe here.
      db.exec(`PRAGMA user_version = ${version + 1}`);
    })();
  }
}

/** The latest layout version. Exported for tests. */
export const SCHEMA_VERSION = MIGRATIONS.length;
