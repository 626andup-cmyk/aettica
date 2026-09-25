/**
 * Splitting casual-mode text into bubbles.
 *
 * In casual mode every message is one short bubble voiced by one character,
 * like a group chat (or Tupperbox on Discord). Text arrives as a block,
 * though: your composer box, or your partner's whole reply. This file splits
 * such a block into bubbles, using lines that start with a speaker's name
 * or prefix and a colon:
 *
 *   k: *waves*                ->  Kestrel: "*waves*"
 *   hi!                       ->  (same bubble, next line)
 *   Ilse: Door's open.        ->  Ilse Marrow: "Door's open."
 *
 * The same rules serve both directions:
 *
 *   - **Your posts**: speakers are your characters (Settings → Your
 *     characters), matched by prefix or name.
 *   - **Your partner's replies**: speakers are the characters they play in
 *     the channel, matched by full or first name. The model is asked to use
 *     exactly this `Name: text` format (see `src/prompt.ts`).
 *
 * Only *known* speakers count. A line like `Note: the tide is out` stays as
 * text, unless someone is actually called Note.
 */

/** Someone who can speak in a bubble. */
export interface Speaker {
  /** The name stored on the message, e.g. "Ilse Marrow". */
  name: string;
  /** Other ways a line can start, e.g. ["k"] or ["Ilse"]. Matched ignoring case. */
  aliases: string[];
}

/** One bubble: who speaks it (or `null` for no one) and what it says. */
export interface Bubble {
  speaker: string | null;
  text: string;
}

/**
 * A line starting with a possible speaker tag: up to 40 characters with no
 * colon or line break, then a colon. The tag is only used if it matches a
 * known speaker.
 */
const TAGGED_LINE = /^\s*([^:\n]{1,40}?)\s*:[ \t]?(.*)$/;

/**
 * Split text into bubbles.
 *
 * @param text      The block of text.
 * @param speakers  Who may speak (see `Speaker`).
 * @param fallback  Who speaks lines before the first tag: the character you
 *                  picked in the composer, or the channel's character for
 *                  your partner. `null` for no one.
 * @returns         The bubbles in order, with empty ones dropped. Text with
 *                  no tags at all becomes a single bubble for `fallback`.
 */
export function splitBubbles(text: string, speakers: Speaker[], fallback: string | null): Bubble[] {
  // Build a lookup from every lowercase name/alias to the speaker's name.
  const lookup = new Map<string, string>();
  for (const speaker of speakers) {
    for (const key of [speaker.name, ...speaker.aliases]) {
      if (key.trim() !== "") lookup.set(key.trim().toLowerCase(), speaker.name);
    }
  }

  const bubbles: Bubble[] = [];
  let current: Bubble = { speaker: fallback, text: "" };

  for (const line of text.split("\n")) {
    const match = line.match(TAGGED_LINE);
    const speaker = match ? lookup.get(match[1]!.toLowerCase()) : undefined;
    if (match && speaker !== undefined) {
      // A new speaker tag starts a new bubble.
      bubbles.push(current);
      current = { speaker, text: match[2]! };
    } else {
      // Any other line continues the current bubble.
      current.text = current.text === "" ? line : `${current.text}\n${line}`;
    }
  }
  bubbles.push(current);

  return bubbles.map((b) => ({ ...b, text: b.text.trim() })).filter((b) => b.text !== "");
}

/**
 * Aliases for a character your partner plays: their first name, if their
 * name has more than one word ("Ilse Marrow" can also be "Ilse").
 */
export function partnerAliases(name: string): string[] {
  const first = name.trim().split(/\s+/)[0] ?? "";
  return first !== "" && first !== name.trim() ? [first] : [];
}
