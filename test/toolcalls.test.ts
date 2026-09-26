/**
 * Tests for reading tool calls (src/toolcalls.ts): repairing broken
 * arguments, and finding calls that models write out as text.
 */

import { describe, expect, test } from "bun:test";
import { extractTextToolCalls, parseArguments } from "../src/toolcalls.ts";

describe("parseArguments", () => {
  test.each([
    ['{"name": "Ilse"}', { name: "Ilse" }],
    ["", {}],
    ['```json\n{"name": "Ilse"}\n```', { name: "Ilse" }],
    ['{"name": "Ilse",}', { name: "Ilse" }],
    ["{“name”: “Ilse”}", { name: "Ilse" }],
    ['"{\\"name\\": \\"Ilse\\"}"', { name: "Ilse" }],
  ])("reads %j", (raw, value) => {
    expect(parseArguments(raw)).toEqual({ ok: true, value });
  });

  test.each([
    ["name: Ilse", /aren't valid JSON/],
    ["[1, 2]", /must be a JSON object/],
    ['"just words"', /a string, not a JSON object/],
  ])("explains what's wrong with %j", (raw, error) => {
    const parsed = parseArguments(raw);
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.error).toMatch(error);
  });
});

describe("extractTextToolCalls", () => {
  test("finds <tool_call> blocks (Qwen, GLM, Hermes) and takes them out of the text", () => {
    const found = extractTextToolCalls(
      'Let me check.\n<tool_call>\n{"name": "read_notebook_entry", "arguments": {"name": "Ilse"}}\n</tool_call>',
    );
    expect(found.calls).toMatchObject([{ name: "read_notebook_entry", arguments: '{"name":"Ilse"}', source: "text" }]);
    expect(found.content).toBe("Let me check.");
  });

  test("accepts `parameters` instead of `arguments`, and an unclosed last block", () => {
    const found = extractTextToolCalls('<tool_call>{"name": "do_nothing", "parameters": {}}');
    expect(found.calls).toMatchObject([{ name: "do_nothing", arguments: "{}" }]);
    expect(found.content).toBe("");
  });

  test("finds Kimi's format", () => {
    const text =
      '<|tool_calls_section_begin|><|tool_call_begin|>functions.pin_to_channel:0<|tool_call_argument_begin|>{"name": "Tamsin"}<|tool_call_end|><|tool_calls_section_end|>';
    const found = extractTextToolCalls(text);
    expect(found.calls).toMatchObject([{ name: "pin_to_channel", arguments: '{"name": "Tamsin"}' }]);
    expect(found.content).toBe("");
  });

  test("finds DeepSeek's format", () => {
    const text =
      'Sure.<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>search_notebook\n```json\n{"query": "sea"}\n```<｜tool▁call▁end｜><｜tool▁calls▁end｜>';
    const found = extractTextToolCalls(text);
    expect(found.calls).toMatchObject([{ name: "search_notebook" }]);
    expect(parseArguments(found.calls[0]!.arguments)).toEqual({ ok: true, value: { query: "sea" } });
    expect(found.content).toBe("Sure.");
  });

  test("reports an unreadable block instead of dropping it", () => {
    expect(extractTextToolCalls("<tool_call>oops</tool_call>").calls).toMatchObject([{ name: "(unreadable)" }]);
  });

  test("leaves ordinary text alone", () => {
    expect(extractTextToolCalls("*She reaches for the lamp.*")).toEqual({ calls: [], content: "*She reaches for the lamp.*" });
  });
});
