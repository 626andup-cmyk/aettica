/**
 * Tests for the database and store (src/db.ts, src/store.ts): starting
 * content, channels, messages and the characters they voice, and rejecting
 * bad input.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { MIGRATIONS, openDatabase, SCHEMA_VERSION } from "../src/db.ts";
import { NotFoundError, Store, ValidationError, validateNewChannel, validateSettings } from "../src/store.ts";
import { tempDir } from "./helpers.ts";

let dir: ReturnType<typeof tempDir>;
let store: Store;

beforeEach(() => {
  dir = tempDir();
  store = new Store(dir.path);
});

afterEach(() => {
  store.close();
  dir.cleanup();
});

describe("a new server", () => {
  test("starts with #story and #ooc", () => {
    const [story, ooc] = store.listChannels();
    expect(story).toMatchObject({ name: "story", kind: "rp", position: 0 });
    expect(ooc).toMatchObject({ name: "ooc", kind: "ooc", position: 1 });
  });

  test("has the example character in the notebook, pinned to #story", () => {
    const [story, ooc] = store.listChannels();
    const [ilse] = store.notebook.listEntries("user");
    expect(ilse).toMatchObject({ name: "Ilse Marrow", kind: "character", owner: "partner" });
    // The sheet was read into fields.
    expect(ilse!.fields.find((f) => f.label === "Background")!.value).toContain("logbook");
    expect(store.notebook.castFor("user", story!.id).map((c) => c.name)).toEqual(["Ilse Marrow"]);
    expect(store.notebook.castFor("user", ooc!.id)).toEqual([]);
  });

  test("starts with the default settings", () => {
    const settings = store.getSettings();
    expect(settings.partnerName).toBe("Arlo");
    expect(settings.partnerPrompt).toContain("Arlo");
    // One prompt per kind of channel, each with its own default.
    expect(settings.oocPrompt).toContain("one or two sentences");
    expect(settings.literaryPrompt).toContain("prose");
    expect(settings.casualPrompt).not.toBe("");
  });

  test("isn't re-seeded on restart, even if you deleted every channel", () => {
    for (const channel of store.listChannels()) store.deleteChannel(channel.id);
    store.close();
    store = new Store(dir.path);
    expect(store.listChannels()).toEqual([]);
  });
});

describe("the database layout", () => {
  test("records its version", () => {
    const db = new Database(join(dir.path, "aettica.db"));
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: SCHEMA_VERSION });
    db.close();
  });

  test("upgrades a stage 2 database, keeping its data", () => {
    // Build a database the way stage 2 left it: only the first migration.
    const path = join(dir.path, "stage2.db");
    const old = new Database(path);
    old.exec(MIGRATIONS[0] as string);
    old.exec("PRAGMA user_version = 1");
    old.exec(`INSERT INTO channels (id, name, kind, position, created_at) VALUES ('rp', 'story', 'rp', 0, 'then')`);
    old.exec(`INSERT INTO channels (id, name, kind, position, created_at) VALUES ('ooc', 'ooc', 'ooc', 1, 'then')`);
    old.exec(`INSERT INTO messages (id, channel_id, author, content, created_at) VALUES ('m1', 'rp', 'user', 'Hi', 'then')`);
    old.exec(`INSERT INTO messages (id, channel_id, author, content, created_at) VALUES ('m2', 'ooc', 'user', 'Yo', 'then')`);
    old.close();

    const db = openDatabase(path);
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: SCHEMA_VERSION });
    expect(db.query("SELECT id, mode, pending_mode FROM channels ORDER BY position").all()).toEqual([
      { id: "rp", mode: "literary", pending_mode: null },
      { id: "ooc", mode: "literary", pending_mode: null },
    ]);
    // RP messages were literary; OOC messages have no mode.
    expect(db.query("SELECT id, kind, mode, turn_id FROM messages ORDER BY seq").all()).toEqual([
      { id: "m1", kind: "post", mode: "literary", turn_id: null },
      { id: "m2", kind: "post", mode: null, turn_id: null },
    ]);
    db.close();
  });

  test("moves stage 3.5's characters into the notebook", () => {
    // A database as stage 3.5 left it: three migrations, a character in
    // each RP channel (two identical), and your casual characters in settings.
    const path = join(dir.path, "stage35.db");
    const old = new Database(path);
    for (const step of MIGRATIONS.slice(0, 3)) old.exec(step as string);
    old.exec("PRAGMA user_version = 3");
    const channel = old.query(
      `INSERT INTO channels (id, name, kind, position, character_name, character_sheet, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'then')`,
    );
    channel.run("a", "story", "rp", 0, "Ilse Marrow", "Age: 34\nBackground: A keeper.");
    channel.run("b", "sequel", "rp", 1, "Ilse Marrow", "Age: 34\nBackground: A keeper.");
    channel.run("c", "heist", "rp", 2, "", "Name: Vee\nA getaway driver.");
    channel.run("d", "ooc", "ooc", 3, "", "");
    old.exec(`INSERT INTO settings (key, value) VALUES ('userCharacters', '[{"name":"Kestrel","prefix":"k"}]')`);
    old.close();

    const db = openDatabase(path);
    const entries = db.query("SELECT id, name, owner, proxy_prefix, fields FROM notebook_entries ORDER BY name").all() as {
      id: string;
      name: string;
      owner: string;
      proxy_prefix: string | null;
      fields: string;
    }[];
    expect(entries.map((e) => [e.name, e.owner, e.proxy_prefix])).toEqual([
      ["Ilse Marrow", "partner", null],
      ["Kestrel", "user", "k"],
      ["Vee", "partner", null],
    ]);
    expect(JSON.parse(entries[0]!.fields)).toEqual([
      { label: "Age", value: "34" },
      { label: "Background", value: "A keeper." },
    ]);
    expect(JSON.parse(entries[2]!.fields)).toEqual([{ label: "Notes", value: "A getaway driver." }]);

    const cast = (id: string) =>
      (db.query("SELECT e.name FROM channel_cast c JOIN notebook_entries e ON e.id = c.entry_id WHERE channel_id = ? ORDER BY c.position, e.name").all(id) as { name: string }[]).map(
        (r) => r.name,
      );
    // The identical character is one entry pinned to both channels.
    expect(cast("a")).toEqual(["Ilse Marrow", "Kestrel"]);
    expect(cast("b")).toEqual(["Ilse Marrow", "Kestrel"]);
    expect(cast("c")).toEqual(["Vee", "Kestrel"]);
    expect(cast("d")).toEqual([]);

    expect(db.query("SELECT * FROM settings WHERE key = 'userCharacters'").get()).toBeNull();
    const columns = (db.query("PRAGMA table_info(channels)").all() as { name: string }[]).map((c) => c.name);
    expect(columns).not.toContain("character_name");
    db.close();
  });

  test("moves stage 4's model settings into a connection profile", () => {
    const path = join(dir.path, "stage4.db");
    const old = new Database(path);
    for (const step of MIGRATIONS.slice(0, 4)) {
      if (typeof step === "string") old.exec(step);
      else step(old);
    }
    old.exec("PRAGMA user_version = 4");
    const setting = old.query("INSERT INTO settings (key, value) VALUES (?, ?)");
    setting.run("model", JSON.stringify("zai/glm-5.2"));
    setting.run("temperature", "1.1");
    setting.run("maxTokens", "700");
    old.close();

    const db = openDatabase(path);
    const profiles = db.query("SELECT id, name, model, temperature, max_tokens FROM profiles").all() as {
      id: string;
      name: string;
    }[];
    expect(profiles).toMatchObject([{ name: "glm-5.2", model: "zai/glm-5.2", temperature: 1.1, max_tokens: 700 }]);
    const settings = Object.fromEntries(
      (db.query("SELECT key, value FROM settings").all() as { key: string; value: string }[]).map((r) => [r.key, JSON.parse(r.value)]),
    );
    expect(settings).toEqual({ rpAssignment: `profile:${profiles[0]!.id}`, oocAssignment: `profile:${profiles[0]!.id}` });
    db.close();
  });

  test("refuses a database from a newer version of Aettica", () => {
    const path = join(dir.path, "future.db");
    const db = new Database(path);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    db.close();
    expect(() => openDatabase(path)).toThrow(/newer version/);
  });
});

describe("settings", () => {
  test("keep their changes after a restart", () => {
    store.updateSettings({ historyLimit: 12, partnerName: "Sol" });
    store.close();
    store = new Store(dir.path);
    expect(store.getSettings()).toMatchObject({ historyLimit: 12, partnerName: "Sol" });
  });
});

describe("channels", () => {
  test("new channels go to the bottom of the sidebar", () => {
    const created = store.createChannel({ name: "heist", kind: "rp" });
    expect(created.position).toBe(2);
    expect(store.listChannels().at(-1)!.id).toBe(created.id);
  });

  test("can be renamed", () => {
    const story = store.listChannels()[0]!;
    expect(store.updateChannel(story.id, { name: "lighthouse" })).toMatchObject({ name: "lighthouse" });
  });

  test("can be reordered, but only with every channel listed exactly once", () => {
    const [a, b] = store.listChannels();
    expect(store.reorderChannels([b!.id, a!.id]).map((c) => c.name)).toEqual(["ooc", "story"]);
    expect(() => store.reorderChannels([a!.id])).toThrow(ValidationError);
    expect(() => store.reorderChannels([a!.id, a!.id])).toThrow(ValidationError);
    expect(() => store.reorderChannels([a!.id, "nope"])).toThrow(ValidationError);
  });

  test("deleting a channel deletes its messages and their characters", () => {
    const story = store.listChannels()[0]!;
    const message = store.addMessage({ channelId: story.id, author: "partner", content: "Hi", characters: ["Ilse"] });
    store.deleteChannel(story.id);

    expect(() => store.getMessage(message.id)).toThrow(NotFoundError);
    const leftovers = store.db.query("SELECT COUNT(*) AS n FROM message_characters").get() as { n: number };
    expect(leftovers.n).toBe(0);
    // Its cast is unpinned, but the characters stay in the notebook.
    const pins = store.db.query("SELECT COUNT(*) AS n FROM channel_cast").get() as { n: number };
    expect(pins.n).toBe(0);
    expect(store.notebook.listEntries("user")).toHaveLength(1);
  });

  test("unknown channel ids are reported as not found", () => {
    expect(() => store.getChannel("nope")).toThrow(NotFoundError);
    expect(() => store.getMessages("nope")).toThrow(NotFoundError);
    expect(() => store.deleteChannel("nope")).toThrow(NotFoundError);
  });
});

describe("channel modes", () => {
  test("new channels are literary unless told otherwise", () => {
    expect(store.listChannels()[0]!.mode).toBe("literary");
    expect(store.createChannel({ name: "chat", kind: "rp", mode: "casual" }).mode).toBe("casual");
  });

  test("a change applies at once while the current scene is empty", () => {
    const story = store.listChannels()[0]!;
    expect(store.updateChannel(story.id, { mode: "casual" })).toMatchObject({ mode: "casual", pendingMode: null });
  });

  test("a change mid-scene waits for the next scene break", () => {
    const story = store.listChannels()[0]!;
    store.addMessage({ channelId: story.id, author: "user", content: "Hi", mode: "literary" });

    expect(store.updateChannel(story.id, { mode: "casual" })).toMatchObject({ mode: "literary", pendingMode: "casual" });

    const { sceneBreak, channel } = store.addSceneBreak(story.id, "user", "  The Storm ");
    expect(sceneBreak).toMatchObject({ kind: "scene_break", content: "The Storm", author: "user", mode: null });
    expect(channel).toMatchObject({ mode: "casual", pendingMode: null });

    // The new scene is empty, so another change applies at once.
    expect(store.updateChannel(story.id, { mode: "literary" })).toMatchObject({ mode: "literary", pendingMode: null });
  });

  test("asking for the current mode cancels a waiting change", () => {
    const story = store.listChannels()[0]!;
    store.addMessage({ channelId: story.id, author: "user", content: "Hi" });
    store.updateChannel(story.id, { mode: "casual" });
    expect(store.updateChannel(story.id, { mode: "literary" }).pendingMode).toBeNull();
  });

  test("scene breaks are only for roleplay channels", () => {
    const ooc = store.listChannels()[1]!;
    expect(() => store.addSceneBreak(ooc.id, "user", "")).toThrow(ValidationError);
  });
});

describe("turns", () => {
  test("messages added together share a turn id", () => {
    const story = store.listChannels()[0]!;
    const turn = store.addTurn([
      { channelId: story.id, author: "partner", content: "one" },
      { channelId: story.id, author: "partner", content: "two" },
    ]);
    expect(turn[0]!.turnId).toBeString();
    expect(turn[1]!.turnId).toBe(turn[0]!.turnId);
  });

  test("lastPartnerTurn returns the whole last reply, or nothing", () => {
    const story = store.listChannels()[0]!;
    expect(store.lastPartnerTurn(story.id)).toEqual([]);

    store.addTurn([{ channelId: story.id, author: "partner", content: "earlier" }]);
    store.addTurn([{ channelId: story.id, author: "user", content: "hi" }]);
    store.addTurn([
      { channelId: story.id, author: "partner", content: "a" },
      { channelId: story.id, author: "partner", content: "b" },
    ]);
    expect(store.lastPartnerTurn(story.id).map((m) => m.content)).toEqual(["a", "b"]);

    store.addSceneBreak(story.id, "user", "");
    expect(store.lastPartnerTurn(story.id)).toEqual([]);
  });

  test("an old message without a turn id is a turn of its own", () => {
    const story = store.listChannels()[0]!;
    store.addMessage({ channelId: story.id, author: "partner", content: "old" });
    expect(store.lastPartnerTurn(story.id).map((m) => m.content)).toEqual(["old"]);
  });
});

describe("messages", () => {
  test("stay in their own channel, in order, with the characters they voice", () => {
    const [story, ooc] = store.listChannels();
    store.addMessage({ channelId: story!.id, author: "user", content: "one" });
    store.addMessage({ channelId: ooc!.id, author: "user", content: "elsewhere" });
    store.addMessage({ channelId: story!.id, author: "partner", content: "two", characters: ["Ilse", "Gull"], model: "m" });

    const messages = store.getMessages(story!.id);
    expect(messages.map((m) => [m.content, m.characters, m.model])).toEqual([
      ["one", [], undefined],
      ["two", ["Ilse", "Gull"], "m"],
    ]);
    expect(store.lastMessage(story!.id)!.content).toBe("two");
    expect(store.getMessages(ooc!.id)).toHaveLength(1);
  });

  test("can be edited, deleted and cleared", () => {
    const story = store.listChannels()[0]!;
    const a = store.addMessage({ channelId: story.id, author: "user", content: "typo" });
    const b = store.addMessage({ channelId: story.id, author: "partner", content: "reply" });

    expect(store.editMessage(a.id, "fixed")).toMatchObject({ content: "fixed", editedAt: expect.any(String) });
    store.deleteMessage(b.id);
    expect(() => store.deleteMessage(b.id)).toThrow(NotFoundError);
    expect(() => store.editMessage("nope", "x")).toThrow(NotFoundError);
    expect(store.getMessages(story.id)).toHaveLength(1);

    store.clearMessages(story.id);
    expect(store.getMessages(story.id)).toHaveLength(0);
  });

  test("the database refuses a message in a channel that doesn't exist", () => {
    expect(() => store.addMessage({ channelId: "nope", author: "user", content: "Hi" })).toThrow(/FOREIGN KEY/);
  });
});

describe("validation", () => {
  test("accepts valid settings and drops unknown fields", () => {
    expect(validateSettings({ historyLimit: 5, rpAssignment: "profile:abc", sneaky: true })).toEqual({
      historyLimit: 5,
      rpAssignment: "profile:abc",
    });
  });

  test.each([
    [{ historyLimit: 0 }, /historyLimit must be between/],
    [{ partnerName: "  " }, /partnerName must be non-empty/],
    [{ partnerPrompt: 42 }, /partnerPrompt must be text/],
    [{ rpAssignment: "gpt" }, /rpAssignment must be/],
    [{ oocPrompt: 42 }, /oocPrompt must be text/],
    [[], /must be a JSON object/],
  ])("rejects settings %j", (input, error) => {
    expect(() => validateSettings(input)).toThrow(error);
  });

  test.each([
    [{ name: "x", kind: "dm" }, /kind must be/],
    [{ name: "", kind: "rp" }, /name must be non-empty/],
    [{ name: "x".repeat(101), kind: "rp" }, /name is too long/],
    [{ name: "x", kind: "rp", mode: "noir" }, /mode must be/],
  ])("rejects new channel %j", (input, error) => {
    expect(() => validateNewChannel(input)).toThrow(error);
  });
});
