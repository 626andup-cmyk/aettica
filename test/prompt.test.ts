/**
 * Tests for prompt assembly (src/prompt.ts): the prompt stack's order, what
 * gets left out, and the nudge that lets the partner write without a message.
 */

import { describe, expect, test } from "bun:test";
import {
  buildPromptStack,
  CONTINUE_NUDGE,
  OPENING_NUDGE,
  PARTNER_FRAMING,
  recentMessages,
  toChatHistory,
} from "../src/prompt.ts";
import type { Author, Message, Settings } from "../src/types.ts";

const settings: Settings = {
  partnerPrompt: "You are Arlo, a writer of grounded prose.",
  characterSheet: "Name: Ilse Marrow",
  model: "test/model",
  temperature: 0.9,
  maxTokens: 500,
  historyLimit: 40,
};

let nextId = 0;
function msg(author: Author, content: string): Message {
  return { id: String(nextId++), author, content, createdAt: new Date(0).toISOString() };
}

describe("buildPromptStack", () => {
  test("puts every instruction layer in one system message, in stack order", () => {
    const [system] = buildPromptStack(settings, [msg("user", "Hello")]);
    expect(system!.role).toBe("system");

    const text = system!.content;
    const framing = text.indexOf(PARTNER_FRAMING);
    const partner = text.indexOf(settings.partnerPrompt);
    const character = text.indexOf(settings.characterSheet);

    // Layer 1 (framing, then partner prompt) comes before layer 3 (character).
    expect(framing).toBeGreaterThanOrEqual(0);
    expect(partner).toBeGreaterThan(framing);
    expect(character).toBeGreaterThan(partner);
  });

  test("leaves out the layers stage 1 doesn't fill yet", () => {
    const [system] = buildPromptStack(settings, [msg("user", "Hello")]);
    expect(system!.content).not.toContain("Channel mode");
    expect(system!.content).not.toContain("Model notes");
  });

  test("leaves out an empty character sheet instead of sending an empty heading", () => {
    const [system] = buildPromptStack({ ...settings, characterSheet: "   " }, [msg("user", "Hi")]);
    expect(system!.content).not.toContain("The character you play");
  });

  test("follows the system message with the conversation", () => {
    const stack = buildPromptStack(settings, [msg("user", "Knock knock"), msg("partner", "Who's there?"), msg("user", "Lettuce")]);
    expect(stack.slice(1)).toEqual([
      { role: "user", content: "Knock knock" },
      { role: "assistant", content: "Who's there?" },
      { role: "user", content: "Lettuce" },
    ]);
  });

  test("adds a continue nudge when the chat ends on the partner (a turn without a user message)", () => {
    const stack = buildPromptStack(settings, [msg("user", "Hi"), msg("partner", "Hello there.")]);
    expect(stack.at(-1)).toEqual({ role: "user", content: CONTINUE_NUDGE });
  });

  test("adds an opening nudge when the chat is empty", () => {
    const stack = buildPromptStack(settings, []);
    expect(stack).toHaveLength(2);
    expect(stack[1]).toEqual({ role: "user", content: OPENING_NUDGE });
  });

  test("only sends the most recent historyLimit messages", () => {
    const messages = [msg("user", "one"), msg("partner", "two"), msg("user", "three")];
    const stack = buildPromptStack({ ...settings, historyLimit: 1 }, messages);
    expect(stack.slice(1)).toEqual([{ role: "user", content: "three" }]);
  });
});

describe("toChatHistory", () => {
  test("merges consecutive messages from the same author", () => {
    const history = toChatHistory([msg("user", "First."), msg("user", "Second."), msg("partner", "Reply.")]);
    expect(history).toEqual([
      { role: "user", content: "First.\n\nSecond." },
      { role: "assistant", content: "Reply." },
    ]);
  });

  test("skips messages that are only whitespace", () => {
    expect(toChatHistory([msg("user", "  \n "), msg("partner", "Hi")])).toEqual([{ role: "assistant", content: "Hi" }]);
  });
});

describe("recentMessages", () => {
  test("keeps the newest messages in their original order", () => {
    const messages = [msg("user", "a"), msg("user", "b"), msg("user", "c")];
    expect(recentMessages(messages, 2).map((m) => m.content)).toEqual(["b", "c"]);
  });
});
