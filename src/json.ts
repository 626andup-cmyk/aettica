/**
 * Getting JSON out of a model's reply.
 *
 * When a normal chat model is asked for "JSON only", it usually obliges, but
 * not always tidily: the JSON can come wrapped in ```json fences, after a
 * sentence like "Here are the shifts:", with a trailing comma, or with curly
 * quotes. `extractJson` finds the JSON and repairs what it safely can, the
 * same way src/toolcalls.ts forgives broken tool arguments.
 *
 * (Jev, the decision model, never needs this: its answers are typed by
 * design. This is for the fallback profile and the notebook keeper's writer.)
 */

import { stripReasoning } from "./nanogpt.ts";

/** Why a reply couldn't be read as JSON. */
export class JsonReplyError extends Error {
  constructor(readonly reply: string) {
    super("The model's reply wasn't the JSON it was asked for.");
    this.name = "JsonReplyError";
  }
}

/**
 * Find and parse the JSON value (object or list) in a reply.
 *
 * @throws JsonReplyError if there isn't one that can be read.
 */
export function extractJson(reply: string): unknown {
  let text = stripReasoning(reply).trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) text = fenced[1]!.trim();

  // From the first { or [ to the last matching } or ].
  const start = text.search(/[[{]/);
  if (start < 0) throw new JsonReplyError(reply);
  const close = text[start] === "{" ? "}" : "]";
  const end = text.lastIndexOf(close);
  if (end <= start) throw new JsonReplyError(reply);
  const candidate = text.slice(start, end + 1);

  for (const attempt of [candidate, repair(candidate)]) {
    try {
      return JSON.parse(attempt);
    } catch {
      // try the next one
    }
  }
  throw new JsonReplyError(reply);
}

/** Fix the usual small mistakes: trailing commas, curly quotes, comments. */
function repair(text: string): string {
  return text
    .replace(/\/\/[^\n"]*$/gm, "")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/,\s*([}\]])/g, "$1");
}
