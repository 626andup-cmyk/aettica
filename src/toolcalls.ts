/**
 * Reading tool calls, including the messy ones.
 *
 * With tools, a model's reply can ask for actions ("tool calls"). The API
 * normally returns them in a separate `tool_calls` field, with arguments as
 * JSON text. In practice, models on nanoGPT vary a lot, and this file exists
 * so that one sloppy model doesn't break a turn:
 *
 *   - **Broken arguments.** JSON wrapped in ``` fences, with trailing
 *     commas, curly quotes, or encoded twice. `parseArguments` repairs what
 *     it safely can and otherwise explains what's wrong, and that
 *     explanation goes back to the model so it can try again.
 *   - **Tool calls written as text.** Some models, or providers that don't
 *     translate them, put the call in the reply itself, in their own
 *     training format. `extractTextToolCalls` recognises the common ones:
 *
 *       <tool_call>{"name": "...", "arguments": {...}}</tool_call>     (Qwen, GLM, Hermes)
 *       <|tool_call_begin|>functions.name:0<|tool_call_argument_begin|>{...}<|tool_call_end|>   (Kimi)
 *       <｜tool▁call▁begin｜>function<｜tool▁sep｜>name ```json {...} ```<｜tool▁call▁end｜>   (DeepSeek)
 *
 *     and takes them out of the text, so they never show up in a post.
 *
 * Every call is logged with where it came from (`native` or `text`), so
 * the tool log shows which models do what.
 */

/** A tool call to run, however it arrived. */
export interface ParsedCall {
  id: string;
  name: string;
  /** The arguments as written, to parse with `parseArguments`. */
  arguments: string;
  source: "native" | "text";
}

export type ParsedArguments = { ok: true; value: Record<string, unknown> } | { ok: false; error: string };

/**
 * Parse a tool call's arguments into an object, repairing common mistakes.
 * An empty string means no arguments.
 */
export function parseArguments(raw: string): ParsedArguments {
  let text = raw.trim();
  if (text === "") return { ok: true, value: {} };

  // ```json ... ``` around the JSON.
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) text = fenced[1]!;

  const attempts = [
    text,
    // Trailing commas before } or ], and curly quotes.
    text.replace(/,\s*([}\]])/g, "$1").replace(/[“”]/g, '"'),
  ];
  for (const attempt of attempts) {
    let value: unknown;
    try {
      value = JSON.parse(attempt);
    } catch {
      continue;
    }
    // Encoded twice: a JSON string that contains JSON.
    if (typeof value === "string") {
      try {
        value = JSON.parse(value);
      } catch {
        return { ok: false, error: "The arguments were a string, not a JSON object." };
      }
    }
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return { ok: true, value: value as Record<string, unknown> };
    }
    return { ok: false, error: "The arguments must be a JSON object, like {\"name\": \"...\"}." };
  }
  return { ok: false, error: `The arguments aren't valid JSON: ${raw.slice(0, 200)}` };
}

/** Special tokens that wrap text-format tool calls, removed along with them. */
const WRAPPERS = [
  /<\|tool_calls_section_begin\|>|<\|tool_calls_section_end\|>/g,
  /<｜tool▁calls▁begin｜>|<｜tool▁calls▁end｜>/g,
];

/**
 * Find tool calls written out in a reply's text, and take them out of it.
 *
 * @returns The calls found (with `source: "text"`), and the text without them.
 */
export function extractTextToolCalls(content: string): { calls: ParsedCall[]; content: string } {
  const calls: ParsedCall[] = [];
  const add = (name: string, args: string) =>
    calls.push({ id: `text_${calls.length}`, name: name.trim(), arguments: args.trim(), source: "text" });

  let text = content;

  // <tool_call>{"name": ..., "arguments": {...}}</tool_call>, or a last
  // one left unclosed because the reply was cut off.
  text = text.replace(/<tool_call>\s*([\s\S]*?)\s*(?:<\/tool_call>|$)/g, (_match, body: string) => {
    const parsed = parseArguments(body);
    if (parsed.ok && typeof parsed.value.name === "string") {
      const args = parsed.value.arguments ?? parsed.value.parameters ?? {};
      add(parsed.value.name, typeof args === "string" ? args : JSON.stringify(args));
    } else {
      // Unreadable: still report it, so the model hears what went wrong.
      add("(unreadable)", body);
    }
    return "";
  });

  // Kimi: <|tool_call_begin|>functions.pin:0<|tool_call_argument_begin|>{...}<|tool_call_end|>
  text = text.replace(
    /<\|tool_call_begin\|>\s*(?:functions\.)?([\w-]+)(?::\d+)?\s*<\|tool_call_argument_begin\|>\s*([\s\S]*?)\s*<\|tool_call_end\|>/g,
    (_match, name: string, args: string) => {
      add(name, args);
      return "";
    },
  );

  // DeepSeek: <｜tool▁call▁begin｜>function<｜tool▁sep｜>pin\n```json\n{...}\n```<｜tool▁call▁end｜>
  text = text.replace(
    /<｜tool▁call▁begin｜>\s*(?:function)?\s*<｜tool▁sep｜>\s*([\w-]+)\s*([\s\S]*?)\s*<｜tool▁call▁end｜>/g,
    (_match, name: string, args: string) => {
      add(name, args);
      return "";
    },
  );

  for (const wrapper of WRAPPERS) text = text.replace(wrapper, "");
  return { calls, content: calls.length > 0 ? text.trim() : content };
}
