/**
 * Shared test helpers.
 *
 * The most important one is `startFakeNanoGpt`: a tiny local server that
 * pretends to be nanoGPT. Tests point Aettica at it (via the base URL), so
 * the real request code runs end to end without needing an API key, network
 * access, or spending any money.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config.ts";
import type { ChatMessage } from "../src/types.ts";

/** What the fake server should do with the next request. */
export type FakeReply =
  | { content: string; finishReason?: string }
  | { status: number; error: string }
  /** Wait this many ms before replying, for testing overlapping turns. */
  | { content: string; delayMs: number }
  /** Start the reply, then never finish it: a model that stalls halfway. */
  | { stallMidReply: true };

export interface FakeNanoGpt {
  baseUrl: string;
  /** Every chat completion request received, oldest first. */
  requests: Array<{ model: string; messages: ChatMessage[]; temperature: number; max_tokens: number; auth: string | null }>;
  /** Queue replies; each request takes the next one. Defaults to "Reply N". */
  replies: FakeReply[];
  stop: () => void;
}

export function startFakeNanoGpt(): FakeNanoGpt {
  const fake: FakeNanoGpt = { baseUrl: "", requests: [], replies: [], stop: () => {} };

  const server = Bun.serve({
    port: 0, // let the OS pick a free port
    async fetch(request) {
      const path = new URL(request.url).pathname;

      if (path === "/v1/models") {
        return Response.json({ data: [{ id: "zeta/model" }, { id: "alpha/model" }] });
      }

      if (path === "/v1/chat/completions") {
        const body = (await request.json()) as Omit<FakeNanoGpt["requests"][number], "auth">;
        fake.requests.push({ ...body, auth: request.headers.get("authorization") });
        const reply = fake.replies.shift() ?? { content: `Reply ${fake.requests.length}` };

        if ("status" in reply) {
          return Response.json({ error: { message: reply.error } }, { status: reply.status });
        }
        if ("stallMidReply" in reply) {
          const stream = new ReadableStream({
            start: (controller) => controller.enqueue(new TextEncoder().encode('{"choices": [')),
          });
          return new Response(stream, { headers: { "Content-Type": "application/json" } });
        }
        if ("delayMs" in reply) await Bun.sleep(reply.delayMs);
        return Response.json({
          model: body.model,
          choices: [
            {
              message: { role: "assistant", content: reply.content },
              finish_reason: "finishReason" in reply ? reply.finishReason : "stop",
            },
          ],
        });
      }

      return new Response("not found", { status: 404 });
    },
  });

  fake.baseUrl = `http://127.0.0.1:${server.port}/v1`;
  fake.stop = () => server.stop(true);
  return fake;
}

/** A fresh, empty temporary folder, plus a function that deletes it. */
export function tempDir(): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), "aettica-test-"));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

/** A config suitable for tests, pointing at a fake API and a temp data folder. */
export function testConfig(dataDir: string, apiBaseUrl: string, overrides: Partial<Config> = {}): Config {
  return {
    host: "127.0.0.1",
    port: 0,
    dataDir,
    publicDir: join(import.meta.dir, "..", "public"),
    themesDir: join(import.meta.dir, "..", "themes"),
    apiKey: "test-key",
    apiBaseUrl,
    requestTimeoutMs: 5000,
    ...overrides,
  };
}
