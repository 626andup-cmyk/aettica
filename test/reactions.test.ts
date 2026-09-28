/**
 * Tests for emoji reactions and custom emojis: src/reactions.ts, the
 * `react_to_message` tool, the prompt's "Reactions", and the API.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { describeReactions } from "../src/prompt.ts";
import { promptForChannel } from "../src/partner.ts";
import { isEmoji, MAX_REACTIONS_EACH } from "../src/reactions.ts";
import { createApp, type App } from "../src/server.ts";
import { runTool } from "../src/tools.ts";
import type { Channel, Message } from "../src/types.ts";
import { startFakeNanoGpt, tempDir, testConfig, type FakeNanoGpt } from "./helpers.ts";

/** A 1×1 PNG. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

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
  const text = await response.text();
  return { status: response.status, data: (text.startsWith("{") ? JSON.parse(text) : text) as any, response };
}

const say = (content: string, author: "user" | "partner" = "user", channel = ooc) =>
  app.store.addMessage({ channelId: channel.id, author, content });
const reload = (message: Message) => app.store.getMessage(message.id);

describe("emojis", () => {
  test("what counts as one emoji", () => {
    for (const ok of ["👍", "❤️", "😂", "👩🏽‍💻", "🇯🇵", "1️⃣", "🏳️‍🌈"]) expect(isEmoji(ok)).toBe(true);
    for (const bad of ["", "a", "👍👍", "ok 👍", ":)", "<b>"]) expect(isEmoji(bad)).toBe(false);
  });
});

describe("reactions", () => {
  test("add, once each, in order; take back; both of you", () => {
    const m = say("guess what, I got a puppy");
    app.store.reactions.add(m.id, "user", "❤️");
    app.store.reactions.add(m.id, "user", "❤️");
    app.store.reactions.add(m.id, "partner", "❤️");
    app.store.reactions.add(m.id, "partner", " 🎉 ");
    expect(reload(m).reactions).toEqual([
      { emoji: "❤️", author: "user" },
      { emoji: "❤️", author: "partner" },
      { emoji: "🎉", author: "partner" },
    ]);
    app.store.reactions.toggle(m.id, "user", "❤️");
    expect(reload(m).reactions).toHaveLength(2);
  });

  test("checked: not text, and not too many", () => {
    const m = say("hi");
    expect(() => app.store.reactions.add(m.id, "user", "lol")).toThrow();
    expect(() => app.store.reactions.add(m.id, "user", ":nope:")).toThrow();
    const many = ["😀", "😁", "😂", "🤣", "😃", "😄", "😅"];
    for (const e of many.slice(0, MAX_REACTIONS_EACH)) app.store.reactions.add(m.id, "user", e);
    expect(() => app.store.reactions.add(m.id, "user", many[MAX_REACTIONS_EACH])).toThrow();
  });

  test("they change the revision (so the app notices), and go with their message", () => {
    const m = say("hi");
    const before = app.store.revision;
    app.store.reactions.add(m.id, "partner", "👋");
    expect(app.store.revision).toBeGreaterThan(before);
    app.store.deleteMessage(m.id);
    expect(app.store.reactions.forMessage(m.id)).toEqual([]);
  });
});

describe("custom emojis", () => {
  test("add, use, replace, delete (taking their reactions)", () => {
    const blob = app.store.reactions.addEmoji(":Blob_Wave:", Buffer.from(PNG, "base64"));
    expect(blob.name).toBe("blob_wave");
    expect(blob.file).toMatch(/^blob_wave-[a-z0-9]+\.png$/);
    const m = say("hello");
    app.store.reactions.add(m.id, "user", ":blob_wave:");
    const again = app.store.reactions.addEmoji("blob_wave", Buffer.from(PNG, "base64"));
    expect(app.store.reactions.listEmojis()).toHaveLength(1);
    expect(app.store.reactions.serve(again.file)!.headers.get("Content-Type")).toBe("image/png");
    expect(app.store.reactions.serve(blob.file)).toBeNull(); // the old image is gone
    app.store.reactions.removeEmoji("blob_wave");
    expect(reload(m).reactions).toEqual([]);
  });

  test("only small images with simple names", () => {
    const png = Buffer.from(PNG, "base64");
    expect(() => app.store.reactions.addEmoji("a", png)).toThrow();
    expect(() => app.store.reactions.addEmoji("has space", png)).toThrow();
    expect(() => app.store.reactions.addEmoji("svg", Buffer.from("<svg></svg>"))).toThrow();
    expect(() => app.store.reactions.addEmoji("big", Buffer.concat([png, Buffer.alloc(600 * 1024)]))).toThrow();
    expect(app.store.reactions.serve("../aettica.db")).toBeNull();
  });
});

describe("your partner", () => {
  const ctx = (channel = ooc) => ({ store: app.store, channel, mode: "post" as const });

  test("reacts to your latest message, or the one quoted", () => {
    const first = say("I finished the lighthouse chapter");
    say("It's alright", "partner");
    const latest = say("also I adopted a cat");
    const r1 = runTool(ctx(), "react_to_message", { emoji: "😻" });
    expect(r1).toMatchObject({ ok: true, summary: 'reacted 😻 to "also I adopted a cat"' });
    expect(reload(latest).reactions).toEqual([{ emoji: "😻", author: "partner" }]);
    runTool(ctx(), "react_to_message", { emoji: "🎉", quote: "lighthouse chapter" });
    expect(reload(first).reactions).toEqual([{ emoji: "🎉", author: "partner" }]);
  });

  test("mistakes are explained, with the custom emojis there are", () => {
    app.store.reactions.addEmoji("blob_wave", Buffer.from(PNG, "base64"));
    say("hi");
    const bad = runTool(ctx(), "react_to_message", { emoji: "wave" });
    expect(bad.ok).toBe(false);
    expect(JSON.stringify(bad.result)).toContain(":blob_wave:");
    expect(runTool(ctx(), "react_to_message", { emoji: ":blob_wave:" }).ok).toBe(true);
    expect(runTool(ctx(story), "react_to_message", { emoji: "👍" }).ok).toBe(false); // nothing of yours there
  });

  test("sees reactions in the prompt, and its custom emojis with tools", () => {
    const mine = say("*Arlo grins* want to try a heist story next?", "partner");
    const yours = say("YES");
    app.store.reactions.add(mine.id, "user", "❤️");
    app.store.reactions.add(mine.id, "user", "🔥");
    app.store.reactions.add(yours.id, "partner", "😂");
    app.store.reactions.addEmoji("blob_wave", Buffer.from(PNG, "base64"));
    const profile = app.store.profiles.list()[0]!;
    const text = promptForChannel(app.store, ooc.id, { profile })[0]!.content;
    expect(text).toContain('The user reacted ❤️ 🔥 to your message: "*Arlo grins* want to try a heist story next?"');
    expect(text).toContain('You reacted 😂 to the user\'s message: "YES"');
    expect(text).toContain(":blob_wave:");
    const without = promptForChannel(app.store, ooc.id, { profile: { ...profile, supportsTools: false } })[0]!.content;
    expect(without).toContain("The user reacted ❤️ 🔥");
    expect(without).not.toContain(":blob_wave:");
  });

  test("nothing to say, nothing in the prompt", () => {
    expect(describeReactions([], [])).toBeNull();
  });
});

describe("the API", () => {
  test("toggle your reaction", async () => {
    const m = say("hi");
    const on = await call("POST", `/api/messages/${m.id}/reactions`, { emoji: "👋" });
    expect(on.data.reactions).toEqual([{ emoji: "👋", author: "user" }]);
    const off = await call("POST", `/api/messages/${m.id}/reactions`, { emoji: "👋" });
    expect(off.data.reactions).toEqual([]);
    expect((await call("POST", `/api/messages/${m.id}/reactions`, { emoji: "nope" })).status).toBe(400);
    expect((await call("POST", `/api/messages/missing/reactions`, { emoji: "👋" })).status).toBe(404);
    // Messages come with their reactions.
    await call("POST", `/api/messages/${m.id}/reactions`, { emoji: "👋" });
    const { data } = await call("GET", `/api/channels/${ooc.id}/messages`);
    expect(data.messages.at(-1).reactions).toEqual([{ emoji: "👋", author: "user" }]);
  });

  test("custom emojis: add, list in state, serve, delete", async () => {
    const added = await call("POST", "/api/emojis", { name: "blob_wave", data: PNG });
    expect(added.status).toBe(200);
    const file = added.data.emoji.file;
    expect((await call("GET", "/api/state")).data.emojis).toHaveLength(1);
    const image = await app.fetch(new Request(`http://localhost/emojis/${file}`));
    expect(image.status).toBe(200);
    expect(image.headers.get("Content-Type")).toBe("image/png");
    expect((await call("DELETE", "/api/emojis/blob_wave", {})).data.emojis).toEqual([]);
    expect((await app.fetch(new Request(`http://localhost/emojis/${file}`))).status).toBe(404);
    expect((await call("POST", "/api/emojis", { name: "x" })).status).toBe(400);
  });
});
