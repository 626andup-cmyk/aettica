/**
 * Turning text into messages.
 *
 * What gets saved for a piece of text depends on the channel:
 *
 * | Channel        | Your post                              | Your partner's reply                      |
 * | -------------- | -------------------------------------- | ----------------------------------------- |
 * | OOC            | one message                            | one message, voicing no one               |
 * | RP, literary   | one post                               | one post, voicing the characters it names |
 * | RP, casual     | one bubble per character (proxy tags)  | one bubble per `Name:` line               |
 *
 * Messages made from one piece of text are saved together as a *turn* (see
 * `Store.addTurn`), so a casual reply's bubbles can be regenerated as one.
 *
 * Typing `=====` alone (optionally followed by a title) in an RP channel is
 * a scene break instead of a post; see `parseSceneBreak`.
 */

import { partnerAliases, splitBubbles } from "./bubbles.ts";
import type { NewMessage } from "./store.ts";
import type { Channel } from "./types.ts";

/** A message ready to be saved as part of a turn. */
export type TurnMessage = Omit<NewMessage, "turnId">;

/**
 * If the text is a scene break command, return the scene's title (possibly
 * empty). Otherwise return `null`.
 *
 *   =====              ->  ""
 *   ===== The Storm    ->  "The Storm"
 *   ===== \nmore text   ->  null (a scene break is a single line)
 */
export function parseSceneBreak(text: string): string | null {
  const match = text.trim().match(/^={5,}[ \t]*([^\n]*)$/);
  return match ? match[1]!.trim() : null;
}

/** A character who can speak: a name, and an optional proxy prefix (your characters). */
export interface Voice {
  name: string;
  proxyPrefix?: string | null;
}

/**
 * Turn your post into the messages to save.
 *
 * @param yourCharacters  Every character of yours in the notebook. In casual
 *                        scenes, a line starting with one's prefix (`k:`) or
 *                        name (`Kestrel:`) is posted as them.
 * @param postingAs       In casual scenes: the character picked in the
 *                        composer, used for lines with no tag. `null` posts
 *                        as yourself.
 */
export function postToMessages(
  channel: Channel,
  content: string,
  yourCharacters: Voice[],
  postingAs: string | null,
): TurnMessage[] {
  const base = { channelId: channel.id, author: "user" as const };
  if (channel.kind === "ooc") return [{ ...base, content, characters: [], mode: null }];
  if (channel.mode === "literary") return [{ ...base, content, characters: [], mode: "literary" }];

  const speakers = yourCharacters.map((c) => ({ name: c.name, aliases: c.proxyPrefix ? [c.proxyPrefix] : [] }));
  return splitBubbles(content, speakers, postingAs).map((bubble) => ({
    ...base,
    content: bubble.text,
    characters: bubble.speaker ? [bubble.speaker] : [],
    mode: "casual" as const,
  }));
}

/**
 * Which of the partner's characters a literary post voices: those it
 * mentions by full or first name. If it mentions none and there's only one
 * character, that one; otherwise none (narration).
 */
export function mentionedCharacters(content: string, partnerCharacters: Voice[]): string[] {
  const lower = content.toLowerCase();
  const mentioned = partnerCharacters
    .filter((c) => [c.name, ...partnerAliases(c.name)].some((n) => new RegExp(`\\b${escapeRegExp(n.toLowerCase())}\\b`).test(lower)))
    .map((c) => c.name);
  if (mentioned.length > 0) return mentioned;
  return partnerCharacters.length === 1 ? [partnerCharacters[0]!.name] : [];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Turn the model's reply into the messages to save.
 *
 *   - **OOC**: one message, voicing no one (the partner speaks as themselves).
 *   - **Literary**: one post, voicing the characters it mentions
 *     (see `mentionedCharacters`).
 *   - **Casual**: one bubble per `Name: text` line, via `splitBubbles`.
 *     Lines without a name belong to the first character in the cast.
 *
 * @param partnerCharacters  The characters your partner plays in this
 *                           channel's cast, in cast order.
 */
export function replyToMessages(
  channel: Channel,
  content: string,
  model: string,
  partnerCharacters: Voice[],
): TurnMessage[] {
  const base = { channelId: channel.id, author: "partner" as const, model };
  if (channel.kind === "ooc") return [{ ...base, content, characters: [], mode: null }];

  if (channel.mode === "literary") {
    return [{ ...base, content, characters: mentionedCharacters(content, partnerCharacters), mode: "literary" }];
  }

  const first = partnerCharacters[0]?.name ?? null;
  const speakers = partnerCharacters.map((c) => ({ name: c.name, aliases: partnerAliases(c.name) }));
  const bubbles = splitBubbles(content, speakers, first);
  // If the whole reply was tags with nothing after them, keep the raw text
  // rather than save nothing.
  const parts = bubbles.length > 0 ? bubbles : [{ speaker: first, text: content }];
  return parts.map((bubble) => ({
    ...base,
    content: bubble.text,
    characters: bubble.speaker ? [bubble.speaker] : [],
    mode: "casual" as const,
  }));
}
