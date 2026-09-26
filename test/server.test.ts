/**
 * End-to-end tests for the server (src/server.ts), with a fake nanoGPT.
 *
 * Requests go straight to the app's `fetch` handler, so no port is opened for
 * Aettica itself, but everything behind it is real: routing, the partner
 * turn, prompt assembly, the HTTP call to the (fake) API, and the database.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NUDGES, OOC_FRAMING } from "../src/prompt.ts";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { appVersion, createApp, matchRoute, type App } from "../src/server.ts";
import { MAX_ROUNDS } from "../src/partner.ts";
import type { Channel } from "../src/types.ts";
import { startFakeNanoGpt, tempDir, testConfig, type FakeNanoGpt } from "./helpers.ts";

let fake: FakeNanoGpt;
let dir: ReturnType<typeof tempDir>;
let app: App;
/** The two channels every new server starts with. */
let story: Channel;
let ooc: Channel;

beforeEach(() => {
  fake = startFakeNanoGpt();
  dir = tempDir();
  app = createApp(testConfig(dir.path, fake.baseUrl));
  [story, ooc] = app.store.listChannels() as [Channel, Channel];
});

afterEach(() => {
  app.store.close();
  fake.stop();
  dir.cleanup();
});

/** Send a request to the app the way the browser would. */
async function call(method: string, path: string, body?: unknown) {
  const response = await app.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const text = await response.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: response.status, data };
}

describe("sending a message", () => {
  test("saves your message and the partner's reply, voicing the channel's character", async () => {
    fake.replies.push({ content: "*Ilse looks up from the lamp.*" });

    const { status, data } = await call("POST", `/api/channels/${story.id}/messages`, {
      content: "I knock on the lighthouse door.",
    });

    expect(status).toBe(200);
    expect(data.userMessages[0]).toMatchObject({ content: "I knock on the lighthouse door.", author: "user", characters: [] });
    expect(data.partnerMessages[0]).toMatchObject({
      content: "*Ilse looks up from the lamp.*",
      author: "partner",
      characters: ["Ilse Marrow"],
      model: app.store.profiles.list()[0]!.model,
      profile: app.store.profiles.list()[0]!.name,
    });
    expect(app.store.getMessages(story.id)).toHaveLength(2);
    expect(app.store.getMessages(ooc.id)).toHaveLength(0);
  });

  test("sends the channel's prompt stack and the profile's settings to the API", async () => {
    const [profile] = app.store.profiles.list();
    app.store.profiles.update(profile!.id, { temperature: 0.7, maxTokens: 321, model: "some/model" });
    await call("POST", `/api/channels/${story.id}/messages`, { content: "Hello" });

    const request = fake.requests[0]!;
    expect(request.auth).toBe("Bearer test-key");
    expect(request.model).toBe("some/model");
    expect(request.temperature).toBe(0.7);
    expect(request.max_tokens).toBe(321);
    // The cast's notebook entry is in the prompt.
    expect(request.messages[0]!.content).toContain("### Ilse Marrow (you play this character)");
    expect(request.messages.at(-1)).toEqual({ role: "user", content: "Hello" });
  });

  test("in OOC, the partner speaks as themselves and sees the channel list", async () => {
    const { data } = await call("POST", `/api/channels/${ooc.id}/messages`, { content: "How's it going?" });

    expect(data.partnerMessages[0].characters).toEqual([]);
    const system = fake.requests[0]!.messages[0]!.content;
    expect(system).toContain(OOC_FRAMING);
    expect(system).toContain("#story: roleplay, you play Ilse Marrow");
    // The notebook is summarised, not the whole of each entry.
    expect(system).toContain("Your shared notebook");
  });

  test("only the channel's own messages are sent", async () => {
    app.store.addMessage({ channelId: story.id, author: "user", content: "a story secret" });
    await call("POST", `/api/channels/${ooc.id}/messages`, { content: "Hi" });
    expect(JSON.stringify(fake.requests[0]!.messages)).not.toContain("a story secret");
  });

  test("keeps your message when the reply fails, and reports the error", async () => {
    fake.replies.push({ status: 401, error: "bad key" });

    const { status, data } = await call("POST", `/api/channels/${story.id}/messages`, { content: "Hello?" });

    expect(status).toBe(200);
    expect(data.partnerMessages).toBeUndefined();
    expect(data.error).toContain("rejected the API key");
    expect(data.error).toContain("bad key");
    expect(app.store.getMessages(story.id).map((m) => m.author)).toEqual(["user"]);
  });

  test("rejects an empty message", async () => {
    const { status } = await call("POST", `/api/channels/${story.id}/messages`, { content: "   " });
    expect(status).toBe(400);
    expect(fake.requests).toHaveLength(0);
  });

  test("returns 404 for a channel that doesn't exist", async () => {
    const { status } = await call("POST", "/api/channels/nope/messages", { content: "Hi" });
    expect(status).toBe(404);
  });

  test("strips <think> reasoning from replies", async () => {
    fake.replies.push({ content: "<think>They want drama.</think>\n\nThe storm breaks." });
    const { data } = await call("POST", `/api/channels/${story.id}/messages`, { content: "Go on." });
    expect(data.partnerMessages[0].content).toBe("The storm breaks.");
  });
});

describe("partner turns without a user message", () => {
  test("the partner can open an empty channel", async () => {
    const { status, data } = await call("POST", `/api/channels/${story.id}/turn`, {});
    expect(status).toBe(200);
    expect(data.partnerMessages[0].author).toBe("partner");
    expect(fake.requests[0]!.messages.at(-1)!.content).toBe(NUDGES.rp.opening);
  });

  test("the partner can continue after their own post", async () => {
    app.store.addMessage({ channelId: story.id, author: "user", content: "Hi" });
    app.store.addMessage({ channelId: story.id, author: "partner", content: "Hello." });

    await call("POST", `/api/channels/${story.id}/turn`, {});

    expect(fake.requests[0]!.messages.at(-1)).toEqual({ role: "user", content: NUDGES.rp.continue });
    expect(app.store.getMessages(story.id).map((m) => m.author)).toEqual(["user", "partner", "partner"]);
  });

  test("a second turn in the same channel is refused, but other channels are free", async () => {
    fake.replies.push({ content: "slow", delayMs: 200 });
    const first = call("POST", `/api/channels/${story.id}/turn`, {});
    await Bun.sleep(20); // let the first turn start

    expect(app.partner.busyChannels()).toEqual([story.id]);
    expect((await call("GET", "/api/state")).data.busyChannels).toEqual([story.id]);
    expect((await call("POST", `/api/channels/${story.id}/turn`, {})).status).toBe(409);
    expect((await call("POST", `/api/channels/${ooc.id}/turn`, {})).status).toBe(200);

    expect((await first).status).toBe(200);
    expect(app.store.getMessages(story.id)).toHaveLength(1);
    expect(app.partner.isBusy(story.id)).toBe(false);
  });

  test("a channel can't be deleted, or have messages deleted, mid-turn", async () => {
    const message = app.store.addMessage({ channelId: story.id, author: "user", content: "Hi" });
    fake.replies.push({ content: "slow", delayMs: 200 });
    const turn = call("POST", `/api/channels/${story.id}/turn`, {});
    await Bun.sleep(20);

    expect((await call("DELETE", `/api/channels/${story.id}`, {})).status).toBe(409);
    expect((await call("DELETE", `/api/messages/${message.id}`, {})).status).toBe(409);
    expect((await call("DELETE", `/api/channels/${story.id}/messages`, {})).status).toBe(409);
    await turn;
  });

  test("an API failure is reported and leaves the channel unchanged", async () => {
    fake.replies.push({ status: 500, error: "upstream down" });
    const { status, data } = await call("POST", `/api/channels/${story.id}/turn`, {});
    expect(status).toBe(502);
    expect(data.error).toContain("upstream down");
    expect(app.store.getMessages(story.id)).toHaveLength(0);
    expect(app.partner.isBusy(story.id)).toBe(false);
  });
});

describe("stopping a turn", () => {
  /**
   * Start a slow turn in #story and wait until it's running. The request is
   * returned wrapped in an object: returning a bare promise from an async
   * function would make `await startSlowTurn()` wait for the whole turn.
   */
  async function startSlowTurn(path = `/api/channels/${story.id}/turn`, body: unknown = {}) {
    fake.replies.push({ content: "too late", delayMs: 400 });
    const pending = call("POST", path, body);
    await Bun.sleep(30);
    expect(app.partner.isBusy(story.id)).toBe(true);
    return { pending };
  }

  test("frees the channel at once, saves nothing, and tells the waiting request", async () => {
    const { pending } = await startSlowTurn();

    const stop = await call("POST", `/api/channels/${story.id}/cancel`, {});
    expect(stop.data).toEqual({ cancelled: true });
    expect(app.partner.isBusy(story.id)).toBe(false);

    const { status, data } = await pending;
    expect(status).toBe(200);
    expect(data).toEqual({ cancelled: true });
    expect(app.store.getMessages(story.id)).toHaveLength(0);
  });

  test("a new turn can start right after stopping one", async () => {
    const { pending: stopped } = await startSlowTurn();
    await call("POST", `/api/channels/${story.id}/cancel`, {});

    fake.replies.push({ content: "Fresh reply" });
    const { status, data } = await call("POST", `/api/channels/${story.id}/turn`, {});
    expect(status).toBe(200);
    expect(data.partnerMessages[0].content).toBe("Fresh reply");
    await stopped;

    // The stopped turn's late reply is never saved.
    await Bun.sleep(450);
    expect(app.store.getMessages(story.id).map((m) => m.content)).toEqual(["Fresh reply"]);
  });

  test("after sending a message, your message stays saved", async () => {
    const { pending } = await startSlowTurn(`/api/channels/${story.id}/messages`, { content: "Hello?" });
    await call("POST", `/api/channels/${story.id}/cancel`, {});

    const { data } = await pending;
    expect(data.cancelled).toBe(true);
    expect(data.userMessages[0].content).toBe("Hello?");
    expect(app.store.getMessages(story.id).map((m) => m.content)).toEqual(["Hello?"]);
  });

  test("stopping a regeneration keeps the old reply", async () => {
    app.store.addMessage({ channelId: story.id, author: "user", content: "Hi" });
    app.store.addMessage({ channelId: story.id, author: "partner", content: "Old reply" });
    const { pending } = await startSlowTurn(`/api/channels/${story.id}/regenerate`);
    await call("POST", `/api/channels/${story.id}/cancel`, {});

    expect((await pending).data).toEqual({ cancelled: true });
    expect(app.store.getMessages(story.id).map((m) => m.content)).toEqual(["Hi", "Old reply"]);
  });

  test("does nothing when no turn is running", async () => {
    expect((await call("POST", `/api/channels/${story.id}/cancel`, {})).data).toEqual({ cancelled: false });
    expect((await call("POST", "/api/channels/nope/cancel", {})).status).toBe(404);
  });

  test("only stops the channel it's asked to", async () => {
    fake.replies.push({ content: "story reply", delayMs: 200 }, { content: "ooc reply", delayMs: 200 });
    const storyTurn = call("POST", `/api/channels/${story.id}/turn`, {});
    const oocTurn = call("POST", `/api/channels/${ooc.id}/turn`, {});
    await Bun.sleep(30);

    await call("POST", `/api/channels/${ooc.id}/cancel`, {});
    expect((await storyTurn).data.partnerMessages[0].content).toBe("story reply");
    expect((await oocTurn).data).toEqual({ cancelled: true });
  });
});

describe("a model that stalls", () => {
  test("halfway through its reply times out cleanly", async () => {
    app.store.close();
    app = createApp(testConfig(dir.path, fake.baseUrl, { requestTimeoutMs: 300 }));
    fake.replies.push({ stallMidReply: true });

    const { status, data } = await call("POST", `/api/channels/${story.id}/turn`, {});

    expect(status).toBe(502);
    expect(data.error).toMatch(/took longer than/);
    expect(app.partner.isBusy(story.id)).toBe(false);
  });
});

describe("regenerate", () => {
  test("replaces the partner's last reply, without showing the old one to the model", async () => {
    app.store.addMessage({ channelId: story.id, author: "user", content: "Hi" });
    const old = app.store.addMessage({ channelId: story.id, author: "partner", content: "Old reply" });
    fake.replies.push({ content: "New reply" });

    const { status, data } = await call("POST", `/api/channels/${story.id}/regenerate`, {});

    expect(status).toBe(200);
    expect(data.replacedIds).toEqual([old.id]);
    expect(app.store.getMessages(story.id).map((m) => m.content)).toEqual(["Hi", "New reply"]);
    expect(JSON.stringify(fake.requests[0]!.messages)).not.toContain("Old reply");
  });

  test("keeps the old reply if generation fails", async () => {
    app.store.addMessage({ channelId: story.id, author: "user", content: "Hi" });
    app.store.addMessage({ channelId: story.id, author: "partner", content: "Old reply" });
    fake.replies.push({ status: 429, error: "slow down" });

    const { status } = await call("POST", `/api/channels/${story.id}/regenerate`, {});

    expect(status).toBe(502);
    expect(app.store.getMessages(story.id).map((m) => m.content)).toEqual(["Hi", "Old reply"]);
  });

  test("refuses when the last message is yours", async () => {
    app.store.addMessage({ channelId: story.id, author: "user", content: "Hi" });
    expect((await call("POST", `/api/channels/${story.id}/regenerate`, {})).status).toBe(400);
  });
});

describe("scene breaks", () => {
  test("===== in a roleplay channel adds a scene break, and the partner doesn't reply", async () => {
    const { status, data } = await call("POST", `/api/channels/${story.id}/messages`, { content: "===== The Storm" });
    expect(status).toBe(200);
    expect(data.sceneBreak).toMatchObject({ kind: "scene_break", content: "The Storm" });
    expect(data.channel.id).toBe(story.id);
    expect(fake.requests).toHaveLength(0);
  });

  test("===== in an OOC channel is just a message", async () => {
    const { data } = await call("POST", `/api/channels/${ooc.id}/messages`, { content: "=====" });
    expect(data.userMessages[0]).toMatchObject({ kind: "post", content: "=====" });
  });

  test("the scene break route adds one, and a waiting mode change applies", async () => {
    app.store.addMessage({ channelId: story.id, author: "user", content: "Hi", mode: "literary" });
    const patched = await call("PATCH", `/api/channels/${story.id}`, { mode: "casual" });
    expect(patched.data.channel).toMatchObject({ mode: "literary", pendingMode: "casual" });

    const { data } = await call("POST", `/api/channels/${story.id}/scene-breaks`, { title: "Later" });
    expect(data.sceneBreak.content).toBe("Later");
    expect(data.channel).toMatchObject({ mode: "casual", pendingMode: null });
  });

  test("the partner opens the new scene after a break", async () => {
    await call("POST", `/api/channels/${story.id}/scene-breaks`, {});
    await call("POST", `/api/channels/${story.id}/turn`, {});
    expect(fake.requests[0]!.messages.at(-1)!.content).toContain("Write the opening of the new scene");
  });

  test("a scene break's title can be edited, even to nothing", async () => {
    const { sceneBreak } = app.store.addSceneBreak(story.id, "user", "Old");
    const { data } = await call("PATCH", `/api/messages/${sceneBreak.id}`, { content: "" });
    expect(data.message.content).toBe("");
  });

  test("OOC channels can't have scene breaks", async () => {
    expect((await call("POST", `/api/channels/${ooc.id}/scene-breaks`, {})).status).toBe(400);
  });
});

describe("connection profiles", () => {
  test("a channel can override the server-wide profile", async () => {
    const glm = app.store.profiles.create({ name: "GLM", model: "zai/glm-5.2", quirkPrompt: "Don't restate the scene." });
    const { status } = await call("PATCH", `/api/channels/${story.id}`, { assignment: `profile:${glm.id}` });
    expect(status).toBe(200);

    const { data } = await call("POST", `/api/channels/${story.id}/turn`, {});
    expect(data.partnerMessages[0]).toMatchObject({ model: "zai/glm-5.2", profile: "GLM" });
    expect(fake.requests[0]!.model).toBe("zai/glm-5.2");
    // Its model notes are layer 4 of the prompt.
    expect(fake.requests[0]!.messages[0]!.content).toContain("## Model notes\n\nDon't restate the scene.");

    // Other channels still use the server-wide one.
    await call("POST", `/api/channels/${ooc.id}/turn`, {});
    expect(fake.requests[1]!.model).toBe(app.store.profiles.list()[0]!.model);
  });

  test("a roulette's pick is recorded on the message", async () => {
    const [first] = app.store.profiles.list();
    const roulette = app.store.profiles.createRoulette({ name: "Mix", entries: [{ profileId: first!.id, weight: 1 }] });
    await call("PUT", "/api/settings", { rpAssignment: `roulette:${roulette.id}` });
    const { data } = await call("POST", `/api/channels/${story.id}/turn`, {});
    expect(data.partnerMessages[0].profile).toBe(first!.name);
  });

  test("regenerate can pin a specific profile", async () => {
    const glm = app.store.profiles.create({ name: "GLM", model: "zai/glm-5.2" });
    await call("POST", `/api/channels/${story.id}/turn`, {});
    const { data } = await call("POST", `/api/channels/${story.id}/regenerate`, { profileId: glm.id });
    expect(data.partnerMessages[0].profile).toBe("GLM");
    expect(fake.requests[1]!.model).toBe("zai/glm-5.2");
  });

  test("profiles and roulettes can be managed through the API", async () => {
    const made = await call("POST", "/api/profiles", { name: "Kimi", model: "moonshot/kimi-k2.6", supportsTools: false });
    expect(made.data.profile).toMatchObject({ name: "Kimi", supportsTools: false });
    const id = made.data.profile.id;
    expect((await call("PATCH", `/api/profiles/${id}`, { temperature: 0.6 })).data.profile.temperature).toBe(0.6);
    const roulette = await call("POST", "/api/roulettes", { name: "Mix", entries: [{ profileId: id, weight: 2 }] });
    expect(roulette.data.roulette.entries).toEqual([{ profileId: id, weight: 2 }]);
    expect((await call("GET", "/api/profiles")).data.roulettes).toHaveLength(1);
    expect((await call("DELETE", `/api/profiles/${id}`, {})).status).toBe(200);
    expect((await call("GET", "/api/profiles")).data.roulettes[0].entries).toEqual([]);
  });

  test("the prompt preview can show a given profile's model notes", async () => {
    const glm = app.store.profiles.create({ name: "GLM", model: "zai/glm-5.2", quirkPrompt: "Short sentences." });
    const { data } = await call("GET", `/api/channels/${story.id}/prompt?profile=${glm.id}`);
    expect(data.profile.name).toBe("GLM");
    expect(data.messages[0].content).toContain("Short sentences.");
  });
});

describe("casual mode", () => {
  beforeEach(() => {
    app.store.updateChannel(story.id, { mode: "casual" });
    app.store.notebook.createEntry("user", { kind: "character", name: "Kestrel", proxyPrefix: "k" });
    app.store.notebook.createEntry("user", { kind: "character", name: "Jun", proxyPrefix: "j" });
  });

  test("your post is split into bubbles by proxy tag and the character you picked", async () => {
    const { data } = await call("POST", `/api/channels/${story.id}/messages`, {
      content: "hi!\nk: *waves*",
      postingAs: "Jun",
    });
    expect(data.userMessages.map((m: any) => [m.characters, m.content, m.mode])).toEqual([
      [["Jun"], "hi!", "casual"],
      [["Kestrel"], "*waves*", "casual"],
    ]);
    expect(data.userMessages[0].turnId).toBe(data.userMessages[1].turnId);
    // Both joined the channel's cast by posting.
    expect(data.channel.cast.map((c: any) => [c.name, c.playedBy])).toEqual([
      ["Ilse Marrow", "partner"],
      ["Jun", "user"],
      ["Kestrel", "user"],
    ]);
  });

  test("either of you can play a shared character", async () => {
    app.store.notebook.createEntry("user", { kind: "character", name: "Bo Tern", owner: "joint", proxyPrefix: "b" });
    fake.replies.push({ content: "Bo: Aye.\nIlse: Hm." });
    const { data } = await call("POST", `/api/channels/${story.id}/messages`, { content: "b: *ties off the rope*" });

    expect(data.userMessages.map((m: any) => m.characters)).toEqual([["Bo Tern"]]);
    expect(data.partnerMessages.map((m: any) => m.characters)).toEqual([["Bo Tern"], ["Ilse Marrow"]]);
    expect(data.channel.cast.find((c: any) => c.name === "Bo Tern").playedBy).toBe("both");
  });

  test("posting as someone who isn't one of your characters is refused", async () => {
    const { status } = await call("POST", `/api/channels/${story.id}/messages`, { content: "hi", postingAs: "Ilse" });
    expect(status).toBe(400);
  });

  test("the partner's reply is split into bubbles, one turn", async () => {
    fake.replies.push({ content: "Ilse: Door's open.\nIlse Marrow: *nods*" });
    const { data } = await call("POST", `/api/channels/${story.id}/turn`, {});
    expect(data.partnerMessages.map((m: any) => [m.characters, m.content])).toEqual([
      [["Ilse Marrow"], "Door's open."],
      [["Ilse Marrow"], "*nods*"],
    ]);
    // The model was asked for the casual format.
    expect(fake.requests[0]!.messages[0]!.content).toContain("casual style");
  });

  test("regenerating replaces every bubble of the last reply", async () => {
    fake.replies.push({ content: "Ilse: OLD-BUBBLE-1\nIlse: OLD-BUBBLE-2" }, { content: "Ilse: fresh" });
    await call("POST", `/api/channels/${story.id}/turn`, {});

    const { data } = await call("POST", `/api/channels/${story.id}/regenerate`, {});

    expect(data.replacedIds).toHaveLength(2);
    expect(app.store.getMessages(story.id).map((m) => m.content)).toEqual(["fresh"]);
    expect(JSON.stringify(fake.requests[1]!.messages)).not.toContain("OLD-BUBBLE");
  });
});

describe("channels", () => {
  test("can be created, renamed, reordered and deleted", async () => {
    const created = await call("POST", "/api/channels", { name: " heist ", kind: "rp" });
    expect(created.status).toBe(200);
    expect(created.data.channel).toMatchObject({ name: "heist", kind: "rp", position: 2, cast: [] });
    const heist = created.data.channel.id;

    const renamed = await call("PATCH", `/api/channels/${heist}`, { name: "the-heist" });
    expect(renamed.data.channel).toMatchObject({ name: "the-heist" });

    const reordered = await call("PUT", "/api/channels/order", { ids: [heist, story.id, ooc.id] });
    expect(reordered.data.channels.map((c: Channel) => c.name)).toEqual(["the-heist", "story", "ooc"]);

    expect((await call("DELETE", `/api/channels/${heist}`, {})).status).toBe(200);
    expect((await call("GET", "/api/state")).data.channels.map((c: Channel) => c.name)).toEqual(["story", "ooc"]);
    expect((await call("DELETE", `/api/channels/${heist}`, {})).status).toBe(404);
  });

  test("reject invalid input", async () => {
    expect((await call("POST", "/api/channels", { name: "", kind: "rp" })).status).toBe(400);
    expect((await call("POST", "/api/channels", { name: "x", kind: "voice" })).status).toBe(400);
    expect((await call("PUT", "/api/channels/order", { ids: [story.id] })).status).toBe(400);
    expect((await call("PUT", "/api/channels/order", { ids: "nope" })).status).toBe(400);
  });

  test("renaming the character changes who the partner's next reply voices", async () => {
    const [ilse] = app.store.notebook.listEntries("user");
    await call("PATCH", `/api/notebook/entries/${ilse!.id}`, { name: "The Keeper" });
    const { data } = await call("POST", `/api/channels/${story.id}/turn`, {});
    expect(data.partnerMessages[0].characters).toEqual(["The Keeper"]);
  });
});

describe("messages and settings", () => {
  test("lists, edits, deletes and clears messages", async () => {
    const a = app.store.addMessage({ channelId: story.id, author: "user", content: "one" });
    const b = app.store.addMessage({ channelId: story.id, author: "user", content: "two" });

    expect((await call("GET", `/api/channels/${story.id}/messages`)).data.messages).toHaveLength(2);
    expect((await call("PATCH", `/api/messages/${a.id}`, { content: "ONE" })).data.message.content).toBe("ONE");
    expect((await call("DELETE", `/api/messages/${b.id}`, {})).status).toBe(200);
    expect((await call("DELETE", `/api/messages/${b.id}`, {})).status).toBe(404);
    expect(app.store.getMessages(story.id).map((m) => m.content)).toEqual(["ONE"]);

    await call("DELETE", `/api/channels/${story.id}/messages`, {});
    expect(app.store.getMessages(story.id)).toHaveLength(0);
  });

  test("updates settings and rejects invalid ones", async () => {
    const ok = await call("PUT", "/api/settings", { historyLimit: 12, partnerName: "Sol" });
    expect(ok.data.settings).toMatchObject({ historyLimit: 12, partnerName: "Sol" });

    const bad = await call("PUT", "/api/settings", { historyLimit: 0 });
    expect(bad.status).toBe(400);
    expect(bad.data.error).toContain("historyLimit");
    expect(app.store.getSettings().historyLimit).toBe(12);

    // An assignment must point at a profile or roulette that exists.
    expect((await call("PUT", "/api/settings", { rpAssignment: "profile:nope" })).status).toBe(404);
  });

  test("reports a fingerprint of the app's files, which changes when they change", async () => {
    const { data } = await call("GET", "/api/state");
    expect(data.appVersion).toMatch(/^[0-9a-f]{12}$/);
    expect(appVersion(join(import.meta.dir, "..", "public"))).toBe(data.appVersion);

    // A different set of files gives a different fingerprint.
    const other = tempDir();
    writeFileSync(join(other.path, "index.html"), "<p>hi</p>");
    const before = appVersion(other.path);
    writeFileSync(join(other.path, "index.html"), "<p>hello</p>");
    expect(appVersion(other.path)).not.toBe(before);
    other.cleanup();
  });

  test("returns the server state", async () => {
    const { data } = await call("GET", "/api/state");
    expect(data.channels.map((c: Channel) => c.name)).toEqual(["story", "ooc"]);
    expect(data.profiles).toHaveLength(1);
    expect(data.roulettes).toEqual([]);
    expect(data.busyChannels).toEqual([]);
  });

  test("previews a channel's prompt stack without calling the API", async () => {
    const { data } = await call("GET", `/api/channels/${ooc.id}/prompt`);
    expect(data.messages[0].content).toContain(OOC_FRAMING);
    expect(fake.requests).toHaveLength(0);
  });

  test("lists models from nanoGPT, sorted", async () => {
    const { data } = await call("GET", "/api/models");
    expect(data.models).toEqual(["alpha/model", "zeta/model"]);
  });
});

describe("themes", () => {
  test("are listed, and the app theme can be chosen", async () => {
    const { data } = await call("GET", "/api/themes");
    expect(data.themes.map((t: any) => t.id)).toContain("liquid-glass");

    expect((await call("PUT", "/api/settings", { appTheme: "liquid-glass" })).data.settings.appTheme).toBe("liquid-glass");
    expect((await call("PUT", "/api/settings", { appTheme: "no-such-theme" })).status).toBe(400);
  });

  test("a channel can have its own theme, or none", async () => {
    const set = await call("PATCH", `/api/channels/${story.id}`, { theme: "aero-glass" });
    expect(set.data.channel.theme).toBe("aero-glass");
    expect((await call("PATCH", `/api/channels/${story.id}`, { theme: null })).data.channel.theme).toBeNull();
    expect((await call("PATCH", `/api/channels/${story.id}`, { theme: "no-such-theme" })).status).toBe(400);
  });

  test("can be copied, edited, given files, and served", async () => {
    const { data: created } = await call("POST", "/api/themes", { name: "Ember", from: "classic" });
    const id = created.theme.id;

    await call("PATCH", `/api/themes/${id}`, { css: ":root { --app-background: url(wall.png); }" });
    const upload = await call("POST", `/api/themes/${id}/files`, {
      name: "wall.png",
      data: Buffer.from([137, 80, 78, 71]).toString("base64"),
    });
    expect(upload.data.files).toEqual(["wall.png"]);

    const css = await app.fetch(new Request(`http://localhost/themes/${id}/theme.css`));
    expect(await css.text()).toContain(`url("/themes/${id}/wall.png")`);
    const image = await app.fetch(new Request(`http://localhost/themes/${id}/wall.png`));
    expect(image.headers.get("Content-Type")).toBe("image/png");
    expect((await app.fetch(new Request("http://localhost/themes/nope/theme.css"))).status).toBe(404);
  });

  test("deleting a theme puts everything that used it back to the default", async () => {
    const { data } = await call("POST", "/api/themes", { name: "Short-lived" });
    const id = data.theme.id;
    await call("PUT", "/api/settings", { appTheme: id });
    await call("PATCH", `/api/channels/${story.id}`, { theme: id });

    const deleted = await call("DELETE", `/api/themes/${id}`, {});
    expect(deleted.data.settings.appTheme).toBe("classic");
    expect(deleted.data.channels.find((c: Channel) => c.id === story.id).theme).toBeNull();
  });

  test("built-in themes are protected", async () => {
    expect((await call("PATCH", "/api/themes/classic", { css: "" })).status).toBe(400);
    expect((await call("DELETE", "/api/themes/frutiger-aero", {})).status).toBe(400);
  });
});

describe("routing", () => {
  test("matchRoute fills in :params and rejects mismatches", () => {
    const route = { method: "POST", pattern: "/api/channels/:id/turn" };
    expect(matchRoute(route, "POST", "/api/channels/abc/turn")).toEqual({ id: "abc" });
    expect(matchRoute(route, "GET", "/api/channels/abc/turn")).toBeNull();
    expect(matchRoute(route, "POST", "/api/channels//turn")).toBeNull();
    expect(matchRoute(route, "POST", "/api/channels/abc/turn/extra")).toBeNull();
    expect(matchRoute(route, "POST", "/api/channels/%zz/turn")).toBeNull();
  });

  test("unknown API routes are a 404", async () => {
    expect((await call("GET", "/api/nope")).status).toBe(404);
  });
});

describe("safety", () => {
  test("refuses changes that aren't sent as JSON", async () => {
    const response = await app.fetch(
      new Request(`http://localhost/api/channels/${story.id}/turn`, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: "",
      }),
    );
    expect(response.status).toBe(415);
    expect(fake.requests).toHaveLength(0);
  });

  test("reports a missing API key clearly", async () => {
    const noKey = createApp(testConfig(dir.path, fake.baseUrl, { apiKey: "" }));
    const response = await noKey.fetch(
      new Request(`http://localhost/api/channels/${story.id}/turn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
    );
    expect(response.status).toBe(502);
    expect(((await response.json()) as { error: string }).error).toContain("NANOGPT_API_KEY");
    noKey.store.close();
  });

  test("serves the app but not files outside public/", async () => {
    expect((await call("GET", "/")).status).toBe(200);
    expect((await call("GET", "/app.js")).status).toBe(200);
    // %2F is an encoded "/", which the URL parser leaves alone, so this really
    // does ask for "/../package.json" (a file that exists one folder up).
    expect((await call("GET", "/..%2Fpackage.json")).status).toBe(404);
    expect((await call("GET", "/nope.txt")).status).toBe(404);
  });
});

describe("the notebook", () => {
  const entryIn = async (name: string) =>
    ((await call("GET", "/api/notebook")).data.entries as any[]).find((e) => e.name === name);

  test("lists entries, folders, suggestions and the field templates", async () => {
    const { data } = await call("GET", "/api/notebook");
    expect(data.entries.map((e: any) => [e.name, e.owner, e.access])).toEqual([
      ["Ilse Marrow", "partner", { edit: "direct", settings: false, delete: false }],
    ]);
    expect(data.entries[0].pinnedIn).toEqual([story.id]);
    expect(data.folders).toEqual([]);
    expect(data.suggestions).toEqual([]);
    expect(data.templates.character).toContain("Appearance");
  });

  test("creates, edits and deletes your own entries", async () => {
    const created = await call("POST", "/api/notebook/entries", { kind: "lore", name: "The Charted Sea" });
    expect(created.data.entry).toMatchObject({ owner: "user", fields: [{ label: "Summary" }, { label: "Details" }] });
    const id = created.data.entry.id;

    const edited = await call("PATCH", `/api/notebook/entries/${id}`, { fields: [{ label: "Summary", value: "Cold." }] });
    expect(edited.data.entry.fields).toEqual([{ label: "Summary", value: "Cold." }]);

    expect((await call("DELETE", `/api/notebook/entries/${id}`, {})).data).toEqual({ deleted: true });
    expect(await entryIn("The Charted Sea")).toBeUndefined();
  });

  test("changes to shared lore become suggestions", async () => {
    const { data } = await call("POST", "/api/notebook/entries", { kind: "lore", name: "The Light", owner: "joint" });
    const suggested = await call("PATCH", `/api/notebook/entries/${data.entry.id}`, { name: "The Lamp" });
    expect(suggested.data.suggestion).toMatchObject({ author: "user", status: "pending", change: { name: "The Lamp" } });
    expect((await entryIn("The Light"))).toBeDefined();

    // You can't accept your own suggestion, only withdraw it.
    const id = suggested.data.suggestion.id;
    expect((await call("POST", `/api/notebook/suggestions/${id}/accept`, {})).status).toBe(403);
    expect((await call("POST", `/api/notebook/suggestions/${id}/withdraw`, {})).status).toBe(200);
    expect((await call("GET", "/api/notebook")).data.suggestions).toEqual([]);
  });

  test("hiding an entry of your partner's is refused", async () => {
    const ilse = await entryIn("Ilse Marrow");
    const { status } = await call("PUT", `/api/notebook/entries/${ilse.id}/settings`, { visibility: "hidden" });
    expect(status).toBe(403);
  });

  test("pinning and unpinning changes a channel's cast", async () => {
    const { data } = await call("POST", "/api/notebook/entries", { kind: "character", name: "Tamsin Hale", owner: "partner" });
    const pinned = await call("PUT", `/api/channels/${story.id}/cast/${data.entry.id}`, {});
    expect(pinned.data.channel.cast.map((c: any) => c.name)).toEqual(["Ilse Marrow", "Tamsin Hale"]);

    // The partner now plays both, and the prompt says so.
    await call("POST", `/api/channels/${story.id}/turn`, {});
    expect(fake.requests[0]!.messages[0]!.content).toContain("### Tamsin Hale (you play this character)");

    const unpinned = await call("DELETE", `/api/channels/${story.id}/cast/${data.entry.id}`, {});
    expect(unpinned.data.channel.cast.map((c: any) => c.name)).toEqual(["Ilse Marrow"]);
  });

  test("folders can be created, renamed and deleted, keeping their entries", async () => {
    const folder = (await call("POST", "/api/notebook/folders", { name: "Secrets", visibility: "hidden" })).data.folder;
    expect(folder).toMatchObject({ name: "Secrets", owner: "user", visibility: "hidden" });
    const entry = (await call("POST", "/api/notebook/entries", { kind: "lore", name: "The Wreck", folderId: folder.id })).data.entry;
    expect(entry.settings.visibility).toBe("hidden");

    expect((await call("PATCH", `/api/notebook/folders/${folder.id}`, { name: "Plans" })).data.folder.name).toBe("Plans");
    await call("DELETE", `/api/notebook/folders/${folder.id}`, {});
    expect((await entryIn("The Wreck")).folderId).toBeNull();
  });
});

describe("tools", () => {
  test("a turn can call tools, see the results, then write its post", async () => {
    app.store.notebook.createEntry("user", { kind: "character", name: "Tamsin Hale", owner: "partner" });
    fake.replies.push(
      { toolCalls: [{ name: "read_notebook_entry", arguments: '{"name": "Tamsin"}' }] },
      { toolCalls: [{ name: "pin_to_channel", arguments: { name: "Tamsin Hale" } }] },
      { content: "Tamsin: *leans in the doorway*" },
    );
    const { data } = await call("POST", `/api/channels/${story.id}/turn`, {});

    expect(data.partnerMessages.map((m: any) => m.content)).toEqual(["Tamsin: *leans in the doorway*"]);
    expect(data.toolCalls.map((c: any) => [c.name, c.status, c.summary, c.source])).toEqual([
      ["read_notebook_entry", "ok", "read Tamsin Hale", "native"],
      ["pin_to_channel", "ok", "pinned Tamsin Hale to #story", "native"],
    ]);
    // The calls belong to the turn that wrote the post.
    expect(data.toolCalls[0].turnId).toBe(data.partnerMessages[0].turnId);
    // The pin took effect, and the post voices the newly pinned character.
    expect(data.channels.find((c: any) => c.id === story.id).cast.map((c: any) => c.name)).toContain("Tamsin Hale");
    expect(data.partnerMessages[0].characters).toEqual(["Tamsin Hale"]);

    // The model saw its call and the result before writing.
    const second = fake.requests[1]!.messages;
    expect(second.at(-2)).toMatchObject({ role: "assistant", tool_calls: [{ function: { name: "read_notebook_entry" } }] });
    expect(second.at(-1)).toMatchObject({ role: "tool", tool_call_id: "call_1_0" });
    expect(JSON.parse(second.at(-1)!.content)).toMatchObject({ name: "Tamsin Hale", owner: "yours" });

    // The log is kept, and comes with the channel's messages.
    const listed = await call("GET", `/api/channels/${story.id}/messages`);
    expect(listed.data.toolCalls).toHaveLength(2);
  });

  test("tools are only offered when the profile can use them", async () => {
    await call("POST", `/api/channels/${story.id}/turn`, {});
    expect(fake.requests[0]!.tools!.map((t) => t.function.name)).toContain("read_notebook_entry");
    expect(fake.requests[0]!.messages[0]!.content).toContain("## Tools");

    const [profile] = app.store.profiles.list();
    app.store.profiles.update(profile!.id, { supportsTools: false });
    await call("POST", `/api/channels/${story.id}/turn`, {});
    expect(fake.requests[1]!.tools).toBeUndefined();
    expect(fake.requests[1]!.messages[0]!.content).not.toContain("## Tools");
  });

  test("tool calls written in the reply's text are run, and never posted", async () => {
    fake.replies.push(
      { content: 'Let me look.\n<tool_call>{"name": "search_notebook", "arguments": {}}</tool_call>' },
      { content: "*Ilse lights the lamp.*" },
    );
    const { data } = await call("POST", `/api/channels/${story.id}/turn`, {});
    expect(data.toolCalls).toMatchObject([{ name: "search_notebook", source: "text", status: "ok" }]);
    expect(data.partnerMessages.map((m: any) => m.content)).toEqual(["*Ilse lights the lamp.*"]);
    // The results went back as a note, since there's no API call id to answer.
    expect(fake.requests[1]!.messages.at(-1)!.content).toStartWith("(Tool results)\nsearch_notebook:");
  });

  test("broken arguments are explained to the model, which can try again", async () => {
    fake.replies.push(
      { toolCalls: [{ name: "read_notebook_entry", arguments: "name: Ilse" }] },
      { toolCalls: [{ name: "read_notebook_entry", arguments: '{"name": "Ilse"}' }] },
      { content: "Done." },
    );
    const { data } = await call("POST", `/api/channels/${story.id}/turn`, {});
    expect(data.toolCalls.map((c: any) => c.status)).toEqual(["error", "ok"]);
    expect(data.toolCalls[0].summary).toContain("aren't valid JSON");
    expect(JSON.parse(fake.requests[1]!.messages.at(-1)!.content).error).toContain("valid JSON");
  });

  test("do_nothing ends the turn without a post, and is reported", async () => {
    fake.replies.push({ toolCalls: [{ name: "do_nothing", arguments: '{"reason": "Waiting for you."}' }], content: "ignored" });
    const { data } = await call("POST", `/api/channels/${story.id}/turn`, {});
    expect(data).toMatchObject({ partnerMessages: [], skipped: true });
    expect(data.toolCalls[0].summary).toBe("chose not to reply (Waiting for you.)");
    expect(app.store.getMessages(story.id)).toEqual([]);
  });

  test("a model that won't stop calling tools is made to write after a few rounds", async () => {
    for (let i = 0; i < MAX_ROUNDS; i++) fake.replies.push({ toolCalls: [{ name: "search_notebook", arguments: "{}" }] });
    fake.replies.push({ content: "Finally." });
    const { data } = await call("POST", `/api/channels/${story.id}/turn`, {});
    expect(fake.requests).toHaveLength(MAX_ROUNDS);
    expect(fake.requests.at(-1)!.tools).toBeUndefined();
    // The last round's calls weren't run.
    expect(data.toolCalls.at(-1)).toMatchObject({ status: "error" });
    expect(data.toolCalls.at(-1).summary).toContain("out of tool rounds");
  });

  test("regenerating keeps the old reply if the new turn writes nothing", async () => {
    app.store.addTurn([{ channelId: story.id, author: "partner", content: "Old reply" }]);
    fake.replies.push({ toolCalls: [{ name: "do_nothing", arguments: "{}" }] });
    const { data } = await call("POST", `/api/channels/${story.id}/regenerate`, {});
    expect(data).toMatchObject({ replacedIds: [], skipped: true });
    expect(app.store.getMessages(story.id).map((m) => m.content)).toEqual(["Old reply"]);
  });

  test("testing a profile's tool calling", async () => {
    const [profile] = app.store.profiles.list();
    fake.replies.push(
      { toolCalls: [{ name: "check_in", arguments: '{"word": "lighthouse"}' }] },
      { content: '<tool_call>{"name": "check_in", "arguments": {"word": "lighthouse"}}</tool_call>' },
      { content: "I can't do that." },
    );
    const test = async () => (await call("POST", `/api/profiles/${profile!.id}/test`, {})).data.test;
    expect((await test()).verdict).toBe("native");
    expect((await test()).verdict).toBe("text");
    expect(await test()).toMatchObject({ verdict: "none", content: "I can't do that." });
  });
});

describe("attaching notes", () => {
  test("notes you attach, or [[link]], are sent in full with the message", async () => {
    const sea = app.store.notebook.createEntry("user", {
      kind: "lore",
      name: "The Charted Sea",
      fields: [{ label: "Summary", value: "COLD-AND-GREY" }],
    });
    app.store.notebook.createEntry("user", { kind: "character", name: "Kestrel", fields: [{ label: "Age", value: "KESTREL-AGE" }] });
    const { data } = await call("POST", `/api/channels/${ooc.id}/messages`, {
      content: "What do you think of [[Kestrel]]?",
      attach: [sea.id],
    });
    expect(data.userMessages[0].attachments.sort()).toHaveLength(2);
    const system = fake.requests[0]!.messages[0]!.content;
    expect(system).toContain("## Attached notes");
    expect(system).toContain("COLD-AND-GREY");
    expect(system).toContain("KESTREL-AGE");
  });

  test("an entry hidden from your partner can't be attached", async () => {
    const twist = app.store.notebook.createEntry("user", { kind: "lore", name: "My Twist", visibility: "hidden" });
    const { status, data } = await call("POST", `/api/channels/${ooc.id}/messages`, { content: "hm", attach: [twist.id] });
    expect(status).toBe(400);
    expect(data.error).toContain("hidden from your partner");
  });
});

describe("comments", () => {
  test("commenting on your partner's message gets a reply in the thread, not a post", async () => {
    const [message] = app.store.addTurn([{ channelId: story.id, author: "partner", content: "The lamp guttered." }]);
    fake.replies.push({ content: "Thanks! It's foreshadowing." });
    const { data } = await call("POST", `/api/messages/${message!.id}/comments`, { quote: "lamp guttered", note: "Ominous!" });

    expect(data.thread.comments.map((c: any) => [c.author, c.note])).toEqual([
      ["user", "Ominous!"],
      ["partner", "Thanks! It's foreshadowing."],
    ]);
    expect(app.store.getMessages(story.id)).toHaveLength(1);
    // The model was asked for a reply, out of character.
    const last = fake.requests[0]!.messages.at(-1)!;
    expect(last.content).toContain('The user left a comment on your message on "lamp guttered": "Ominous!"');
    expect(fake.requests[0]!.messages[0]!.content).toContain("## Comment threads");
  });

  test("commenting on your own message doesn't wake your partner, until they're in the thread", async () => {
    const [message] = app.store.addTurn([{ channelId: story.id, author: "user", content: "I knock." }]);
    const started = await call("POST", `/api/messages/${message!.id}/comments`, { note: "Note to self." });
    expect(started.data.partnerMessages).toBeUndefined();
    expect(fake.requests).toHaveLength(0);

    const threadId = started.data.thread.id;
    app.store.comments.reply("partner", threadId, "Noted!");
    await call("POST", `/api/comments/${threadId}/replies`, { note: "Thanks." });
    expect(fake.requests).toHaveLength(1);

    const resolved = await call("POST", `/api/comments/${threadId}/resolve`, {});
    expect(resolved.data.thread.resolved).toBe(true);
  });
});

describe("approvals", () => {
  test("approving your partner's proposal to delete a channel deletes it", async () => {
    const proposal = app.store.proposals.propose("delete_channel", ooc.id, "ooc", "Unused.");
    expect((await call("GET", "/api/state")).data.proposals).toHaveLength(1);
    const { data } = await call("POST", `/api/proposals/${proposal.id}/approve`, {});
    expect(data.proposals).toEqual([]);
    expect(data.channels.map((c: Channel) => c.name)).toEqual(["story"]);
  });

  test("denying one keeps the channel, and your partner hears how it went", async () => {
    const proposal = app.store.proposals.propose("delete_channel", ooc.id, "ooc", "");
    await call("POST", `/api/proposals/${proposal.id}/deny`, {});
    expect(app.store.listChannels()).toHaveLength(2);
    await call("POST", `/api/channels/${story.id}/turn`, {});
    expect(fake.requests[0]!.messages[0]!.content).toContain("The user denied your proposal to delete #ooc.");
  });
});
