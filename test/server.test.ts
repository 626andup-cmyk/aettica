/**
 * End-to-end tests for the server (src/server.ts), with a fake nanoGPT.
 *
 * Requests go straight to the app's `fetch` handler, so no port is opened for
 * Aettica itself, but everything behind it is real: routing, the partner
 * turn, prompt assembly, the HTTP call to the (fake) API, and saving.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CONTINUE_NUDGE } from "../src/prompt.ts";
import { createApp, type App } from "../src/server.ts";
import { startFakeNanoGpt, tempDir, testConfig, type FakeNanoGpt } from "./helpers.ts";

let fake: FakeNanoGpt;
let dir: ReturnType<typeof tempDir>;
let app: App;

beforeEach(() => {
  fake = startFakeNanoGpt();
  dir = tempDir();
  app = createApp(testConfig(dir.path, fake.baseUrl));
});

afterEach(() => {
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
  test("saves your message and the partner's reply", async () => {
    fake.replies.push({ content: "*Ilse looks up from the lamp.*" });

    const { status, data } = await call("POST", "/api/messages", { content: "I knock on the lighthouse door." });

    expect(status).toBe(200);
    expect(data.userMessage.content).toBe("I knock on the lighthouse door.");
    expect(data.partnerMessage.content).toBe("*Ilse looks up from the lamp.*");
    expect(data.partnerMessage.model).toBe(app.store.getSettings().model);
    expect(app.store.getMessages()).toHaveLength(2);
  });

  test("sends the assembled prompt stack and settings to the API", async () => {
    app.store.updateSettings({ temperature: 0.7, maxTokens: 321, model: "some/model" });
    await call("POST", "/api/messages", { content: "Hello" });

    const request = fake.requests[0]!;
    expect(request.auth).toBe("Bearer test-key");
    expect(request.model).toBe("some/model");
    expect(request.temperature).toBe(0.7);
    expect(request.max_tokens).toBe(321);
    expect(request.messages[0]!.role).toBe("system");
    expect(request.messages.at(-1)).toEqual({ role: "user", content: "Hello" });
  });

  test("keeps your message when the reply fails, and reports the error", async () => {
    fake.replies.push({ status: 401, error: "bad key" });

    const { status, data } = await call("POST", "/api/messages", { content: "Hello?" });

    expect(status).toBe(200);
    expect(data.partnerMessage).toBeUndefined();
    expect(data.error).toContain("rejected the API key");
    expect(data.error).toContain("bad key");
    expect(app.store.getMessages().map((m) => m.author)).toEqual(["user"]);
  });

  test("rejects an empty message", async () => {
    const { status } = await call("POST", "/api/messages", { content: "   " });
    expect(status).toBe(400);
    expect(fake.requests).toHaveLength(0);
  });

  test("strips <think> reasoning from replies", async () => {
    fake.replies.push({ content: "<think>They want drama.</think>\n\nThe storm breaks." });
    const { data } = await call("POST", "/api/messages", { content: "Go on." });
    expect(data.partnerMessage.content).toBe("The storm breaks.");
  });
});

describe("partner turns without a user message", () => {
  test("the partner can open an empty chat", async () => {
    const { status, data } = await call("POST", "/api/turn", {});
    expect(status).toBe(200);
    expect(data.partnerMessage.author).toBe("partner");
    expect(app.store.getMessages()).toHaveLength(1);
  });

  test("the partner can continue after their own post", async () => {
    app.store.addMessage("user", "Hi");
    app.store.addMessage("partner", "Hello.");

    await call("POST", "/api/turn", {});

    expect(fake.requests[0]!.messages.at(-1)).toEqual({ role: "user", content: CONTINUE_NUDGE });
    expect(app.store.getMessages().map((m) => m.author)).toEqual(["user", "partner", "partner"]);
  });

  test("a second turn while one is running is refused", async () => {
    fake.replies.push({ content: "slow", delayMs: 200 });
    const first = call("POST", "/api/turn", {});
    await Bun.sleep(20); // let the first turn start

    const second = await call("POST", "/api/turn", {});
    expect(second.status).toBe(409);

    expect((await first).status).toBe(200);
    expect(app.store.getMessages()).toHaveLength(1);
    expect(app.partner.busy).toBe(false);
  });

  test("an API failure is reported and leaves the chat unchanged", async () => {
    fake.replies.push({ status: 500, error: "upstream down" });
    const { status, data } = await call("POST", "/api/turn", {});
    expect(status).toBe(502);
    expect(data.error).toContain("upstream down");
    expect(app.store.getMessages()).toHaveLength(0);
    expect(app.partner.busy).toBe(false);
  });
});

describe("regenerate", () => {
  test("replaces the partner's last reply, without showing the old one to the model", async () => {
    app.store.addMessage("user", "Hi");
    const old = app.store.addMessage("partner", "Old reply");
    fake.replies.push({ content: "New reply" });

    const { status, data } = await call("POST", "/api/regenerate", {});

    expect(status).toBe(200);
    expect(data.replacedId).toBe(old.id);
    expect(app.store.getMessages().map((m) => m.content)).toEqual(["Hi", "New reply"]);
    expect(JSON.stringify(fake.requests[0]!.messages)).not.toContain("Old reply");
  });

  test("keeps the old reply if generation fails", async () => {
    app.store.addMessage("user", "Hi");
    app.store.addMessage("partner", "Old reply");
    fake.replies.push({ status: 429, error: "slow down" });

    const { status } = await call("POST", "/api/regenerate", {});

    expect(status).toBe(502);
    expect(app.store.getMessages().map((m) => m.content)).toEqual(["Hi", "Old reply"]);
  });

  test("refuses when the last message is yours", async () => {
    app.store.addMessage("user", "Hi");
    const { status } = await call("POST", "/api/regenerate", {});
    expect(status).toBe(400);
  });
});

describe("messages and settings", () => {
  test("edits, deletes and clears messages", async () => {
    const a = app.store.addMessage("user", "one");
    const b = app.store.addMessage("user", "two");

    expect((await call("PATCH", `/api/messages/${a.id}`, { content: "ONE" })).data.message.content).toBe("ONE");
    expect((await call("DELETE", `/api/messages/${b.id}`, {})).status).toBe(200);
    expect((await call("DELETE", `/api/messages/${b.id}`, {})).status).toBe(404);
    expect(app.store.getMessages().map((m) => m.content)).toEqual(["ONE"]);

    await call("DELETE", "/api/messages", {});
    expect(app.store.getMessages()).toHaveLength(0);
  });

  test("updates settings and rejects invalid ones", async () => {
    const ok = await call("PUT", "/api/settings", { temperature: 1.2 });
    expect(ok.data.settings.temperature).toBe(1.2);

    const bad = await call("PUT", "/api/settings", { temperature: 99 });
    expect(bad.status).toBe(400);
    expect(bad.data.error).toContain("temperature");
    expect(app.store.getSettings().temperature).toBe(1.2);
  });

  test("returns the full state", async () => {
    app.store.addMessage("user", "Hi");
    const { data } = await call("GET", "/api/state");
    expect(data.messages).toHaveLength(1);
    expect(data.settings.model).toBeString();
    expect(data.busy).toBe(false);
  });

  test("previews the prompt stack without calling the API", async () => {
    const { data } = await call("GET", "/api/prompt");
    expect(data.messages[0].role).toBe("system");
    expect(fake.requests).toHaveLength(0);
  });

  test("lists models from nanoGPT, sorted", async () => {
    const { data } = await call("GET", "/api/models");
    expect(data.models).toEqual(["alpha/model", "zeta/model"]);
  });
});

describe("safety", () => {
  test("refuses changes that aren't sent as JSON", async () => {
    const response = await app.fetch(
      new Request("http://localhost/api/turn", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "" }),
    );
    expect(response.status).toBe(415);
    expect(fake.requests).toHaveLength(0);
  });

  test("reports a missing API key clearly", async () => {
    const noKey = createApp(testConfig(dir.path, fake.baseUrl, { apiKey: "" }));
    const response = await noKey.fetch(
      new Request("http://localhost/api/turn", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }),
    );
    expect(response.status).toBe(502);
    expect(((await response.json()) as { error: string }).error).toContain("NANOGPT_API_KEY");
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
