/**
 * Tests for summaries (stage 7): src/summaries.ts, src/summarizer.ts, and
 * how they reach the prompt, the tools and the API.
 *
 * The summarizer runs against a fake nanoGPT (see helpers.ts), and only
 * when a test asks (`app.summarizer.catchUp`), so every request is known.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promptForChannel } from "../src/partner.ts";
import { createApp, type App } from "../src/server.ts";
import { DIGEST_EVERY } from "../src/summarizer.ts";
import {
  chunkLines,
  cleanSummary,
  splitScenes,
  transcript,
  windowStart,
  type SeqMessage,
} from "../src/summaries.ts";
import { validateSettings } from "../src/store.ts";
import { runTool } from "../src/tools.ts";
import type { Channel, ChatMessage, Message } from "../src/types.ts";
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

/** Add posts to a channel, alternating you and your partner. */
function posts(channel: Channel, count: number, label = "Post") {
  for (let i = 1; i <= count; i++) {
    app.store.addMessage({ channelId: channel.id, author: i % 2 ? "user" : "partner", content: `${label} ${i}` });
  }
}

/** What each summary request was for, from its instructions. */
function jobs(): string[] {
  return fake.requests.map((r) => {
    const system = r.messages[0]!.content;
    if (system.includes('"the story so far"')) return "story";
    if (system.includes("Summarize one scene")) return "scene";
    if (system.includes("the scene so far")) return "current";
    if (system.includes("out-of-character conversation between")) return "conversation";
    if (system.startsWith("Describe")) return "digest";
    return "other";
  });
}

function settings(update: Record<string, unknown>) {
  app.store.updateSettings(validateSettings(update));
}

function prompt(channel: Channel): ChatMessage[] {
  return promptForChannel(app.store, channel.id);
}

// ------------------------------------------------------------- pure parts

describe("splitScenes and windowStart", () => {
  const seq = (list: Partial<Message>[]): SeqMessage[] =>
    list.map((m, i) => ({
      id: m.id ?? `m${i}`,
      channelId: "c",
      kind: m.kind ?? "post",
      author: "user",
      content: m.content ?? "",
      mode: null,
      turnId: null,
      characters: [],
      attachments: [],
      createdAt: "",
      seq: i + 1,
    })) as SeqMessage[];

  test("a channel splits into scenes at its breaks; OOC is one conversation", () => {
    const messages = seq([{}, {}, { kind: "scene_break", id: "b1" }, {}, { kind: "scene_break", id: "b2" }]);
    const scenes = splitScenes(messages, "rp");
    expect(scenes.map((s) => [s.start?.id ?? null, s.end?.id ?? null, s.posts.length])).toEqual([
      [null, "b1", 2],
      ["b1", "b2", 1],
      ["b2", null, 0],
    ]);
    expect(splitScenes(messages, "ooc")).toHaveLength(1);
  });

  test("off: the newest historyLimit messages, as before", () => {
    const messages = seq(Array.from({ length: 10 }, () => ({})));
    expect(windowStart(messages, "rp", { historyLimit: 4, summaryEvery: 2, enabled: false, current: null })).toBe(6);
  });

  test("a long scene with nothing summarized yet is sent whole, up to historyLimit + 2 × summaryEvery", () => {
    const messages = seq(Array.from({ length: 7 }, () => ({})));
    expect(windowStart(messages, "rp", { historyLimit: 4, summaryEvery: 2, enabled: true, current: null })).toBe(0);
    const longer = seq(Array.from({ length: 12 }, () => ({})));
    expect(windowStart(longer, "rp", { historyLimit: 4, summaryEvery: 2, enabled: true, current: null })).toBe(4);
  });

  test("a short current scene: the newest historyLimit, reaching into the scene before", () => {
    const messages = seq([{}, {}, {}, {}, { kind: "scene_break", id: "b" }, {}]);
    expect(windowStart(messages, "rp", { historyLimit: 4, summaryEvery: 2, enabled: true, current: null })).toBe(2);
  });

  test("with 'earlier in this scene': everything after what it covers", () => {
    const messages = seq([{}, { kind: "scene_break", id: "b" }, {}, {}, {}, {}, {}]);
    const current = { sceneId: "b", throughSeq: 5, stale: false } as any;
    expect(windowStart(messages, "rp", { historyLimit: 1, summaryEvery: 10, enabled: true, current })).toBe(5);
    // Notes for another scene (or out of date) don't count.
    expect(windowStart(messages, "rp", { historyLimit: 1, summaryEvery: 10, enabled: true, current: { ...current, sceneId: "" } })).toBe(1);
  });

  test("transcripts say who's speaking, and chunks keep lines whole", () => {
    const [post, sceneBreak] = seq([{ content: " Hi " }, { kind: "scene_break", content: "Night" }]);
    expect(transcript([post!, sceneBreak!], "rp", "Arlo")).toEqual(["The user (narration): Hi", '--- Scene break: "Night" ---']);
    expect(transcript([{ ...post!, author: "partner", characters: ["Ilse"] }], "rp", "Arlo")).toEqual(["Ilse: Hi"]);
    expect(transcript([{ ...post!, author: "partner" }], "ooc", "Arlo")).toEqual(["You (Arlo): Hi"]);
    expect(chunkLines(["aaaa", "bbbb", "cccc"], 10)).toEqual(["aaaa\n\nbbbb", "cccc"]);
    expect(cleanSummary('Summary: "They met."')).toBe("They met.");
  });
});

// ----------------------------------------------------------- the summarizer

describe("the summarizer", () => {
  test("a finished scene gets a summary, the story so far, and the digest", async () => {
    posts(story, 3);
    app.store.addSceneBreak(story.id, "user", "Night");
    fake.replies.push({ content: "Scene one summary." }, { content: "Story so far." }, { content: "Short digest." });
    await app.summarizer.catchUp(story.id);

    expect(jobs()).toEqual(["scene", "story", "digest"]);
    const view = app.summarizer.view(story.id);
    expect(Object.values(view.scenes).map((s) => s.content)).toEqual(["Scene one summary."]);
    expect(view.story?.content).toBe("Story so far.");
    expect(view.digest?.content).toBe("Short digest.");
    expect(fake.requests[0]!.messages[1]!.content).toContain("The user (narration): Post 1");
    // Nothing more is due.
    await app.summarizer.catchUp(story.id);
    expect(fake.requests).toHaveLength(3);
  });

  test("summaries never see the notebook, so a secret hidden from you can't reach one", async () => {
    app.store.notebook.createEntry("partner", {
      kind: "lore",
      owner: "partner",
      name: "The Drowned Bell",
      visibility: "hidden",
      fields: [{ label: "Summary", value: "Ilse rang it herself" }],
    });
    posts(story, 2);
    app.store.addSceneBreak(story.id, "user", "");
    await app.summarizer.catchUp(story.id);
    expect(fake.requests.length).toBeGreaterThan(0);
    expect(JSON.stringify(fake.requests)).not.toContain("Ilse rang it herself");
  });

  test("the story so far is folded forward from each new scene, not rewritten", async () => {
    posts(story, 2);
    app.store.addSceneBreak(story.id, "user", "Two");
    await app.summarizer.catchUp(story.id);
    fake.requests.length = 0;
    posts(story, 2, "Later");
    app.store.addSceneBreak(story.id, "user", "Three");
    fake.replies.push({ content: "Scene two." }, { content: "Story, updated." });
    await app.summarizer.catchUp(story.id);

    expect(jobs().slice(0, 2)).toEqual(["scene", "story"]);
    const storyRequest = fake.requests[1]!.messages[1]!.content;
    expect(storyRequest).toContain("Your notes so far"); // the old story
    expect(storyRequest).toContain('Scene 2, "Two": Scene two.'); // only the new scene
    expect(storyRequest).not.toContain("Scene 1");
    expect(app.summarizer.view(story.id).story?.content).toBe("Story, updated.");
  });

  test("a long scene is folded into 'earlier in this scene' every summaryEvery messages, leaving historyLimit in full", async () => {
    settings({ historyLimit: 4, summaryEvery: 3 });
    posts(story, 6);
    await app.summarizer.catchUp(story.id);
    expect(jobs()).not.toContain("current"); // 6 < 4 + 3: all still sent in full
    expect(prompt(story).filter((m) => m.role !== "system").map((m) => m.content).join(" ")).toContain("Post 1");

    posts(story, 1, "More");
    fake.replies.push({ content: "Earlier: the first three posts." });
    await app.summarizer.catchUp(story.id);
    expect(jobs()).toContain("current");
    const request = fake.requests.find((_, i) => jobs()[i] === "current")!.messages[1]!.content;
    expect(request).toContain("Post 3");
    expect(request).not.toContain("Post 4");

    const messages = prompt(story);
    expect(messages[0]!.content).toContain("## Earlier in this scene\n\nEarlier: the first three posts.");
    const history = messages.slice(1).map((m) => m.content).join(" ");
    expect(history).not.toContain("Post 3");
    expect(history).toContain("Post 4");
    expect(history).toContain("More 1");
  });

  test("the scene's notes are the start of its summary when it ends, so it's never read twice", async () => {
    settings({ historyLimit: 2, summaryEvery: 2 });
    posts(story, 4);
    fake.replies.push({ content: "Notes on posts one and two." });
    await app.summarizer.catchUp(story.id);
    app.store.addSceneBreak(story.id, "user", "");
    fake.requests.length = 0;
    await app.summarizer.catchUp(story.id);
    const sceneRequest = fake.requests[0]!.messages[1]!.content;
    expect(sceneRequest).toContain("Notes on posts one and two.");
    expect(sceneRequest).not.toContain("Post 1");
    expect(sceneRequest).toContain("Post 3");
    expect(app.summarizer.view(story.id).current).toBeNull();
  });

  test("OOC conversations are folded too, from your partner's point of view", async () => {
    settings({ historyLimit: 2, summaryEvery: 2 });
    posts(ooc, 5);
    await app.summarizer.catchUp(ooc.id);
    expect(jobs()).toEqual(["conversation", "digest"]);
    expect(fake.requests[0]!.messages[1]!.content).toContain("You (Arlo): Post 2");
    expect(prompt(ooc)[0]!.content).toContain("## Earlier in this conversation");
  });

  test("editing or deleting a summarized message rewrites what covered it", async () => {
    posts(story, 2);
    const { sceneBreak } = app.store.addSceneBreak(story.id, "user", "");
    await app.summarizer.catchUp(story.id);
    const first = app.store.getMessages(story.id)[0]!;
    app.store.editMessage(first.id, "Post 1, edited");
    const view = app.summarizer.view(story.id);
    expect(view.scenes[sceneBreak.id]!.stale).toBe(true);
    expect(view.story!.stale).toBe(true);

    fake.requests.length = 0;
    await app.summarizer.catchUp(story.id);
    expect(jobs()).toEqual(["scene", "story", "digest"]);
    expect(fake.requests[0]!.messages[1]!.content).toContain("Post 1, edited");
    expect(fake.requests[1]!.messages[1]!.content).not.toContain("Your notes so far"); // rebuilt
  });

  test("deleting a scene break merges its scenes", async () => {
    posts(story, 1);
    const first = app.store.addSceneBreak(story.id, "user", "").sceneBreak;
    posts(story, 1, "Second");
    const second = app.store.addSceneBreak(story.id, "user", "").sceneBreak;
    await app.summarizer.catchUp(story.id);
    app.store.deleteMessage(first.id);
    const view = app.summarizer.view(story.id);
    expect(view.scenes[first.id]).toBeUndefined();
    expect(view.scenes[second.id]!.stale).toBe(true);
    fake.requests.length = 0;
    await app.summarizer.catchUp(story.id);
    expect(fake.requests[0]!.messages[1]!.content).toContain("Post 1");
    expect(fake.requests[0]!.messages[1]!.content).toContain("Second 1");
  });

  test("your own words are kept; Rebuild replaces them", async () => {
    posts(story, 2);
    const { sceneBreak } = app.store.addSceneBreak(story.id, "user", "");
    await app.summarizer.catchUp(story.id);
    const edited = await call("PUT", `/api/channels/${story.id}/summaries`, { kind: "scene", sceneId: sceneBreak.id, content: "My words." });
    expect(edited.data.summaries.scenes[sceneBreak.id]).toMatchObject({ content: "My words.", edited: true });

    fake.requests.length = 0;
    await app.summarizer.catchUp(story.id);
    // The story is rewritten with your words, but your words stay.
    expect(jobs()).toContain("story");
    expect(fake.requests.find((_, i) => jobs()[i] === "story")!.messages[1]!.content).toContain("My words.");
    expect(app.summarizer.view(story.id).scenes[sceneBreak.id]!.content).toBe("My words.");

    fake.replies.push({ content: "The model's words." });
    await call("POST", `/api/channels/${story.id}/summaries/rebuild`, {});
    expect(app.summarizer.view(story.id).scenes[sceneBreak.id]).toMatchObject({ content: "The model's words.", edited: false });
  });

  test("a new digest once the channel has moved on", async () => {
    posts(story, 1);
    await app.summarizer.catchUp(story.id);
    expect(jobs()).toEqual(["digest"]);
    posts(story, DIGEST_EVERY - 1);
    await app.summarizer.catchUp(story.id);
    expect(jobs()).toEqual(["digest"]);
    posts(story, 1);
    await app.summarizer.catchUp(story.id);
    expect(jobs()).toEqual(["digest", "digest"]);
  });

  test("a failure is kept and shown, and the next try picks up where it stopped", async () => {
    posts(story, 1);
    app.store.addSceneBreak(story.id, "user", "");
    fake.replies.push({ status: 500, error: "upstream down" });
    await app.summarizer.catchUp(story.id);
    expect(app.summarizer.view(story.id)).toMatchObject({ error: expect.stringContaining("upstream down"), story: null });
    await app.summarizer.catchUp(story.id);
    expect(app.summarizer.view(story.id)).toMatchObject({ error: null, story: expect.anything() });
  });

  test("off: nothing is written", async () => {
    settings({ summaries: false });
    posts(story, 2);
    app.store.addSceneBreak(story.id, "user", "");
    await app.summarizer.catchUp(story.id);
    expect(fake.requests).toHaveLength(0);
  });

  test("summaries are written by their own profile when one is chosen", async () => {
    const cheap = app.store.profiles.create({ name: "Cheap", model: "cheap/model" });
    settings({ summaryAssignment: `profile:${cheap.id}` });
    posts(story, 1);
    await app.summarizer.catchUp(story.id);
    expect(fake.requests[0]!.model).toBe("cheap/model");
  });

  test("changes set off a catch-up a little later", async () => {
    app.summarizer.stop();
    app.store.close();
    app = createApp(testConfig(dir.path, fake.baseUrl, { summaryDelayMs: 20 }));
    [story] = app.store.listChannels() as [Channel];
    posts(story, 1);
    await Bun.sleep(150);
    expect(jobs()).toEqual(["digest"]);
  });
});

// -------------------------------------------------------- prompt and tools

describe("summaries in the prompt", () => {
  test("RP: the story so far and the last scenes, for what isn't sent in full", async () => {
    settings({ historyLimit: 2 });
    posts(story, 2, "One");
    app.store.addSceneBreak(story.id, "user", "Two");
    posts(story, 2, "Two");
    app.store.addSceneBreak(story.id, "user", "Three");
    posts(story, 2, "Three");
    fake.replies.push({ content: "Scene one." }, { content: "Scene two." }, { content: "The story." }, { content: "Digest." });
    await app.summarizer.catchUp(story.id);

    const system = prompt(story)[0]!.content;
    expect(system).toContain("## The story so far\n\nThe story.");
    expect(system).toContain('## Recent scenes\n\nScene 1: Scene one.\n\nScene 2, "Two": Scene two.');
    expect(system.indexOf("## The story so far")).toBeGreaterThan(system.indexOf("## Style"));
  });

  test("nothing is summarized that's all still in the recent messages", async () => {
    posts(story, 2);
    app.store.addSceneBreak(story.id, "user", "");
    await app.summarizer.catchUp(story.id);
    const system = prompt(story)[0]!.content;
    expect(system).not.toContain("## The story so far");
    expect(system).not.toContain("## Recent scenes");
  });

  test("OOC: every channel's digest, and the fuller summary of one that comes up", async () => {
    posts(story, 2);
    app.store.addSceneBreak(story.id, "user", "");
    fake.replies.push({ content: "Scene." }, { content: "Ilse and Kestrel, a storm." }, { content: "At the lighthouse; tense." });
    await app.summarizer.catchUp(story.id);

    let system = prompt(ooc)[0]!.content;
    expect(system).toContain("- #story: roleplay, you play Ilse Marrow. At the lighthouse; tense.");
    expect(system).not.toContain("## About #story");

    app.store.addMessage({ channelId: ooc.id, author: "user", content: "How's #story going for you?" });
    system = prompt(ooc)[0]!.content;
    expect(system).toContain("## About #story\n\nThe story so far: Ilse and Kestrel, a storm.");
    // By name, as a word, works too.
    app.store.addMessage({ channelId: ooc.id, author: "user", content: "I keep thinking about the story" });
    expect(prompt(ooc)[0]!.content).toContain("## About #story");
  });

  test("read_channel_summary gives your partner a channel's summaries", async () => {
    const empty = runTool({ store: app.store, channel: ooc, mode: "post" }, "read_channel_summary", { channel: "#story" });
    expect(empty.result).toMatchObject({ summary: null });
    posts(story, 2);
    app.store.addSceneBreak(story.id, "user", "");
    fake.replies.push({ content: "Scene." }, { content: "The story." }, { content: "Digest." });
    await app.summarizer.catchUp(story.id);
    const outcome = runTool({ store: app.store, channel: ooc, mode: "post" }, "read_channel_summary", { channel: "#story" });
    expect(outcome).toMatchObject({ ok: true, summary: "read the summary of #story" });
    expect((outcome.result as { summary: string }).summary).toContain("In short: Digest.");
  });
});

// ----------------------------------------------------------------- the API

describe("summaries API", () => {
  test("messages come with their channel's summaries", async () => {
    const { data } = await call("GET", `/api/channels/${story.id}/messages`);
    expect(data.summaries).toMatchObject({ scenes: {}, story: null, running: false, error: null });
  });

  test("your own story so far; empty text lets it be written again", async () => {
    const saved = await call("PUT", `/api/channels/${story.id}/summaries`, { kind: "story", content: " Mine. " });
    expect(saved.data.summaries.story).toMatchObject({ content: "Mine.", edited: true });
    const cleared = await call("PUT", `/api/channels/${story.id}/summaries`, { kind: "story", content: "" });
    expect(cleared.data.summaries.story).toBeNull();
  });

  test("bad requests are refused", async () => {
    expect((await call("PUT", `/api/channels/${story.id}/summaries`, { kind: "digest", content: "x" })).status).toBe(400);
    const post = app.store.addMessage({ channelId: story.id, author: "user", content: "hi" });
    expect((await call("PUT", `/api/channels/${story.id}/summaries`, { kind: "scene", sceneId: post.id, content: "x" })).status).toBe(400);
    expect((await call("GET", `/api/channels/nope/summaries`)).status).toBe(404);
  });

  test("Update now, and rewriting one scene", async () => {
    posts(story, 2);
    const { sceneBreak } = app.store.addSceneBreak(story.id, "user", "");
    const updated = await call("POST", `/api/channels/${story.id}/summaries/update`, {});
    expect(Object.keys(updated.data.summaries.scenes)).toEqual([sceneBreak.id]);
    fake.replies.push({ content: "Fresh scene." });
    const rewritten = await call("POST", `/api/channels/${story.id}/summaries/scenes/${sceneBreak.id}/regenerate`, {});
    expect(rewritten.data.summaries.scenes[sceneBreak.id].content).toBe("Fresh scene.");
  });

  test("settings: summaries on or off, how often, and who writes them", () => {
    expect(validateSettings({ summaries: false, summaryEvery: 10, summaryAssignment: "" })).toEqual({
      summaries: false,
      summaryEvery: 10,
      summaryAssignment: "",
    });
    expect(() => validateSettings({ summaryEvery: 1 })).toThrow(/summaryEvery/);
    expect(() => validateSettings({ summaries: "yes" })).toThrow(/summaries/);
    expect(app.store.getSettings()).toMatchObject({ summaries: true, summaryEvery: 20, summaryAssignment: "" });
  });

  test("clearing a channel's messages clears its summaries", async () => {
    posts(story, 1);
    await app.summarizer.catchUp(story.id);
    expect(app.store.summaries.all(story.id)).toHaveLength(1);
    app.store.clearMessages(story.id);
    expect(app.store.summaries.all(story.id)).toHaveLength(0);
  });
});
