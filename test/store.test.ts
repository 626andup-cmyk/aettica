/**
 * Tests for the store (src/store.ts): saving, reloading, and rejecting bad
 * settings.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Store, validateSettings } from "../src/store.ts";
import { tempDir } from "./helpers.ts";

let dir: ReturnType<typeof tempDir>;
beforeEach(() => (dir = tempDir()));
afterEach(() => dir.cleanup());

describe("Store", () => {
  test("starts with the default partner prompt and character sheet", () => {
    const settings = new Store(dir.path).getSettings();
    expect(settings.partnerPrompt).toContain("Arlo");
    expect(settings.characterSheet).toContain("Ilse Marrow");
    expect(existsSync(join(dir.path, "chat.json"))).toBe(true);
  });

  test("keeps messages and settings after a restart", () => {
    const first = new Store(dir.path);
    first.addMessage("user", "Hello");
    first.addMessage("partner", "Hi!", "test/model");
    first.updateSettings({ temperature: 0.5 });

    // A new Store reading the same folder is what happens when the server restarts.
    const second = new Store(dir.path);
    expect(second.getMessages().map((m) => [m.author, m.content, m.model])).toEqual([
      ["user", "Hello", undefined],
      ["partner", "Hi!", "test/model"],
    ]);
    expect(second.getSettings().temperature).toBe(0.5);
  });

  test("edits and deletes messages by id", () => {
    const store = new Store(dir.path);
    const a = store.addMessage("user", "typo");
    const b = store.addMessage("partner", "reply");

    expect(store.editMessage(a.id, "fixed")?.content).toBe("fixed");
    expect(store.getMessages()[0]!.editedAt).toBeString();
    expect(store.deleteMessage(b.id)).toBe(true);
    expect(store.deleteMessage("no-such-id")).toBe(false);
    expect(store.editMessage("no-such-id", "x")).toBeUndefined();
    expect(store.getMessages()).toHaveLength(1);
  });

  test("refuses to start on a corrupt save file instead of overwriting it", () => {
    const file = join(dir.path, "chat.json");
    writeFileSync(file, "{ not json");
    expect(() => new Store(dir.path)).toThrow(/Could not read/);
    // The broken file is untouched, so nothing is lost.
    expect(readFileSync(file, "utf8")).toBe("{ not json");
  });

  test("fills in settings missing from an older save file", () => {
    writeFileSync(join(dir.path, "chat.json"), JSON.stringify({ version: 1, settings: { model: "old/model" }, messages: [] }));
    const settings = new Store(dir.path).getSettings();
    expect(settings.model).toBe("old/model");
    expect(settings.historyLimit).toBe(40);
  });
});

describe("validateSettings", () => {
  test("accepts valid fields and drops unknown ones", () => {
    expect(validateSettings({ temperature: 1, model: "  a/b  ", sneaky: true })).toEqual({ temperature: 1, model: "a/b" });
  });

  test.each([
    [{ temperature: 5 }, /temperature must be between/],
    [{ temperature: "hot" }, /temperature must be a number/],
    [{ maxTokens: 10.5 }, /maxTokens must be a whole number/],
    [{ historyLimit: 0 }, /historyLimit must be between/],
    [{ model: "" }, /model must be/],
    [{ partnerPrompt: 42 }, /partnerPrompt must be text/],
    [[], /must be a JSON object/],
  ])("rejects %j", (input, error) => {
    expect(() => validateSettings(input)).toThrow(error);
  });
});
