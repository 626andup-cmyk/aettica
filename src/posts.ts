/**
 * Turning text into messages.
 *
 * What gets saved for a piece of text depends on the channel:
 *
 * | Channel        | Your post                              | Your partner's reply                      |
 * | -------------- | -------------------------------------- | ----------------------------------------- |
 * | OOC            | one message                            | one message, voicing no one               |
 * | RP, literary   | one post                               | one post, voicing the channel's character |
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
import type { Channel, UserCharacter } from "./types.ts";

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

/**
 * Turn your post into the messages to save.
 *
 * @param postingAs  In casual scenes: the character picked in the composer,
 *                   used for lines with no proxy tag. `null` posts as
 *                   yourself.
 */
export function postToMessages(
  channel: Channel,
  content: string,
  userCharacters: UserCharacter[],
  postingAs: string | null,
): TurnMessage[] {
  const base = { channelId: channel.id, author: "user" as const };
  if (channel.kind === "ooc") return [{ ...base, content, characters: [], mode: null }];
  if (channel.mode === "literary") return [{ ...base, content, characters: [], mode: "literary" }];

  // Casual: your characters can be named by prefix (`k:`) or by name (`Kestrel:`).
  const speakers = userCharacters.map((c) => ({ name: c.name, aliases: [c.prefix] }));
  return splitBubbles(content, speakers, postingAs).map((bubble) => ({
    ...base,
    content: bubble.text,
    characters: bubble.speaker ? [bubble.speaker] : [],
    mode: "casual" as const,
  }));
}

/**
 * Turn the model's reply into the messages to save.
 *
 *   - **OOC**: one message, voicing no one (the partner speaks as themselves).
 *   - **Literary**: one post voicing the channel's character.
 *   - **Casual**: one bubble per `Name: text` line, via `splitBubbles`.
 *     Lines without a name belong to the channel's character.
 */
export function replyToMessages(channel: Channel, content: string, model: string): TurnMessage[] {
  const base = { channelId: channel.id, author: "partner" as const, model };
  if (channel.kind === "ooc") return [{ ...base, content, characters: [], mode: null }];

  const character = channel.characterName || null;
  if (channel.mode === "literary") {
    return [{ ...base, content, characters: character ? [character] : [], mode: "literary" }];
  }

  const speakers = character ? [{ name: character, aliases: partnerAliases(character) }] : [];
  const bubbles = splitBubbles(content, speakers, character);
  // If the whole reply was tags with nothing after them, keep the raw text
  // rather than save nothing.
  const parts = bubbles.length > 0 ? bubbles : [{ speaker: character, text: content }];
  return parts.map((bubble) => ({
    ...base,
    content: bubble.text,
    characters: bubble.speaker ? [bubble.speaker] : [],
    mode: "casual" as const,
  }));
}

