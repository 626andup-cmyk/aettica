/**
 * Tests for the notebook (src/notebook.ts) and sheet parsing (src/sheets.ts):
 * entries, folders, suggestions, pins, and what reaches your partner's
 * prompt, each checked from both your side and your partner's.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PermissionError, NotFoundError, ValidationError } from "../src/errors.ts";
import { linkedNames, type Notebook } from "../src/notebook.ts";
import { HIDDEN_NAME } from "../src/permissions.ts";
import { parseSheet } from "../src/sheets.ts";
import { Store } from "../src/store.ts";
import { tempDir } from "./helpers.ts";

let dir: ReturnType<typeof tempDir>;
let store: Store;
let notebook: Notebook;
let story: string;

beforeEach(() => {
  dir = tempDir();
  store = new Store(dir.path);
  notebook = store.notebook;
  story = store.listChannels()[0]!.id;
  // Start from an empty notebook, without the example character.
  for (const entry of notebook.listEntries("user")) store.db.query("DELETE FROM notebook_entries WHERE id = ?").run(entry.id);
});

afterEach(() => {
  store.close();
  dir.cleanup();
});

/** Make an entry as you, for whoever owns it. */
const make = (input: Record<string, unknown>) => notebook.createEntry("user", { kind: "character", ...input });

/** Make an entry as your partner (as their tools will in stage 6). */
const partnerMakes = (input: Record<string, unknown>) => notebook.createEntry("partner", { kind: "character", ...input });

describe("entries", () => {
  test("start from their kind's template", () => {
    expect(make({ name: "Kestrel" }).fields.map((f) => f.label)).toEqual([
      "Pronouns",
      "Age",
      "Appearance",
      "Personality",
      "Background",
      "Speech",
    ]);
    expect(make({ name: "The Sea", kind: "lore" }).fields.map((f) => f.label)).toEqual(["Summary", "Details"]);
  });

  test("are yours unless you say otherwise; you can make them for your partner or share them", () => {
    expect(make({ name: "A" }).owner).toBe("user");
    expect(make({ name: "B", owner: "partner" }).owner).toBe("partner");
    expect(make({ name: "C", owner: "joint" }).owner).toBe("joint");
  });

  test("your partner can't make entries that are yours", () => {
    expect(() => partnerMakes({ name: "Mine", owner: "user" })).toThrow(ValidationError);
  });

  test("only the owner picks visibility and editing when making one", () => {
    expect(() => make({ name: "Secret", owner: "partner", visibility: "hidden" })).toThrow(PermissionError);
  });

  test("need a name, and a valid kind", () => {
    expect(() => make({ name: "  " })).toThrow(/can't be empty/);
    expect(() => make({ name: "X", kind: "place" })).toThrow(/kind must be/);
  });
});

describe("visibility", () => {
  test("an entry hidden from you doesn't exist, as far as you can tell", () => {
    const secret = partnerMakes({ name: "The Stranger", visibility: "hidden" });
    expect(notebook.listEntries("user")).toEqual([]);
    expect(() => notebook.getEntry("user", secret.id)).toThrow(NotFoundError);
    expect(notebook.listEntries("partner").map((e) => e.name)).toEqual(["The Stranger"]);
  });

  test("an entry you hide from your partner is hidden from them", () => {
    make({ name: "My Twist", visibility: "hidden" });
    expect(notebook.listEntries("partner")).toEqual([]);
  });

  test("entries take their folder's visibility", () => {
    const folder = notebook.createFolder("partner", { name: "Plans", visibility: "hidden" });
    partnerMakes({ name: "Ambush", folderId: folder.id });
    expect(notebook.listEntries("user")).toEqual([]);
    expect(notebook.listFolders("user")).toEqual([]);
  });

  test("the owner can reveal an entry", () => {
    const secret = partnerMakes({ name: "The Stranger", visibility: "hidden" });
    notebook.updateEntrySettings("partner", secret.id, { visibility: "visible" });
    expect(notebook.getEntry("user", secret.id).name).toBe("The Stranger");
  });
});

describe("editing", () => {
  test("open entries of your partner's are yours to edit directly", () => {
    const ilse = make({ name: "Ilse", owner: "partner" });
    expect(notebook.editEntry("user", ilse.id, { name: "Ilse Marrow" })).toMatchObject({ entry: { name: "Ilse Marrow" } });
  });

  test("suggest-only entries turn your edit into a suggestion", () => {
    const ilse = partnerMakes({ name: "Ilse", editing: "suggest" });
    const result = notebook.editEntry("user", ilse.id, { name: "Ilse Marrow" });
    expect(result).toMatchObject({ suggestion: { author: "user", change: { name: "Ilse Marrow" }, status: "pending" } });
    expect(notebook.getEntry("user", ilse.id).name).toBe("Ilse");
  });

  test("locked entries can't be changed by the other person", () => {
    const ilse = partnerMakes({ name: "Ilse", editing: "locked" });
    expect(() => notebook.editEntry("user", ilse.id, { name: "X" })).toThrow(PermissionError);
    expect(notebook.getEntry("user", ilse.id).access).toEqual({ edit: "none", settings: false, delete: false });
  });

  test("only the owner changes an entry's settings", () => {
    const ilse = make({ name: "Ilse", owner: "partner" });
    expect(() => notebook.updateEntrySettings("user", ilse.id, { editing: "locked" })).toThrow(PermissionError);
    expect(notebook.updateEntrySettings("partner", ilse.id, { editing: "locked" }).settings.editing).toBe("locked");
  });

  test("the owner can give an entry away, and then it's out of their hands", () => {
    const kit = make({ name: "Kit" });
    expect(notebook.updateEntrySettings("user", kit.id, { owner: "partner" }).owner).toBe("partner");
    expect(() => notebook.updateEntrySettings("user", kit.id, { owner: "user" })).toThrow(PermissionError);
  });

  test("shared lore's settings are fixed", () => {
    const sea = make({ name: "The Sea", kind: "lore", owner: "joint" });
    expect(() => notebook.updateEntrySettings("user", sea.id, { visibility: "hidden" })).toThrow(/fixed/);
  });
});

describe("suggestions", () => {
  test("shared lore: whoever didn't suggest a change reviews it", () => {
    const sea = make({ name: "The Sea", kind: "lore", owner: "joint" });
    const { suggestion } = notebook.editEntry("partner", sea.id, { name: "The Charted Sea" }) as { suggestion: { id: string } };

    expect(() => notebook.reviewSuggestion("partner", suggestion.id, "accepted")).toThrow(PermissionError);
    notebook.reviewSuggestion("user", suggestion.id, "accepted");
    expect(notebook.getEntry("user", sea.id).name).toBe("The Charted Sea");
    expect(notebook.listSuggestions("user")).toEqual([]);
  });

  test("a rejected suggestion changes nothing, and can't be reviewed twice", () => {
    const sea = make({ name: "The Sea", kind: "lore", owner: "joint" });
    const { suggestion } = notebook.editEntry("partner", sea.id, { name: "X" }) as { suggestion: { id: string } };
    notebook.reviewSuggestion("user", suggestion.id, "rejected");
    expect(notebook.getEntry("user", sea.id).name).toBe("The Sea");
    expect(() => notebook.reviewSuggestion("user", suggestion.id, "accepted")).toThrow(/already been dealt with/);
  });

  test("only whoever made a suggestion can withdraw it", () => {
    const sea = make({ name: "The Sea", kind: "lore", owner: "joint" });
    const { suggestion } = notebook.editEntry("user", sea.id, { name: "X" }) as { suggestion: { id: string } };
    expect(() => notebook.withdrawSuggestion("partner", suggestion.id)).toThrow(PermissionError);
    notebook.withdrawSuggestion("user", suggestion.id);
    expect(notebook.listSuggestions("user")).toEqual([]);
  });
});

describe("deleting", () => {
  test("you delete your own entries straight away", () => {
    const kit = make({ name: "Kit" });
    expect(notebook.deleteEntry("user", kit.id)).toEqual({ deleted: true });
    expect(notebook.listEntries("user")).toEqual([]);
  });

  test("your partner's entries can't be deleted by you, only unpinned", () => {
    const ilse = make({ name: "Ilse", owner: "partner" });
    expect(() => notebook.deleteEntry("user", ilse.id)).toThrow(/unpin it instead/);
  });

  test("your partner never deletes directly, only suggests it", () => {
    const kit = make({ name: "Kit", editing: "suggest" });
    const result = notebook.deleteEntry("partner", kit.id);
    expect(result).toMatchObject({ suggestion: { change: { delete: true } } });
    expect(() => notebook.deleteEntry("partner", make({ name: "Jun" }).id)).toThrow(/only suggest deleting/);

    // Accepting the suggestion deletes it.
    notebook.reviewSuggestion("user", (result as { suggestion: { id: string } }).suggestion.id, "accepted");
    expect(notebook.listEntries("user").map((e) => e.name)).toEqual(["Jun"]);
  });

  test("deleting shared lore is a suggestion", () => {
    const sea = make({ name: "The Sea", kind: "lore", owner: "joint" });
    expect(notebook.deleteEntry("user", sea.id)).toMatchObject({ suggestion: { change: { delete: true } } });
  });
});

describe("folders", () => {
  test("deleting a folder keeps its entries", () => {
    const folder = notebook.createFolder("user", { name: "Old" });
    const kit = make({ name: "Kit", folderId: folder.id });
    notebook.deleteFolder("user", folder.id);
    expect(notebook.getEntry("user", kit.id).folderId).toBeNull();
  });

  test("only the folder's owner changes it", () => {
    const folder = notebook.createFolder("partner", { name: "Theirs" });
    expect(() => notebook.updateFolder("user", folder.id, { name: "Mine" })).toThrow(PermissionError);
    expect(() => notebook.deleteFolder("user", folder.id)).toThrow(PermissionError);
  });
});

describe("proxy prefixes", () => {
  test("are only for your characters, and can't be shared between them", () => {
    make({ name: "Kestrel", proxyPrefix: "k" });
    expect(() => make({ name: "Kit", proxyPrefix: "K" })).toThrow(/already uses the prefix/);
    expect(() => make({ name: "Ilse", owner: "partner", proxyPrefix: "i" })).toThrow(/Only your own characters/);
    expect(() => make({ name: "Jun", proxyPrefix: "j j" })).toThrow(/no spaces or colons/);
  });

  test("are dropped when a character is given away", () => {
    const kestrel = make({ name: "Kestrel", proxyPrefix: "k" });
    expect(notebook.updateEntrySettings("user", kestrel.id, { owner: "partner" }).proxyPrefix).toBeNull();
  });
});

describe("the cast", () => {
  test("is the pinned entries, in the order they were pinned, with who plays each", () => {
    const ilse = make({ name: "Ilse", owner: "partner" });
    const kit = make({ name: "Kit" });
    notebook.pin("user", story, kit.id);
    notebook.pin("user", story, ilse.id);
    notebook.pin("user", story, kit.id); // already pinned: no change
    expect(notebook.castFor("user", story).map((c) => [c.name, c.playedBy])).toEqual([
      ["Kit", "user"],
      ["Ilse", "partner"],
    ]);
  });

  test("shows entries hidden from you as ??? (hidden), and you can still unpin them", () => {
    const stranger = partnerMakes({ name: "The Stranger", visibility: "hidden" });
    notebook.pin("partner", story, stranger.id);
    expect(notebook.castFor("user", story)).toEqual([
      { entryId: stranger.id, name: HIDDEN_NAME, playedBy: "partner", owner: "partner", hidden: true, proxyPrefix: null, kind: "character" },
    ]);
    expect(notebook.castFor("partner", story)[0]!.name).toBe("The Stranger");

    // You can't pin what you can't see, but you can unpin it.
    expect(() => notebook.pin("user", story, stranger.id)).toThrow(NotFoundError);
    notebook.unpin("user", story, stranger.id);
    expect(notebook.castFor("user", story)).toEqual([]);
  });

  test("deleting an entry unpins it everywhere", () => {
    const kit = make({ name: "Kit" });
    notebook.pin("user", story, kit.id);
    notebook.deleteEntry("user", kit.id);
    expect(notebook.castFor("user", story)).toEqual([]);
  });
});

describe("what your partner's prompt gets", () => {
  test("pinned entries they can see, marked if they're hidden from you", () => {
    const stranger = partnerMakes({ name: "The Stranger", visibility: "hidden" });
    const twist = make({ name: "My Twist", kind: "lore", visibility: "hidden" });
    const ilse = make({ name: "Ilse", owner: "partner" });
    for (const entry of [stranger, twist, ilse]) store.db.query("INSERT INTO channel_cast VALUES (?, ?, 0)").run(story, entry.id);

    const { pinned } = notebook.forPrompt(story);
    expect(pinned.map((p) => [p.entry.name, p.hiddenFromUser])).toEqual([
      ["Ilse", false],
      ["The Stranger", true],
    ]);
  });

  test("entries linked from pinned ones, one step deep", () => {
    const sea = make({ name: "The Sea", kind: "lore", fields: [{ label: "Summary", value: "Home of [[The Wreck]]." }] });
    make({ name: "The Wreck", kind: "lore", fields: [{ label: "Summary", value: "Near [[The Reef]]." }] });
    make({ name: "The Reef", kind: "lore" });
    const ilse = make({ name: "Ilse", owner: "partner", systemPrompt: "She fears [[the sea|the water]]. [[Nobody]]" });
    notebook.pin("user", story, ilse.id);
    notebook.pin("user", story, sea.id);

    const { pinned, linked } = notebook.forPrompt(story);
    expect(pinned.map((p) => p.entry.name)).toEqual(["Ilse", "The Sea"]);
    // The Sea is already pinned, so only The Wreck is added; The Reef is two steps away.
    expect(linked.map((p) => p.entry.name)).toEqual(["The Wreck"]);
  });

  test("links never reveal what's hidden from your partner", () => {
    make({ name: "My Twist", kind: "lore", visibility: "hidden" });
    const ilse = make({ name: "Ilse", owner: "partner", systemPrompt: "See [[My Twist]]." });
    notebook.pin("user", story, ilse.id);
    expect(notebook.forPrompt(story).linked).toEqual([]);
  });

  test("the OOC overview has everything they can see", () => {
    make({ name: "My Twist", visibility: "hidden" });
    partnerMakes({ name: "The Stranger", visibility: "hidden" });
    expect(notebook.partnerOverview().map((p) => [p.entry.name, p.hiddenFromUser])).toEqual([["The Stranger", true]]);
  });
});

describe("linkedNames", () => {
  test("finds [[Name]] and [[Name|shown text]] links, once each", () => {
    const entry = { systemPrompt: "[[A]] and [[B|bee]]", fields: [{ label: "x", value: "[[A]], [[ C ]]" }] };
    expect(linkedNames(entry)).toEqual(["A", "B", "C"]);
  });
});

describe("parseSheet", () => {
  test("reads labelled lines into fields, taking out the name", () => {
    expect(parseSheet("Name: Ilse Marrow\nAge: 34\nAppearance: Tall,\nwind-weathered.")).toEqual({
      name: "Ilse Marrow",
      fields: [
        { label: "Age", value: "34" },
        { label: "Appearance", value: "Tall,\nwind-weathered." },
      ],
    });
  });

  test("keeps text before the first label, or after the name, as Notes", () => {
    expect(parseSheet("A smuggler.\nAge: 40")).toEqual({
      name: null,
      fields: [
        { label: "Notes", value: "A smuggler." },
        { label: "Age", value: "40" },
      ],
    });
    expect(parseSheet("Name: Vee\nA getaway driver.").fields).toEqual([{ label: "Notes", value: "A getaway driver." }]);
  });

  test("keeps paragraph breaks inside a field, and drops empty fields", () => {
    expect(parseSheet("Background: One.\n\nTwo.\n\n\n\nSpeech:").fields).toEqual([{ label: "Background", value: "One.\n\nTwo." }]);
  });
});
