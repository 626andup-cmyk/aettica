/**
 * Tests for the reference library: src/library.ts, its tools, how it
 * reaches the prompt, and the API.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cueName, ftsQuery, headingOf, PASSAGE_TARGET, splitPassages } from "../src/library.ts";
import { promptForChannel } from "../src/partner.ts";
import { createApp, type App } from "../src/server.ts";
import { runTool, toolSpecs } from "../src/tools.ts";
import type { Channel } from "../src/types.ts";
import { startFakeNanoGpt, tempDir, testConfig, type FakeNanoGpt } from "./helpers.ts";

/** A small screenplay, in the usual format. */
const SCRIPT = `THE LIGHTHOUSE

FADE IN:

EXT. CLIFFTOP LIGHTHOUSE - NIGHT

Rain lashes the tower. A lamp turns overhead.

KESTREL, soaked to the bone, hammers on the door.

                    KESTREL
          Open up! Please, the storm's
          getting worse.

The door creaks. ILSE MARROW, 60s, peers out with a lantern.

                    ILSE
          Nobody comes here. Not since the
          bell drowned.

INT. LAMP ROOM - LATER

Ilse winds the great clockwork. Kestrel drips on the floor, wrapped in a towel.

                    KESTREL (CONT'D)
          What happened to the bell?

                    ILSE
          The sea took it. The sea takes
          everything, eventually.

CUT TO:

EXT. BEACH - DAWN

The storm has passed. Kestrel walks the tideline and finds a rusted clapper half-buried in the sand.

                    KESTREL (V.O.)
          She never told me why she stayed.

THE END`;

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
  app.store.close();
  fake.stop();
  dir.cleanup();
});

async function call(method: string, path: string, body?: unknown) {
  const response = await app.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  return { status: response.status, data: (await response.json()) as any };
}

const addScript = (extra: Record<string, unknown> = {}) =>
  app.store.library.add({ title: "The Lighthouse", description: "The film's screenplay", content: SCRIPT, ...extra });

describe("splitting", () => {
  test("headings and character cues", () => {
    expect(headingOf("EXT. CLIFFTOP LIGHTHOUSE - NIGHT")).toBe("EXT. CLIFFTOP LIGHTHOUSE - NIGHT");
    expect(headingOf("INT./EXT. CAR - DAY")).toBe("INT./EXT. CAR - DAY");
    expect(headingOf("## Chapter Two")).toBe("Chapter Two");
    expect(headingOf("Chapter 12: The Bell")).toBe("Chapter 12: The Bell");
    expect(headingOf("Kestrel walks the tideline.")).toBeNull();
    expect(cueName("                    KESTREL")).toBe("KESTREL");
    expect(cueName("KESTREL (CONT'D)")).toBe("KESTREL");
    expect(cueName("KESTREL (V.O.)")).toBe("KESTREL");
    expect(cueName("CUT TO:")).toBeNull();
    expect(cueName("She said so.")).toBeNull();
  });

  test("a script splits at scene headings once a passage has enough, with speakers", () => {
    // Pad each scene so it's worth a passage of its own.
    const padded = SCRIPT.replace(/(Rain lashes the tower\.)/, `$1 ${"The wind howls. ".repeat(20)}`).replace(
      /(Ilse winds the great clockwork\.)/,
      `$1 ${"Gears tick. ".repeat(30)}`,
    );
    const passages = splitPassages(padded);
    expect(passages.length).toBe(3);
    expect(passages.map((p) => p.heading)).toEqual(["EXT. CLIFFTOP LIGHTHOUSE - NIGHT", "INT. LAMP ROOM - LATER", "EXT. BEACH - DAWN"]);
    expect(passages[0]!.speakers).toEqual(["KESTREL", "ILSE"]);
    expect(passages[2]!.speakers).toEqual(["KESTREL"]);
    expect(passages.map((p) => p.seq)).toEqual([1, 2, 3]);
    // Nothing is lost.
    expect(passages.map((p) => p.content).join(" ")).toContain("THE END");
  });

  test("long plain text is split near the target size, at sentences", () => {
    const text = Array.from({ length: 400 }, (_, i) => `Sentence number ${i} is here.`).join(" ");
    const passages = splitPassages(text);
    expect(passages.length).toBeGreaterThan(5);
    for (const p of passages) {
      expect(p.content.length).toBeLessThanOrEqual(2400);
      expect(p.content.endsWith(".")).toBe(true);
    }
    expect(passages[0]!.content.length).toBeGreaterThan(PASSAGE_TARGET * 0.8);
  });

  test("text with no punctuation at all still splits", () => {
    const passages = splitPassages("word ".repeat(3000));
    expect(passages.length).toBeGreaterThan(3);
    expect(passages.every((p) => p.content.length <= 2400)).toBe(true);
  });
});

describe("searching", () => {
  test("queries: phrases, stopwords, and nothing left", () => {
    expect(ftsQuery('what happened to "the bell"')).toBe('"the bell" OR "happened"');
    expect(ftsQuery("the of and")).toBeNull();
    expect(ftsQuery("Ilse's lamp")).toBe('"Ilses" OR "lamp"');
    // FTS5's own syntax is never passed through: every term is quoted.
    expect(ftsQuery('NEAR(lamp* NOT -bell) "(*)"')).toBe('"NEAR" OR "lamp" OR "NOT" OR "bell"');
  });

  test("finds passages, stemmed, with a snippet", () => {
    const doc = addScript();
    const hits = app.store.library.search("drowning bells");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]).toMatchObject({ docId: doc.id, title: "The Lighthouse" });
    expect(hits[0]!.snippet).toContain("«bell»");
  });

  test("speakers rank first", () => {
    const text = [
      "INT. HALL - DAY",
      "A painting of Ilse hangs on the wall. " + "Dust everywhere. ".repeat(40),
      "INT. KITCHEN - DAY",
      "          ILSE\n     Tea?",
    ].join("\n\n");
    const doc = app.store.library.add({ title: "Two scenes", content: text });
    const hits = app.store.library.search("Ilse", [doc.id]);
    expect(hits[0]!.heading).toBe("INT. KITCHEN - DAY");
  });

  test("only in the documents asked for", () => {
    addScript();
    const other = app.store.library.add({ title: "Other", content: "Nothing about lighthouses here, only bells." });
    expect(app.store.library.search("bell", [other.id]).every((h) => h.docId === other.id)).toBe(true);
    expect(app.store.library.search("bell", [])).toEqual([]);
  });

  test("deleting a document forgets it, from the index too", () => {
    const doc = addScript();
    addScript({ title: "Copy" });
    app.store.library.remove(doc.id);
    const hits = app.store.library.search("bell");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.title === "Copy")).toBe(true);
  });
});

describe("documents", () => {
  test("adding checks the input", () => {
    expect(() => app.store.library.add({ title: "", content: "x" })).toThrow();
    expect(() => app.store.library.add({ title: "Empty", content: "   " })).toThrow();
    expect(() => app.store.library.add({ title: "Bad", content: "x", channelIds: ["nope"] })).toThrow();
    expect(() => app.store.library.add({ title: "Binary", content: "a\u0000b" })).toThrow();
  });

  test("channels: limited documents show only there, and always in OOC", () => {
    addScript({ channelIds: [story.id] });
    const other = app.store.createChannel({ name: "other", kind: "rp" });
    expect(app.store.library.forChannel(story)).toHaveLength(1);
    expect(app.store.library.forChannel(ooc)).toHaveLength(1);
    expect(app.store.library.forChannel(other)).toHaveLength(0);
  });

  test("deleting a channel takes it off documents limited to it", () => {
    const doc = addScript({ channelIds: [story.id] });
    app.store.deleteChannel(story.id);
    expect(app.store.library.get(doc.id).channelIds).toEqual([]);
  });

  test("reading passages", () => {
    const doc = addScript();
    const [first] = app.store.library.passages(doc.id, 1);
    expect(first!.content).toContain("Rain lashes");
    expect(app.store.library.passages(doc.id, 999)).toEqual([]);
  });
});

describe("tools", () => {
  const ctx = () => ({ store: app.store, channel: story, mode: "post" as const });
  const names = () => toolSpecs(ctx()).map((t) => t.function.name);

  test("offered only when the library has something for the channel", () => {
    expect(names()).not.toContain("search_library");
    addScript();
    expect(names()).toContain("search_library");
    expect(names()).toContain("read_library");
  });

  test("search, then read", () => {
    addScript();
    const search = runTool(ctx(), "search_library", { query: "drowned bell" });
    expect(search.ok).toBe(true);
    const first = (search.result as any).results[0];
    expect(first).toMatchObject({ document: "The Lighthouse" });
    expect(search.summary).toBe('searched "The Lighthouse" for "drowned bell"');

    const read = runTool(ctx(), "read_library", { document: "lighthouse", passage: first.passage, count: "2" });
    expect(read.ok).toBe(true);
    expect(JSON.stringify(read.result)).toContain("bell drowned");
  });

  test("mistakes are explained", () => {
    addScript();
    const unknown = runTool(ctx(), "read_library", { document: "Hamlet", passage: 1 });
    expect(unknown.ok).toBe(false);
    expect(JSON.stringify(unknown.result)).toContain("The Lighthouse");
    const outOfRange = runTool(ctx(), "read_library", { document: "The Lighthouse", passage: 50 });
    expect(JSON.stringify(outOfRange.result)).toContain("passages 1 to");
    const nothing = runTool(ctx(), "search_library", { query: "spaceship" });
    expect((nothing.result as any).results).toEqual([]);
  });
});

describe("the prompt", () => {
  test("lists the library with tools, never its text", () => {
    addScript();
    const withTools = JSON.stringify(promptForChannel(app.store, story.id, { profile: app.store.profiles.list()[0] }));
    expect(withTools).toContain("Reference library");
    expect(withTools).toContain("The film's screenplay");
    expect(withTools).not.toContain("Rain lashes");
    const without = JSON.stringify(
      promptForChannel(app.store, story.id, { profile: { ...app.store.profiles.list()[0]!, supportsTools: false } }),
    );
    expect(without).not.toContain("Reference library");
  });
});

describe("the API", () => {
  test("add, list, search, read, edit, delete", async () => {
    const added = await call("POST", "/api/library", { title: "The Lighthouse", content: SCRIPT });
    expect(added.status).toBe(200);
    const id = added.data.document.id;
    expect((await call("GET", "/api/library")).data.documents).toHaveLength(1);
    const search = await call("GET", `/api/library/search?q=${encodeURIComponent("clapper")}`);
    expect(search.data.results[0].snippet).toContain("«clapper»");
    const read = await call("GET", `/api/library/${id}/passages/1?count=2`);
    expect(read.data.passages[0].seq).toBe(1);
    const edited = await call("PATCH", `/api/library/${id}`, { description: "Draft 3", channelIds: [ooc.id] });
    expect(edited.data.document).toMatchObject({ description: "Draft 3", channelIds: [ooc.id] });
    expect((await call("DELETE", `/api/library/${id}`, {})).status).toBe(200);
    expect((await call("GET", `/api/library/${id}/passages/1`)).status).toBe(404);
  });

  test("bad input", async () => {
    expect((await call("POST", "/api/library", { title: "x" })).status).toBe(400);
    expect((await call("GET", "/api/library/nope/passages/abc")).status).toBe(400);
  });
});
