/**
 * Tests for importing a stage 1 chat (src/legacy.ts).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { guessCharacterName } from "../src/legacy.ts";
import { Store } from "../src/store.ts";
import { tempDir } from "./helpers.ts";

let dir: ReturnType<typeof tempDir>;
beforeEach(() => (dir = tempDir()));
afterEach(() => dir.cleanup());

/** Write a stage 1 save file into the temp folder. */
function writeStage1Chat(data: unknown) {
  writeFileSync(join(dir.path, "chat.json"), typeof data === "string" ? data : JSON.stringify(data));
}

describe("importing a stage 1 chat", () => {
  test("moves the chat into #story with its character, and adds #ooc", () => {
    writeStage1Chat({
      version: 1,
      settings: {
        partnerPrompt: "You are Sol.",
        characterSheet: "Name: Captain Reyes\nA smuggler.",
        model: "old/model",
        temperature: 1.1,
        maxTokens: 800,
        historyLimit: 20,
      },
      messages: [
        { id: "m1", author: "user", content: "Hello", createdAt: "2026-09-01T10:00:00.000Z" },
        { id: "m2", author: "partner", content: "Ahoy.", createdAt: "2026-09-01T10:01:00.000Z", model: "old/model" },
      ],
    });

    const store = new Store(dir.path);
    const [story, ooc] = store.listChannels();

    expect(story).toMatchObject({ name: "story", kind: "rp", characterName: "Captain Reyes" });
    expect(story!.characterSheet).toBe("Name: Captain Reyes\nA smuggler.");
    expect(ooc).toMatchObject({ name: "ooc", kind: "ooc" });

    expect(store.getMessages(story!.id).map((m) => [m.id, m.author, m.content, m.characters, m.createdAt, m.model])).toEqual([
      ["m1", "user", "Hello", [], "2026-09-01T10:00:00.000Z", undefined],
      ["m2", "partner", "Ahoy.", ["Captain Reyes"], "2026-09-01T10:01:00.000Z", "old/model"],
    ]);

    expect(store.getSettings()).toMatchObject({
      partnerPrompt: "You are Sol.",
      model: "old/model",
      temperature: 1.1,
      maxTokens: 800,
      historyLimit: 20,
    });
    store.close();
  });

  test("keeps the old file, renamed, and doesn't import it twice", () => {
    writeStage1Chat({ settings: {}, messages: [{ author: "user", content: "Hi" }] });

    new Store(dir.path).close();
    expect(existsSync(join(dir.path, "chat.json"))).toBe(false);
    expect(existsSync(join(dir.path, "chat.json.imported"))).toBe(true);

    const again = new Store(dir.path);
    expect(again.listChannels()).toHaveLength(2);
    again.close();
  });

  test("skips invalid old settings instead of failing", () => {
    writeStage1Chat({ settings: { temperature: 99, model: "ok/model" }, messages: [] });
    const store = new Store(dir.path);
    expect(store.getSettings()).toMatchObject({ temperature: 0.9, model: "ok/model" });
    store.close();
  });

  test("refuses to start on a corrupt stage 1 file rather than lose it", () => {
    writeStage1Chat("{ not json");
    expect(() => new Store(dir.path)).toThrow(/couldn't read it/);
    expect(existsSync(join(dir.path, "chat.json"))).toBe(true);
  });
});

describe("guessCharacterName", () => {
  test.each([
    ["Name: Ilse Marrow\nAge: 34", "Ilse Marrow"],
    ["Age: 34\n  name :  Vee  \n", "Vee"],
    ["A lighthouse keeper.", ""],
  ])("%j gives %j", (sheet, expected) => {
    expect(guessCharacterName(sheet)).toBe(expected);
  });
});
