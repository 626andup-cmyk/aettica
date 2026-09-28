/**
 * Tests for wake-ups (stage 8): src/wakeups.ts, the Jev check before them,
 * the wake prompt, and the API.
 *
 * Every model call goes to a fake nanoGPT (see helpers.ts). Jev's answers
 * are queued like any other reply, as JSON content. Wake-ups run only when
 * a test asks, through a `Wakeups` with a clock the test controls.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promptForChannel } from "../src/partner.ts";
import { describeWake, isNothing, type WakeContext } from "../src/prompt.ts";
import { createApp, type App } from "../src/server.ts";
import { validateSettings } from "../src/store.ts";
import { homeChannel, humanDuration, inQuietHours, Wakeups, type WakeEvent } from "../src/wakeups.ts";
import type { Channel } from "../src/types.ts";
import { startFakeNanoGpt, tempDir, testConfig, type FakeNanoGpt } from "./helpers.ts";

let fake: FakeNanoGpt;
let dir: ReturnType<typeof tempDir>;
let app: App;
let story: Channel;
let ooc: Channel;
/** The clock the wake-ups see. */
let now: Date;
let wakeups: Wakeups;

const HOUR = 3_600_000;

beforeEach(() => {
  fake = startFakeNanoGpt();
  dir = tempDir();
  app = createApp(testConfig(dir.path, fake.baseUrl));
  [story, ooc] = app.store.listChannels() as [Channel, Channel];
  // Noon, so default quiet hours (none) and any set below are predictable.
  now = new Date();
  now.setHours(12, 0, 0, 0);
  wakeups = new Wakeups(app.store, app.partner, app.decider, true, () => now);
});

afterEach(() => {
  app.summarizer.stop();
  app.store.close();
  fake.stop();
  dir.cleanup();
});

function settings(update: Record<string, unknown>) {
  app.store.updateSettings(validateSettings(update));
}

/** Something you wrote `hoursAgo` hours before `now`. */
function youWrote(hoursAgo: number, channel = ooc, content = "hey") {
  return app.store.addMessage({
    channelId: channel.id,
    author: "user",
    content,
    createdAt: new Date(now.getTime() - hoursAgo * HOUR).toISOString(),
  });
}

/** Jev's answer to the "reach" question. */
function jev(yes: number) {
  return { content: JSON.stringify({ answers: { reach: { choice: yes >= 0.5 ? "yes" : "no", probabilities: { yes, no: 1 - yes } } } }) };
}

/** Which requests went to Jev, and which to the writer. */
const jevRequests = () => fake.jevRequests;
const writerRequests = () => fake.requests;

async function wake(event: WakeEvent = "opened", detail = {}) {
  return wakeups.event(event, detail);
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

describe("helpers", () => {
  test("humanDuration", () => {
    expect(humanDuration(30_000)).toBe("1 minute");
    expect(humanDuration(5 * 60_000)).toBe("5 minutes");
    expect(humanDuration(3 * HOUR)).toBe("3 hours");
    expect(humanDuration(72 * HOUR)).toBe("3 days");
  });

  test("quiet hours, wrapping past midnight", () => {
    const at = (h: number) => {
      const d = new Date();
      d.setHours(h, 30, 0, 0);
      return d;
    };
    expect(inQuietHours(at(23), -1, 8)).toBe(false);
    expect(inQuietHours(at(23), 22, 8)).toBe(true);
    expect(inQuietHours(at(3), 22, 8)).toBe(true);
    expect(inQuietHours(at(8), 22, 8)).toBe(false);
    expect(inQuietHours(at(14), 13, 15)).toBe(true);
    expect(inQuietHours(at(15), 13, 15)).toBe(false);
  });

  test("the home channel is the OOC channel you talked in last", () => {
    const other = app.store.createChannel({ name: "chat", kind: "ooc" });
    youWrote(5, ooc);
    youWrote(1, other);
    expect(homeChannel(app.store, app.store.listChannels())!.id).toBe(other.id);
  });

  test("[nothing] is recognised, loosely", () => {
    expect(isNothing("[nothing]")).toBe(true);
    expect(isNothing("  [Nothing] ")).toBe(true);
    expect(isNothing("nothing much, you?")).toBe(false);
  });
});

describe("coming back", () => {
  test("after being away, Jev says yes, and your partner writes in OOC", async () => {
    youWrote(6);
    fake.jevReplies.push(jev(0.95));
    fake.replies.push({ content: "Welcome back! How was your day?" });
    const result = await wake();
    expect(result).toMatchObject({ outcome: "posted", reason: "away" });
    expect(result.messages[0]!.content).toBe("Welcome back! How was your day?");
    expect(app.store.lastMessage(ooc.id)!.content).toBe("Welcome back! How was your day?");
    // Jev saw how long it's been.
    expect(jevRequests()[0]!.messages.at(-1)!.content).toContain("6 hours");
    // And the writer was told why they're up.
    const prompt = JSON.stringify(writerRequests()[0]!.messages);
    expect(prompt).toContain("6 hours");
    expect(app.store.wakeLog.recent()[0]).toMatchObject({ reason: "away", outcome: "posted", channelId: ooc.id });
  });

  test("Jev saying no, or being unsure, keeps your partner quiet", async () => {
    youWrote(6);
    fake.jevReplies.push(jev(0.1));
    expect(await wake()).toMatchObject({ outcome: "declined" });
    expect(writerRequests()).toHaveLength(0);

    // Unsure: 60% isn't confident enough at the default 80%.
    app.store.wakeLog.recent(); // (the declined one doesn't start a cooldown)
    fake.jevReplies.push(jev(0.6));
    const result = await wake();
    expect(result.outcome).toBe("declined");
    expect(result.detail).toContain("unsure");
    expect(writerRequests()).toHaveLength(0);
  });

  test("a lower confidence setting lets a 60% yes through", async () => {
    settings({ decisionConfidence: 0.55 });
    youWrote(6);
    fake.jevReplies.push(jev(0.6));
    fake.replies.push({ content: "Hi again" });
    expect((await wake()).outcome).toBe("posted");
  });

  test("Jev failing means no wake-up (logged)", async () => {
    youWrote(6);
    fake.jevReplies.push({ status: 500, error: "down" });
    const result = await wake();
    expect(result.outcome).toBe("failed");
    expect(writerRequests()).toHaveLength(0);
    expect(app.store.jevLog.recent(new Date()).length).toBe(1);
  });

  test("with Jev off, your partner's own turn decides", async () => {
    settings({ decisionModel: "" });
    youWrote(6);
    fake.replies.push({ content: "[nothing]" });
    const result = await wake();
    expect(result).toMatchObject({ outcome: "quiet", messages: [] });
    expect(jevRequests()).toHaveLength(0);
    // "[nothing]" never becomes a message.
    expect(app.store.lastMessage(ooc.id)!.content).toBe("hey");
  });

  test("do_nothing counts as quiet", async () => {
    youWrote(6);
    fake.jevReplies.push(jev(0.9));
    fake.replies.push({ toolCalls: [{ name: "do_nothing", arguments: {} }] });
    expect((await wake()).outcome).toBe("quiet");
    expect(app.store.lastMessage(ooc.id)!.author).toBe("user");
  });

  test("just opening the app counts only when chatty, and not mid-conversation", async () => {
    youWrote(1);
    expect((await wake()).outcome).toBeNull(); // normal: "opened" doesn't count
    expect(fake.requests.length + fake.jevRequests.length).toBe(0);

    settings({ wakeups: "chatty" });
    youWrote(0.1);
    const result = await wake();
    expect(result.outcome).toBeNull();
    expect(result.detail).toContain("talking just now");

    now = new Date(now.getTime() + HOUR);
    fake.jevReplies.push(jev(0.9));
    fake.replies.push({ content: "Oh hi" });
    expect(await wake()).toMatchObject({ outcome: "posted", reason: "opened" });
  });
});

describe("the rules", () => {
  test("off means never", async () => {
    settings({ wakeups: "off" });
    youWrote(48);
    expect((await wake()).outcome).toBeNull();
    expect(fake.requests.length + fake.jevRequests.length).toBe(0);
    expect(app.store.wakeLog.recent()).toHaveLength(0);
  });

  test("quiet hours", async () => {
    settings({ quietStart: 10, quietEnd: 14 });
    youWrote(6);
    const result = await wake();
    expect(result.outcome).toBeNull();
    expect(result.detail).toContain("quiet hours");
  });

  test("never twice without you writing, and a cooldown", async () => {
    youWrote(6);
    fake.jevReplies.push(jev(0.9));
    fake.replies.push({ content: "Welcome back" });
    expect((await wake()).outcome).toBe("posted");

    // Hours later, still no reply from you: they wait.
    now = new Date(now.getTime() + 5 * HOUR);
    let result = await wake();
    expect(result.outcome).toBeNull();
    expect(result.detail).toContain("waiting for you");

    // You write, then leave; coming back soon after is within the cooldown.
    youWrote(0.5);
    settings({ awayHours: 0.25, wakeCooldownMinutes: 24 * 60 });
    result = await wake();
    expect(result.detail).toContain("too soon");
  });

  test("no API key, no wake-ups", async () => {
    const keyless = new Wakeups(app.store, app.partner, app.decider, false, () => now);
    youWrote(6);
    expect((await keyless.event("opened")).outcome).toBeNull();
  });
});

describe("a scene ending", () => {
  test("your partner hears how it went, with its summary", async () => {
    app.store.addMessage({ channelId: story.id, author: "user", content: "Kestrel knocks.", createdAt: new Date(now.getTime() - 60_000).toISOString() });
    const { sceneBreak } = app.store.addSceneBreak(story.id, "user", "The Storm");
    app.store.summaries.save(story.id, "scene", sceneBreak.id, "Kestrel found the lighthouse in a storm.", 99);
    youWrote(0.2, ooc);
    fake.jevReplies.push(jev(0.9));
    fake.replies.push({ content: "That storm scene was great." });
    const result = await wake("scene-ended", { channelId: story.id, breakId: sceneBreak.id });
    expect(result).toMatchObject({ outcome: "posted", reason: "scene-ended" });
    expect(jevRequests()[0]!.messages.at(-1)!.content).toContain("Kestrel found the lighthouse");
    expect(JSON.stringify(writerRequests()[0]!.messages)).toContain("Kestrel found the lighthouse");
  });

  test("describeWake explains a scene with no summary yet", () => {
    const context: WakeContext = { reason: "scene-ended", sinceUser: "3 minutes", waiting: [], scene: { channel: "story", title: "The Storm", summary: null } };
    const text = describeWake(context, false);
    expect(text).toContain("#story");
    expect(text).toContain("The Storm");
  });
});

describe("reviews", () => {
  test("a suggestion for your partner wakes them without asking Jev, even in quiet hours", async () => {
    settings({ quietStart: 10, quietEnd: 14 });
    const ilse = app.store.notebook.createEntry("partner", { kind: "character", name: "Ilse", editing: "suggest" });
    app.store.notebook.editEntry("user", ilse.id, { name: "Ilse Marrow" });
    youWrote(0.1);
    fake.replies.push({ toolCalls: [{ name: "do_nothing", arguments: {} }] });
    const result = await wake("review");
    expect(result.reason).toBe("review");
    expect(jevRequests()).toHaveLength(0);
    expect(JSON.stringify(writerRequests()[0]!.messages)).toContain("Ilse");
  });
});

describe("the prompt", () => {
  test("a wake-up turn's prompt says why, and allows doing nothing", () => {
    youWrote(6);
    const stack = promptForChannel(app.store, ooc.id, {
      wake: { reason: "away", sinceUser: "6 hours", waiting: ["Your proposal to delete #old is waiting for the user."] },
    });
    const text = JSON.stringify(stack);
    expect(text).toContain("6 hours");
    expect(text).toContain("#old");
    expect(text).toContain("[nothing]");
  });
});

describe("the API", () => {
  test("POST /api/wake answers straight away", async () => {
    const { status, data } = await call("POST", "/api/wake", { event: "opened" });
    expect(status).toBe(200);
    expect(data).toMatchObject({ ok: true });
  });

  test("GET /api/wakeups lists the log", async () => {
    youWrote(6);
    fake.jevReplies.push(jev(0.1));
    await wake();
    const { data } = await call("GET", "/api/wakeups");
    expect(data.wakeups).toHaveLength(1);
    expect(data.wakeups[0]).toMatchObject({ reason: "away", outcome: "declined" });
  });

  test("POST /api/jev/test, and the Jev log", async () => {
    fake.replies.push({ content: JSON.stringify({ answers: { pet: { choice: "yes", probabilities: { yes: 0.97, no: 0.03 } } } }) });
    const { data } = await call("POST", "/api/jev/test", {});
    expect(data.ok).toBe(true);
    const log = await call("GET", "/api/jev/log");
    expect(log.data.calls).toHaveLength(1);
    expect(log.data.calls[0]).toMatchObject({ purpose: "Test Jev", answeredBy: "jev" });
  });

  test("GET /api/state has a revision that moves with messages, and each channel's latest", async () => {
    const before = (await call("GET", "/api/state")).data;
    youWrote(0);
    const after = (await call("GET", "/api/state")).data;
    expect(after.revision).toBeGreaterThan(before.revision);
    expect(after.activity[ooc.id]).toMatchObject({ author: "user" });
  });

  test("settings are checked", async () => {
    expect((await call("PUT", "/api/settings", { wakeups: "loud" })).status).toBe(400);
    expect((await call("PUT", "/api/settings", { quietStart: 25 })).status).toBe(400);
    expect((await call("PUT", "/api/settings", { decisionConfidence: 2 })).status).toBe(400);
    expect((await call("PUT", "/api/settings", { decisionFallback: "profile:nope" })).status).toBe(404);
    const ok = await call("PUT", "/api/settings", { wakeups: "chatty", quietStart: 22, quietEnd: 7 });
    expect(ok.status).toBe(200);
    expect(ok.data.settings ?? ok.data).toMatchObject({ wakeups: "chatty", quietStart: 22 });
  });
});
