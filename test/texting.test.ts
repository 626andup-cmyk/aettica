/**
 * Tests for texting in OOC (src/texting.ts) and RNG partner creation
 * (src/rng.ts).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promptForChannel } from "../src/partner.ts";
import { toChatHistory } from "../src/prompt.ts";
import { describeSeeds, rollSeeds } from "../src/rng.ts";
import { createApp, type App } from "../src/server.ts";
import { validateSettings } from "../src/store.ts";
import { BUBBLE_MARKER, splitTexts, TEXTING_STYLE } from "../src/texting.ts";
import type { Channel, Message } from "../src/types.ts";
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

describe("splitting texts", () => {
  test("at the marker, forgivingly", () => {
    expect(splitTexts("omg wait<cht>you said that??<cht>legend")).toEqual(["omg wait", "you said that??", "legend"]);
    expect(splitTexts("a < CHT > b </cht> c <cht/>")).toEqual(["a", "b", "c"]);
    expect(splitTexts("just one")).toEqual(["just one"]);
    expect(splitTexts("<cht>")).toEqual([]);
  });
});

describe("your partner texting", () => {
  test("a reply becomes several messages, one turn", async () => {
    app.store.addMessage({ channelId: ooc.id, author: "user", content: "guess what" });
    fake.replies.push({ content: "what?? <cht> tell me <cht> 👀" });
    const result = await app.partner.takeTurn(ooc.id, "user-message");
    expect(result.messages.map((m) => m.content)).toEqual(["what??", "tell me", "👀"]);
    expect(new Set(result.messages.map((m) => m.turnId)).size).toBe(1);
  });

  test("the prompt asks for texts, and shows past texts with the marker", () => {
    const turnId = "t1";
    app.store.addTurn(
      [
        { channelId: ooc.id, author: "partner", content: "omg" },
        { channelId: ooc.id, author: "partner", content: "hi" },
      ],
      turnId,
    );
    app.store.addMessage({ channelId: ooc.id, author: "user", content: "hey" });
    app.store.addMessage({ channelId: ooc.id, author: "user", content: "how are you" });
    const stack = promptForChannel(app.store, ooc.id);
    expect(stack[0]!.content).toContain(TEXTING_STYLE);
    expect(stack.slice(1)).toEqual([
      { role: "assistant", content: `omg ${BUBBLE_MARKER} hi` },
      { role: "user", content: "hey\nhow are you" },
    ]);
    // Roleplay channels don't text.
    expect(promptForChannel(app.store, story.id)[0]!.content).not.toContain(TEXTING_STYLE);
  });

  test("off: as before", () => {
    app.store.updateSettings(validateSettings({ oocBubbles: false }));
    expect(promptForChannel(app.store, ooc.id)[0]!.content).not.toContain(BUBBLE_MARKER);
    const msg = (author: "user" | "partner", content: string) => ({ author, content, kind: "post", mode: null, characters: [] }) as unknown as Message;
    expect(toChatHistory([msg("partner", "a"), msg("partner", "b")])).toEqual([{ role: "assistant", content: "a\n\nb" }]);
  });

  test("a comment reply is one note, without markers", async () => {
    const m = app.store.addMessage({ channelId: ooc.id, author: "partner", content: "hello" });
    const thread = app.store.comments.start("user", m.id, "why hello?", "hello");
    fake.replies.push({ content: "because<cht>it's polite" });
    const result = await app.partner.replyToComment(thread.id);
    expect(result.thread!.comments.at(-1)!.note).toBe("because\nit's polite");
  });
});

describe("sending without a reply", () => {
  test("reply: false saves your text and waits", async () => {
    const { data } = await call("POST", `/api/channels/${ooc.id}/messages`, { content: "hey", reply: false });
    expect(data.userMessages.map((m: Message) => m.content)).toEqual(["hey"]);
    expect(data.partnerMessages).toBeUndefined();
    expect(fake.requests).toHaveLength(0);
  });

  test("settings are checked", () => {
    expect(() => validateSettings({ replyDelayMs: -1 })).toThrow();
    expect(() => validateSettings({ typingPerCharMs: 5000 })).toThrow();
    expect(validateSettings({ oocBubbles: false, replyDelayMs: 0, typingBaseMs: 300 })).toEqual({ oocBubbles: false, replyDelayMs: 0, typingBaseMs: 300 });
  });
});

describe("RNG partner creation", () => {
  test("seeds are random picks, two different interests", () => {
    let n = 0;
    const seeds = rollSeeds(() => ((n += 0.37) % 1));
    expect(seeds.interests).toHaveLength(2);
    expect(seeds.interests[0]).not.toBe(seeds.interests[1]);
    expect(describeSeeds(seeds)).toContain("into");
  });

  test("the model turns them into a partner (not saved)", async () => {
    fake.replies.push({ content: '{"name": "Wren", "prompt": "You are Wren, a dry-witted cartographer..."}' });
    const { status, data } = await call("POST", "/api/partner/random", {});
    expect(status).toBe(200);
    expect(data).toMatchObject({ name: "Wren", prompt: "You are Wren, a dry-witted cartographer..." });
    expect(typeof data.seeds).toBe("string");
    // The ingredients were in the request.
    expect(fake.requests[0]!.messages[0]!.content).toContain("Temperament:");
    expect(app.store.getSettings().partnerName).toBe("Arlo");
  });

  test("a messy answer is an error you can retry", async () => {
    fake.replies.push({ content: "Sure! Here's someone fun." });
    expect((await call("POST", "/api/partner/random", {})).status).toBe(502);
  });
});
