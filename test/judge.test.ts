/**
 * Tests for Jev's double-checks (src/judge.ts) where they're used: comment
 * replies, deleting and editing entries, scene summaries, channel mentions,
 * and picking a wake-up's channel.
 *
 * Jev's replies are queued on `fake.jevReplies`; with none queued, Jev
 * answers everything 50/50 (unsure), which always takes the safe path.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createApp, type App } from "../src/server.ts";
import { validateSettings } from "../src/store.ts";
import { STRICT_NOTE } from "../src/summarizer.ts";
import { Wakeups } from "../src/wakeups.ts";
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
  app.store.close();
  fake.stop();
  dir.cleanup();
});

const settings = (update: Record<string, unknown>) => app.store.updateSettings(validateSettings(update));

/** Jev answering every phrasing of a series (`id~0`, `id~1`) the same. */
function series(id: string, p: number, count = 2, extra: Record<string, object> = {}) {
  const answers: Record<string, object> = { ...extra };
  for (let i = 0; i < count; i++) answers[`${id}~${i}`] = { choice: p >= 0.5 ? "yes" : "no", probabilities: { yes: p, no: 1 - p } };
  return { content: JSON.stringify({ answers }) };
}

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

describe("comment replies", () => {
  test("a comment on your own message that asks something gets a reply", async () => {
    const m = app.store.addMessage({ channelId: story.id, author: "user", content: "Kestrel draws her knife." });
    fake.jevReplies.push(series("reply", 0.95));
    fake.replies.push({ content: "Not too much at all, it fits her." });
    const { data } = await call("POST", `/api/messages/${m.id}/comments`, { quote: "draws her knife", note: "Arlo, is this too much?" });
    expect(data.thread.comments.map((c: any) => c.author)).toEqual(["user", "partner"]);
    expect(fake.jevRequests[0]!.messages[0]!.content).toContain("is this too much?");
  });

  test("a note to yourself gets none (and unsure means none)", async () => {
    const m = app.store.addMessage({ channelId: story.id, author: "user", content: "Kestrel draws her knife." });
    fake.jevReplies.push(series("reply", 0.1));
    const first = await call("POST", `/api/messages/${m.id}/comments`, { quote: "knife", note: "check the knife's name later" });
    expect(first.data.thread.comments).toHaveLength(1);
    const second = await call("POST", `/api/messages/${m.id}/comments`, { quote: "draws", note: "hmm" }); // unsure
    expect(second.data.thread.comments).toHaveLength(1);
    expect(fake.requests).toHaveLength(0);
  });

  test("with checks off, it's as before: no Jev, no reply", async () => {
    settings({ jevChecks: false });
    const m = app.store.addMessage({ channelId: story.id, author: "user", content: "Hi" });
    await call("POST", `/api/messages/${m.id}/comments`, { quote: "Hi", note: "Arlo?" });
    expect(fake.jevRequests).toHaveLength(0);
  });
});

describe("your partner deleting an entry", () => {
  const deleting = { toolCalls: [{ name: "delete_notebook_entry", arguments: { name: "Old Idea" } }] };

  test("held back unless Jev confirms it's wanted", async () => {
    app.store.notebook.createEntry("partner", { kind: "lore", name: "Old Idea" });
    app.store.addMessage({ channelId: ooc.id, author: "user", content: "how's your day?" });
    fake.replies.push(deleting, { content: "Good!" });
    const result = await app.partner.takeTurn(ooc.id, "user-message");
    expect(result.toolCalls[0]).toMatchObject({ status: "error" });
    expect(result.toolCalls[0]!.summary).toContain("Held back");
    expect(app.store.notebook.listEntries("partner").some((e) => e.name === "Old Idea")).toBe(true);
  });

  test("deleted when Jev confirms", async () => {
    app.store.notebook.createEntry("partner", { kind: "lore", name: "Old Idea" });
    app.store.addMessage({ channelId: ooc.id, author: "user", content: "please delete Old Idea, it's a duplicate" });
    fake.jevReplies.push(series("delete", 0.97));
    fake.replies.push(deleting, { content: "Done." });
    const result = await app.partner.takeTurn(ooc.id, "user-message");
    expect(result.toolCalls[0]).toMatchObject({ status: "ok", summary: "deleted Old Idea" });
  });

  test("without Jev, as before", async () => {
    settings({ decisionModel: "" });
    app.store.notebook.createEntry("partner", { kind: "lore", name: "Old Idea" });
    fake.replies.push(deleting, { content: "Done." });
    const result = await app.partner.takeTurn(ooc.id, "continue");
    expect(result.toolCalls[0]).toMatchObject({ status: "ok" });
  });
});

describe("your partner editing your entries", () => {
  const editing = { toolCalls: [{ name: "edit_notebook_entry", arguments: { name: "Kestrel", fields: { Age: "29" } } }] };

  test("on their own idea, it's a suggestion", async () => {
    const kestrel = app.store.notebook.createEntry("user", { kind: "character", name: "Kestrel" }); // open to edit
    app.store.addMessage({ channelId: ooc.id, author: "user", content: "what do you think Kestrel's like?" });
    fake.replies.push(editing, { content: "I think she's 29." });
    const result = await app.partner.takeTurn(ooc.id, "user-message");
    expect(result.toolCalls[0]!.summary).toBe("suggested a change to Kestrel");
    expect(app.store.notebook.waitingFor("user").map((s) => s.entryId)).toEqual([kestrel.id]);
  });

  test("when you asked, it's made directly", async () => {
    const kestrel = app.store.notebook.createEntry("user", { kind: "character", name: "Kestrel" });
    app.store.addMessage({ channelId: ooc.id, author: "user", content: "can you set Kestrel's age to 29?" });
    fake.jevReplies.push(series("asked", 0.96));
    fake.replies.push(editing, { content: "Done." });
    const result = await app.partner.takeTurn(ooc.id, "user-message");
    expect(result.toolCalls[0]!.summary).toBe("edited Kestrel");
    expect(app.store.notebook.getEntry("user", kestrel.id).fields.find((f) => f.label === "Age")!.value).toBe("29");
  });
});

describe("scene summaries", () => {
  function scene() {
    app.store.addMessage({ channelId: story.id, author: "user", content: "Kestrel knocks." });
    app.store.addMessage({ channelId: story.id, author: "partner", content: "Ilse lets her in." });
    app.store.addSceneBreak(story.id, "user", "Dawn");
  }

  test("an unfaithful one is rewritten once, more strictly", async () => {
    scene();
    fake.jevReplies.push(series("faithful", 0.05));
    fake.replies.push({ content: "Kestrel knocks; a dragon attacks." }, { content: "Kestrel knocks and Ilse lets her in." });
    await app.summarizer.catchUp(story.id);
    const summaries = app.summarizer.view(story.id);
    expect(Object.values(summaries.scenes)[0]!.content).toBe("Kestrel knocks and Ilse lets her in.");
    expect(fake.requests[1]!.messages[0]!.content).toContain(STRICT_NOTE);
  });

  test("a faithful (or unsure) one is kept", async () => {
    scene();
    fake.replies.push({ content: "Kestrel knocks and Ilse lets her in." });
    await app.summarizer.catchUp(story.id);
    expect(Object.values(app.summarizer.view(story.id).scenes)[0]!.content).toBe("Kestrel knocks and Ilse lets her in.");
    expect(fake.requests[1]!.messages[0]!.content).not.toContain(STRICT_NOTE);
  });
});

describe("channel mentions in OOC", () => {
  function remember() {
    app.store.summaries.save(story.id, "story", "", "Kestrel found the lighthouse.", 1);
  }

  test("a bare word Jev says isn't about the channel leaves its summary out", async () => {
    remember();
    app.store.addMessage({ channelId: ooc.id, author: "user", content: "I read a great story on the bus today" });
    fake.jevReplies.push(series(story.id, 0.05));
    await app.partner.takeTurn(ooc.id, "user-message");
    expect(fake.requests[0]!.messages[0]!.content).not.toContain("About #story");
  });

  test("#story is always about the channel, without asking", async () => {
    remember();
    app.store.addMessage({ channelId: ooc.id, author: "user", content: "what did you think of #story so far?" });
    await app.partner.takeTurn(ooc.id, "user-message");
    expect(fake.jevRequests).toHaveLength(0);
    expect(fake.requests[0]!.messages[0]!.content).toContain("About #story");
  });

  test("unsure keeps it in, and the answer is remembered for a regeneration", async () => {
    remember();
    app.store.addMessage({ channelId: ooc.id, author: "user", content: "that story is getting good" });
    const first = await app.partner.takeTurn(ooc.id, "user-message");
    expect(fake.requests[0]!.messages[0]!.content).toContain("About #story");
    await app.partner.takeTurn(ooc.id, "regenerate", { replacing: first.messages.map((m) => m.id) });
    expect(fake.jevRequests).toHaveLength(1);
  });
});

describe("a wake-up's channel", () => {
  test("with several OOC channels, Jev picks where it fits", async () => {
    const chat = app.store.createChannel({ name: "chat", kind: "ooc" });
    const now = new Date();
    app.store.addMessage({ channelId: ooc.id, author: "user", content: "bye!", createdAt: new Date(now.getTime() - 6 * 3_600_000).toISOString() });
    const wakeups = new Wakeups(app.store, app.partner, app.decider, true, () => now);
    fake.jevReplies.push(series("x", 0.9, 0, { reach: { choice: "yes", probabilities: { yes: 0.95, no: 0.05 } }, channel: { choice: "chat", probabilities: { ooc: 0.05, chat: 0.95 } } }));
    fake.replies.push({ content: "Welcome back!" });
    const result = await wakeups.event("opened");
    expect(result.outcome).toBe("posted");
    expect(result.messages[0]!.channelId).toBe(chat.id);
    expect(Object.keys(fake.jevRequests[0]!.response_format.questions)).toEqual(["reach", "channel"]);
  });
});
