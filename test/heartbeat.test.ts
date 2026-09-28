/**
 * Tests for the heartbeat (src/heartbeat.ts), the idea drawer
 * (src/ideas.ts) and notifications (src/notify.ts).
 *
 * The writer's ideas come from the fake nanoGPT's `replies`; Jev's grades
 * and checks from `jevReplies` (unsure when none are queued).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { gradeSeries, Heartbeat, readIdeas } from "../src/heartbeat.ts";
import { Presence, PRESENCE_TIMEOUT_MS, type Notification } from "../src/notify.ts";
import { createApp, type App } from "../src/server.ts";
import { validateSettings } from "../src/store.ts";
import { Wakeups } from "../src/wakeups.ts";
import type { Channel } from "../src/types.ts";
import { startFakeNanoGpt, tempDir, testConfig, type FakeNanoGpt } from "./helpers.ts";

let fake: FakeNanoGpt;
let dir: ReturnType<typeof tempDir>;
let app: App;
let ooc: Channel;
let now: Date;
let wakeups: Wakeups;
let heartbeat: Heartbeat;
let notified: Notification[];

const HOUR = 3_600_000;

beforeEach(() => {
  fake = startFakeNanoGpt();
  dir = tempDir();
  notified = [];
  app = createApp(testConfig(dir.path, fake.baseUrl, { notifier: { available: () => true, notify: (n) => notified.push(n) } }));
  ooc = app.store.listChannels()[1]!;
  now = new Date();
  now.setHours(12, 0, 0, 0);
  wakeups = new Wakeups(app.store, app.partner, app.decider, true, () => now);
  wakeups.onPosted = app.wakeups.onPosted; // notifications, as the server sets them up
  heartbeat = new Heartbeat(app.store, { apiKey: "k", baseUrl: fake.baseUrl, timeoutMs: 5000 }, app.decider, wakeups, () => now, () => 0.5);
  settings({ heartbeatHours: 6 });
});

afterEach(() => {
  heartbeat.stop();
  app.summarizer.stop();
  app.store.close();
  fake.stop();
  dir.cleanup();
});

function settings(update: Record<string, unknown>) {
  app.store.updateSettings(validateSettings(update));
}

function youWrote(hoursAgo: number, content = "night!") {
  app.store.addMessage({ channelId: ooc.id, author: "user", content, createdAt: new Date(now.getTime() - hoursAgo * HOUR).toISOString() });
}

const ideas = (...list: [string, string][]) => ({ content: JSON.stringify({ ideas: list.map(([kind, idea]) => ({ kind, idea })) }) });

/** Jev's grades: for each idea, p(yes) for all three questions. */
function grades(...ps: number[]) {
  const answers: Record<string, object> = {};
  ps.forEach((p, i) => {
    for (let j = 0; j < 3; j++) answers[`i${i}~${j}`] = { choice: p >= 0.5 ? "yes" : "no", probabilities: { yes: p, no: 1 - p } };
  });
  return { content: JSON.stringify({ answers }) };
}
const reach = (p: number) => ({ content: JSON.stringify({ answers: { reach: { choice: p >= 0.5 ? "yes" : "no", probabilities: { yes: p, no: 1 - p } } } }) });

describe("pieces", () => {
  test("reading ideas", () => {
    expect(readIdeas('{"ideas": [{"kind": "story", "idea": " A heist in a lighthouse. "}, {"kind": "weird", "idea": "x"}, {"idea": ""}]}')).toEqual([
      { kind: "story", content: "A heist in a lighthouse." },
      { kind: "thought", content: "x" },
    ]);
    expect(readIdeas("nope")).toEqual([]);
  });

  test("grading asks three things, including whether it's fresh", () => {
    const series = gradeSeries("A heist", 2);
    expect(series.id).toBe("i2");
    expect(series.phrasings).toHaveLength(3);
    expect(series.phrasings[0]).toContain("already");
  });

  test("presence times out", () => {
    let t = 0;
    const presence = new Presence(() => t);
    expect(presence.isVisible()).toBe(false);
    presence.set(true);
    expect(presence.isVisible()).toBe(true);
    t = PRESENCE_TIMEOUT_MS + 1;
    expect(presence.isVisible()).toBe(false);
    presence.set(true);
    presence.set(false);
    expect(presence.isVisible()).toBe(false);
  });
});

describe("the heartbeat", () => {
  test("off, or not yet due: nothing", async () => {
    settings({ heartbeatHours: 0 });
    expect((await heartbeat.tick()).outcome).toBe("off");
    settings({ heartbeatHours: 6 });
    // The first check only schedules: 6 hours × (0.8 + 0.4 × 0.5) = 6 hours.
    expect((await heartbeat.tick()).outcome).toBe("not-due");
    expect(heartbeat.nextAt()!.getTime()).toBe(now.getTime() + 6 * HOUR);
    now = new Date(now.getTime() + 5 * HOUR);
    expect((await heartbeat.tick()).outcome).toBe("not-due");
    expect(fake.requests.length + fake.jevRequests.length).toBe(0);
  });

  test("the rules come first, before any ideas", async () => {
    settings({ quietStart: 10, quietEnd: 14 });
    youWrote(8);
    const beat = await heartbeat.tick(true);
    expect(beat).toMatchObject({ outcome: "blocked", detail: "It's quiet hours." });
    expect(fake.requests).toHaveLength(0);
  });

  test("the best exciting idea is shared; the rest are saved or dropped", async () => {
    youWrote(8);
    fake.replies.push(
      ideas(["story", "A heist in the lighthouse."], ["character", "A bell-maker who lies."], ["twist", "Something generic."]),
      { content: "Okay, random idea: what if Ilse's lighthouse was the vault in a heist?" },
    );
    fake.jevReplies.push(grades(0.95, 0.85, 0.1), reach(0.9));
    const beat = await heartbeat.tick(true);
    expect(beat.outcome).toBe("woke");
    expect(beat.wake).toMatchObject({ outcome: "posted", reason: "heartbeat" });
    // The idea was in the writer's prompt.
    expect(JSON.stringify(fake.requests[1]!.messages)).toContain("A heist in the lighthouse.");
    const byContent = Object.fromEntries(app.store.ideas.list().map((i) => [i.content, i.status]));
    expect(byContent).toEqual({ "A heist in the lighthouse.": "shared", "A bell-maker who lies.": "drawer", "Something generic.": "dropped" });
    // You weren't looking: a notification.
    expect(notified).toEqual([
      { title: "Arlo in #ooc", text: "Okay, random idea: what if Ilse's lighthouse was the vault in a heist?", channelId: ooc.id },
    ]);
  });

  test("not the moment: the idea waits in the drawer", async () => {
    youWrote(8);
    fake.replies.push(ideas(["story", "A heist."]));
    fake.jevReplies.push(grades(0.95), reach(0.1));
    const beat = await heartbeat.tick(true);
    expect(beat.wake).toMatchObject({ outcome: "declined" });
    expect(app.store.ideas.list()[0]).toMatchObject({ status: "drawer" });
  });

  test("no notification while the app is on screen", async () => {
    app.presence.set(true);
    youWrote(8);
    fake.replies.push(ideas(["story", "A heist."]), { content: "Idea!" });
    fake.jevReplies.push(grades(0.95), reach(0.9));
    await heartbeat.tick(true);
    expect(notified).toEqual([]);
  });

  test("nothing exciting and a short silence: nothing sent", async () => {
    youWrote(2);
    fake.replies.push(ideas(["story", "Meh."]));
    // Unsure grades (none queued): the idea is saved.
    const beat = await heartbeat.tick(true);
    expect(beat.outcome).toBe("no-ideas");
    expect(app.store.ideas.list()[0]!.status).toBe("drawer");
  });

  test("nothing exciting after a long silence: a just-because check-in, with the drawer", async () => {
    app.store.ideas.add({ kind: "character", content: "A bell-maker who lies.", grade: 0.7, status: "drawer", note: "" });
    youWrote(10);
    fake.replies.push(ideas(["story", "Meh."]), { content: "Hey, been thinking about that bell-maker idea." });
    fake.jevReplies.push(grades(0.2), reach(0.9));
    // Which drawer ideas did the message bring up?
    fake.jevReplies.push({ content: JSON.stringify({ answers: { "r0~0": { choice: "yes", probabilities: { yes: 0.95, no: 0.05 } }, "r0~1": { choice: "yes", probabilities: { yes: 0.9, no: 0.1 } } } }) });
    const beat = await heartbeat.tick(true);
    expect(beat.wake).toMatchObject({ outcome: "posted" });
    expect(JSON.stringify(fake.requests[1]!.messages)).toContain("A bell-maker who lies.");
    expect(app.store.ideas.list().find((i) => i.content === "A bell-maker who lies.")!.status).toBe("shared");
  });
});

describe("the drawer on other wake-ups", () => {
  test("offered when you come back, and kept if not brought up", async () => {
    app.store.ideas.add({ kind: "twist", content: "The bell was never lost.", grade: 0.8, status: "drawer", note: "" });
    youWrote(6);
    fake.jevReplies.push(reach(0.9));
    fake.replies.push({ content: "Welcome back!" });
    await wakeups.event("opened");
    expect(JSON.stringify(fake.requests[0]!.messages)).toContain("The bell was never lost.");
    // Unsure whether it was brought up: stays in the drawer.
    expect(app.store.ideas.list()[0]!.status).toBe("drawer");
  });
});

describe("the API", () => {
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

  test("presence, ideas, state, settings", async () => {
    expect((await call("POST", "/api/presence", { visible: true })).status).toBe(200);
    expect(app.presence.isVisible()).toBe(true);
    const idea = app.store.ideas.add({ kind: "story", content: "x", grade: 0.5, status: "drawer", note: "" });
    expect((await call("GET", "/api/ideas")).data.ideas).toHaveLength(1);
    expect((await call("DELETE", `/api/ideas/${idea.id}`, {})).data.ideas).toEqual([]);
    const state = (await call("GET", "/api/state")).data;
    expect(state.notifications).toBe(true);
    expect((await call("PUT", "/api/settings", { heartbeatHours: 0.5 })).status).toBe(400);
    expect((await call("PUT", "/api/settings", { heartbeatHours: 200 })).status).toBe(400);
  });

  test("beat now", async () => {
    // Chattiness off, so nothing is spent.
    settings({ wakeups: "off" });
    const { data } = await call("POST", "/api/heartbeat", {});
    expect(data.beat.outcome).toBe("blocked");
  });
});
