/**
 * End-to-end tests for the server (src/server.ts), with a fake nanoGPT.
 *
 * Requests go straight to the app's `fetch` handler, so no port is opened for
 * Aettica itself, but everything behind it is real: routing, the partner
 * turn, prompt assembly, the HTTP call to the (fake) API, and the database.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NUDGES, OOC_FRAMING } from "../src/prompt.ts";
import { createApp, matchRoute, type App } from "../src/server.ts";
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
    expect(data.userMessage).toMatchObject({ content: "I knock on the lighthouse door.", author: "user", characters: [] });
    expect(data.partnerMessage).toMatchObject({
      content: "*Ilse looks up from the lamp.*",
      author: "partner",
      characters: ["Ilse Marrow"],
      model: app.store.getSettings().model,
    });
    expect(app.store.getMessages(story.id)).toHaveLength(2);
    expect(app.store.getMessages(ooc.id)).toHaveLength(0);
  });

  test("sends the channel's prompt stack and the settings to the API", async () => {
    app.store.updateSettings({ temperature: 0.7, maxTokens: 321, model: "some/model" });
    await call("POST", `/api/channels/${story.id}/messages`, { content: "Hello" });

    const request = fake.requests[0]!;
    expect(request.auth).toBe("Bearer test-key");
    expect(request.model).toBe("some/model");
    expect(request.temperature).toBe(0.7);
    expect(request.max_tokens).toBe(321);
    expect(request.messages[0]!.content).toContain(story.characterSheet);
    expect(request.messages.at(-1)).toEqual({ role: "user", content: "Hello" });
  });

  test("in OOC, the partner speaks as themselves and sees the channel list", async () => {
    const { data } = await call("POST", `/api/channels/${ooc.id}/messages`, { content: "How's it going?" });

    expect(data.partnerMessage.characters).toEqual([]);
    const system = fake.requests[0]!.messages[0]!.content;
    expect(system).toContain(OOC_FRAMING);
    expect(system).toContain("#story: roleplay, you play Ilse Marrow");
    expect(system).not.toContain(story.characterSheet);
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
    expect(data.partnerMessage).toBeUndefined();
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
    expect(data.partnerMessage.content).toBe("The storm breaks.");
  });
});

describe("partner turns without a user message", () => {
  test("the partner can open an empty channel", async () => {
    const { status, data } = await call("POST", `/api/channels/${story.id}/turn`, {});
    expect(status).toBe(200);
    expect(data.partnerMessage.author).toBe("partner");
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

describe("regenerate", () => {
  test("replaces the partner's last reply, without showing the old one to the model", async () => {
    app.store.addMessage({ channelId: story.id, author: "user", content: "Hi" });
    const old = app.store.addMessage({ channelId: story.id, author: "partner", content: "Old reply" });
    fake.replies.push({ content: "New reply" });

    const { status, data } = await call("POST", `/api/channels/${story.id}/regenerate`, {});

    expect(status).toBe(200);
    expect(data.replacedId).toBe(old.id);
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

describe("channels", () => {
  test("can be created, renamed, reordered and deleted", async () => {
    const created = await call("POST", "/api/channels", { name: " heist ", kind: "rp", characterName: "Vee" });
    expect(created.status).toBe(200);
    expect(created.data.channel).toMatchObject({ name: "heist", kind: "rp", characterName: "Vee", position: 2 });
    const heist = created.data.channel.id;

    const renamed = await call("PATCH", `/api/channels/${heist}`, { name: "the-heist", characterSheet: "A thief." });
    expect(renamed.data.channel).toMatchObject({ name: "the-heist", characterSheet: "A thief.", characterName: "Vee" });

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
    await call("PATCH", `/api/channels/${story.id}`, { characterName: "The Keeper" });
    const { data } = await call("POST", `/api/channels/${story.id}/turn`, {});
    expect(data.partnerMessage.characters).toEqual(["The Keeper"]);
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
    const ok = await call("PUT", "/api/settings", { temperature: 1.2, partnerName: "Sol" });
    expect(ok.data.settings).toMatchObject({ temperature: 1.2, partnerName: "Sol" });

    const bad = await call("PUT", "/api/settings", { temperature: 99 });
    expect(bad.status).toBe(400);
    expect(bad.data.error).toContain("temperature");
    expect(app.store.getSettings().temperature).toBe(1.2);
  });

  test("returns the server state", async () => {
    const { data } = await call("GET", "/api/state");
    expect(data.channels.map((c: Channel) => c.name)).toEqual(["story", "ooc"]);
    expect(data.settings.model).toBeString();
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
