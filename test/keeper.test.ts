/**
 * Tests for the notebook keeper (src/keeper.ts) and Jev series (src/jev.ts).
 *
 * Jev's answers and the writer's drafts are queued on the fake nanoGPT in
 * order: detect (Jev), draft (writer), check (Jev).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { agree, seriesQuestions, seriesVerdicts, type Answer } from "../src/jev.ts";
import { mergeFields, readChanges, replaceFields, verifySeries, type KeeperChange } from "../src/keeper.ts";
import { createApp, type App } from "../src/server.ts";
import { validateSettings } from "../src/store.ts";
import type { Channel } from "../src/types.ts";
import { startFakeNanoGpt, tempDir, testConfig, type FakeNanoGpt } from "./helpers.ts";

let fake: FakeNanoGpt;
let dir: ReturnType<typeof tempDir>;
let app: App;
let story: Channel;
let ooc: Channel;

beforeEach(() => {
  fake = startFakeNanoGpt();
  dir = tempDir();
  app = createApp(testConfig(dir.path, fake.baseUrl));
  [story, ooc] = app.store.listChannels() as [Channel, Channel];
});

afterEach(() => {
  app.summarizer.stop();
  app.keeper.stop();
  app.store.close();
  fake.stop();
  dir.cleanup();
});

const JEV = "typesafe/jev-1.13";
const yes = (p = 0.95) => ({ choice: "yes", probabilities: { yes: p, no: 1 - p } });
const no = (p = 0.05) => ({ choice: "no", probabilities: { yes: p, no: 1 - p } });

/** A Jev reply answering each id. */
function jev(answers: Record<string, object>) {
  return { content: JSON.stringify({ answers }) };
}

/** Jev's step 1: new, facts, changed. */
const detect = (newYes: boolean, factsYes: boolean, changedYes = false) =>
  jev({
    "new~0": newYes ? yes() : no(),
    "new~1": newYes ? yes() : no(),
    "facts~0": factsYes ? yes() : no(),
    "facts~1": factsYes ? yes() : no(),
    "changed~0": changedYes ? yes() : no(),
    "changed~1": changedYes ? yes() : no(),
  });

/** The writer's draft. */
const draft = (changes: object[]) => ({ content: JSON.stringify({ changes }) });

/** Jev's step 3: every phrasing of each change, yes or no. */
function check(...verdicts: (boolean | boolean[])[]) {
  const answers: Record<string, object> = {};
  verdicts.forEach((v, i) => {
    const each = Array.isArray(v) ? v : [v, v, v];
    each.forEach((ok, j) => (answers[`c${i}~${j}`] = ok ? yes() : no()));
  });
  return jev(answers);
}

function posts(count: number, text = (i: number) => `Post ${i}`) {
  for (let i = 1; i <= count; i++) {
    app.store.addMessage({ channelId: story.id, author: i % 2 ? "user" : "partner", content: text(i) });
  }
}

const settings = (update: Record<string, unknown>) => app.store.updateSettings(validateSettings(update));
const entry = (name: string) => app.store.notebook.listEntries("user").find((e) => e.name === name);

describe("Jev series", () => {
  const answer = (p: number): Answer => ({ id: "x", selected: p >= 0.5 ? "yes" : "no", probabilities: { yes: p, no: 1 - p }, confidence: Math.max(p, 1 - p) });

  test("every phrasing must agree", () => {
    expect(agree([answer(0.95), answer(0.9)], 0.8)).toBe("yes");
    expect(agree([answer(0.95), answer(0.6)], 0.8)).toBe("unsure");
    expect(agree([answer(0.95), answer(0.1)], 0.8)).toBe("unsure");
    expect(agree([answer(0.05), answer(0.1)], 0.8)).toBe("no");
    expect(agree([answer(0.95), undefined], 0.8)).toBe("unsure");
    expect(agree([], 0.8)).toBe("unsure");
  });

  test("questions and verdicts", () => {
    const series = [{ id: "a", phrasings: ["one?", "two?"] }];
    expect(seriesQuestions(series).map((q) => q.id)).toEqual(["a~0", "a~1"]);
    const answers = new Map([
      ["a~0", answer(0.9)],
      ["a~1", answer(0.85)],
    ]);
    expect(seriesVerdicts(series, answers, 0.8).get("a")).toEqual({ verdict: "yes", yes: [0.9, 0.85] });
  });
});

describe("pieces", () => {
  test("reading the writer's draft forgivingly", () => {
    const changes = readChanges(
      'Sure! ```json\n{"changes": [{"action": "create", "kind": "lore", "name": "The Drowned Bell", "fields": [{"label": "Summary", "value": "A bell lost to the sea."}], "claim": "A bell was lost to the sea."}, {"action": "add", "entry": "Ilse", "fields": [], "claim": "x"}, {"action": "create", "name": "No claim"}]}\n```',
    );
    expect(changes).toEqual([
      { action: "create", kind: "lore", name: "The Drowned Bell", fields: [{ label: "Summary", value: "A bell lost to the sea." }], claim: "A bell was lost to the sea." },
    ]);
    expect(readChanges("no JSON here")).toEqual([]);
  });

  test("merging notes into fields", () => {
    const fields = [
      { label: "Age", value: "" },
      { label: "Background", value: "Keeps the lighthouse" },
    ];
    expect(
      mergeFields(fields, [
        { label: "age", value: "60s" },
        { label: "Background", value: "Had a brother, lost at sea." },
        { label: "Fears", value: "Bells" },
      ]),
    ).toEqual([
      { label: "Age", value: "60s" },
      { label: "Background", value: "Keeps the lighthouse. Had a brother, lost at sea." },
      { label: "Fears", value: "Bells" },
    ]);
    // Nothing new: nothing to do.
    expect(mergeFields(fields, [{ label: "Background", value: "keeps the lighthouse" }])).toBeNull();
  });

  test("replacing notes that are now wrong", () => {
    const fields = [{ label: "Age", value: "60s" }];
    expect(replaceFields(fields, [{ label: "Age", value: "34" }])).toEqual([{ label: "Age", value: "34" }]);
    expect(replaceFields(fields, [{ label: "Age", value: "60s" }])).toBeNull();
    expect(readChanges('{"changes": [{"action": "replace", "entry": "Ilse", "fields": [{"label": "Age", "value": "34"}], "claim": "She is 34."}]}')[0]!.action).toBe("replace");
  });

  test("a new entry is checked three ways, a note two", () => {
    const create: KeeperChange = { action: "create", kind: "character", name: "Tamsin", fields: [], claim: "Tamsin is the ferryman." };
    expect(verifySeries(create, 0).phrasings).toHaveLength(3);
    expect(verifySeries({ action: "add", entry: "Ilse", fields: [], claim: "x" }, 1)).toMatchObject({ id: "c1" });
  });
});

describe("the keeper", () => {
  test("waits for enough posts", async () => {
    posts(3);
    expect((await app.keeper.catchUp(story.id)).outcome).toBe("not-due");
    expect(fake.jevRequests).toHaveLength(0);
  });

  test("a scene ending counts, however few posts", async () => {
    posts(2);
    app.store.addSceneBreak(story.id, "user", "Dawn");
    fake.jevReplies.push(detect(false, false));
    expect((await app.keeper.catchUp(story.id)).outcome).toBe("nothing");
    expect(fake.jevRequests).toHaveLength(1);
  });

  test("usually nothing: one Jev call, and the posts count as read", async () => {
    posts(6);
    fake.jevReplies.push(detect(false, false));
    const result = await app.keeper.catchUp(story.id);
    expect(result.outcome).toBe("nothing");
    expect(fake.jevRequests.map((r) => r.model)).toEqual([JEV]);
    expect(fake.requests).toHaveLength(0);
    // Read: the same posts don't set it off again.
    expect((await app.keeper.catchUp(story.id)).outcome).toBe("not-due");
  });

  test("phrasings that disagree mean unsure: nothing is written", async () => {
    posts(6);
    fake.jevReplies.push(jev({ "new~0": yes(), "new~1": no(0.4), "facts~0": no(), "facts~1": no(), "changed~0": no(), "changed~1": no() }));
    expect((await app.keeper.catchUp(story.id)).outcome).toBe("unsure");
    expect(fake.requests).toHaveLength(0);
  });

  test("a new character: detected, drafted, checked, added as shared", async () => {
    posts(6, (i) => (i === 3 ? "A man steps off the ferry. \"Name's Tamsin,\" he says. \"I row the dead across.\"" : `Post ${i}`));
    fake.jevReplies.push(detect(true, false), check(true));
    fake.replies.push(
      draft([
        {
          action: "create",
          kind: "character",
          name: "Tamsin",
          fields: [{ label: "Background", value: "Rows the dead across on the ferry." }],
          claim: "A man named Tamsin arrived on the ferry and says he rows the dead across.",
        },
      ]),
    );
    const result = await app.keeper.catchUp(story.id);
    expect(result).toMatchObject({ outcome: "applied", applied: ["added Tamsin to the notebook"] });
    const tamsin = entry("Tamsin")!;
    expect(tamsin).toMatchObject({ owner: "joint", kind: "character" });
    expect(tamsin.fields.find((f) => f.label === "Background")!.value).toBe("Rows the dead across on the ferry.");
    // Jev twice, the writer once.
    expect(fake.jevRequests).toHaveLength(2);
    expect(fake.requests).toHaveLength(1);
    // The check reads the messages only, and asks each thing three ways.
    const checkRequest = JSON.stringify(fake.jevRequests[1]);
    expect(checkRequest).toContain("rows the dead across");
    expect(Object.keys(fake.jevRequests[1]!.response_format.questions)).toEqual(["c0~0", "c0~1", "c0~2"]);
    // It shows in the channel as your partner's action.
    const calls = app.store.toolLog.forChannel(story.id);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ name: "notebook_keeper", source: "keeper", summary: "added Tamsin to the notebook" });
  });

  test("claims Jev doesn't confirm are dropped", async () => {
    posts(6);
    fake.jevReplies.push(detect(true, true), check(true, [true, false, true]));
    fake.replies.push(
      draft([
        { action: "create", kind: "lore", name: "The Drowned Bell", fields: [{ label: "Summary", value: "Lost" }], claim: "A bell drowned." },
        { action: "create", kind: "character", name: "Imagined", fields: [], claim: "Someone made up." },
      ]),
    );
    const result = await app.keeper.catchUp(story.id);
    expect(result.applied).toEqual(["added The Drowned Bell to the notebook"]);
    expect(result.dropped[0]).toContain("Imagined");
    expect(entry("Imagined")).toBeUndefined();
  });

  test("notes on an existing entry: direct on your partner's, a suggestion on a suggest-only one of yours", async () => {
    const ilse = app.store.notebook.listEntries("user").find((e) => e.name === "Ilse Marrow")!;
    const kestrel = app.store.notebook.createEntry("user", { kind: "character", name: "Kestrel", editing: "suggest" });
    posts(6, (i) => (i === 2 ? "Ilse: \"My brother drowned with the bell.\" Kestrel shows her scarred hands." : `Post ${i}`));
    fake.jevReplies.push(detect(false, true), check(true, true));
    fake.replies.push(
      draft([
        { action: "add", entry: "Ilse Marrow", fields: [{ label: "Background", value: "Her brother drowned with the bell." }], claim: "Ilse's brother drowned with the bell." },
        { action: "add", entry: "Kestrel", fields: [{ label: "Appearance", value: "Scarred hands." }], claim: "Kestrel has scarred hands." },
      ]),
    );
    const result = await app.keeper.catchUp(story.id);
    expect(result.applied).toEqual(["noted in Ilse Marrow: Background", "suggested notes for Kestrel"]);
    expect(app.store.notebook.getEntry("user", ilse.id).fields.find((f) => f.label === "Background")!.value).toContain("brother drowned");
    expect(app.store.notebook.waitingFor("user").map((s) => s.entryId)).toEqual([kestrel.id]);
    // The writer saw Ilse's notes (she's mentioned).
    expect(fake.requests[0]!.messages.at(-1)!.content).toContain("Ilse Marrow (character):");
  });

  test("a contradiction corrects the note, rather than adding to it", async () => {
    const ilse = app.store.notebook.listEntries("user").find((e) => e.name === "Ilse Marrow")!;
    app.store.notebook.editEntry("partner", ilse.id, { fields: [...ilse.fields.filter((f) => f.label !== "Age"), { label: "Age", value: "60s" }] });
    posts(6, (i) => (i === 2 ? "Ilse laughs. \"I'm thirty-four, not sixty. The lamp ages everyone.\"" : `Post ${i}`));
    fake.jevReplies.push(detect(false, false, true), check(true));
    fake.replies.push(draft([{ action: "replace", entry: "Ilse Marrow", fields: [{ label: "Age", value: "34" }], claim: "Ilse says she is thirty-four." }]));
    const result = await app.keeper.catchUp(story.id);
    expect(result.applied).toEqual(["corrected Ilse Marrow: Age"]);
    expect(app.store.notebook.getEntry("user", ilse.id).fields.find((f) => f.label === "Age")!.value).toBe("34");
    // Jev saw the notes it contradicts.
    expect(fake.jevRequests[0]!.messages[0]!.content).toContain("Age: 60s");
  });

  test("your own entries only ever get suggestions from the keeper", async () => {
    const kestrel = app.store.notebook.createEntry("user", { kind: "character", name: "Kestrel" }); // open for editing
    posts(6, () => "Kestrel shows her scarred hands.");
    fake.jevReplies.push(detect(false, true), check(true));
    fake.replies.push(draft([{ action: "add", entry: "Kestrel", fields: [{ label: "Appearance", value: "Scarred hands." }], claim: "Kestrel has scarred hands." }]));
    const result = await app.keeper.catchUp(story.id);
    expect(result.applied).toEqual(["suggested notes for Kestrel"]);
    expect(app.store.notebook.waitingFor("user").map((s) => s.entryId)).toEqual([kestrel.id]);
  });

  test("never shows the writer an entry hidden from you", async () => {
    app.store.notebook.createEntry("partner", { kind: "lore", name: "The Secret", visibility: "hidden", fields: [{ label: "Summary", value: "Ilse pushed him." }] });
    posts(6, () => "The Secret is mentioned.");
    fake.jevReplies.push(detect(true, true));
    fake.replies.push(draft([]));
    await app.keeper.catchUp(story.id);
    const sent = JSON.stringify([...fake.requests, ...fake.jevRequests]);
    expect(sent).not.toContain("Ilse pushed him");
    expect(sent).not.toContain("The Secret (lore)");
  });

  test("only roleplay channels; off when turned off or Jev is off", async () => {
    for (let i = 0; i < 8; i++) app.store.addMessage({ channelId: ooc.id, author: "user", content: `ooc ${i}` });
    expect((await app.keeper.catchUp(ooc.id)).outcome).toBe("off");
    posts(8);
    settings({ notebookKeeper: false });
    expect((await app.keeper.catchUp(story.id)).outcome).toBe("off");
    settings({ notebookKeeper: true, decisionModel: "" });
    expect((await app.keeper.catchUp(story.id)).outcome).toBe("off");
    expect(fake.requests.length + fake.jevRequests.length).toBe(0);
  });

  test("a failed call is reported, and the posts are read again next time", async () => {
    posts(6);
    fake.jevReplies.push({ status: 500, error: "down" });
    expect((await app.keeper.catchUp(story.id)).outcome).toBe("failed");
    fake.jevReplies.push(detect(false, false));
    expect((await app.keeper.catchUp(story.id)).outcome).toBe("nothing");
  });

  test("settings are checked", () => {
    expect(() => validateSettings({ keeperEvery: 1 })).toThrow();
    expect(() => validateSettings({ notebookKeeper: "yes" })).toThrow();
    expect(validateSettings({ keeperEvery: 10, notebookKeeper: false })).toEqual({ keeperEvery: 10, notebookKeeper: false });
  });
});
