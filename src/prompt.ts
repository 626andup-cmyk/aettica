/**
 * Prompt assembly: turning the chat into what the model actually reads.
 *
 * A model has no memory between requests. Every time your partner takes a
 * turn, we rebuild the whole context from scratch and send it along. The
 * design doc calls this the *prompt stack*, and it always has the same five
 * layers in the same order:
 *
 *   1. Partner identity and writing style   (who is writing)
 *   2. Channel mode instructions            (literary or casual)
 *   3. Character sheets and pinned entries  (who they are playing)
 *   4. Connection profile's model-quirk     (taming this particular model)
 *   5. Scene summaries and recent messages  (what has happened)
 *
 * Layers 1–4 are instructions, so they are joined into one `system` message.
 * Layer 5 is the conversation itself, sent as alternating `user`/`assistant`
 * messages after it.
 *
 * Stage 1 fills layers 1, 3 and 5. Layers 2 and 4 have their slots here
 * already, empty, so later stages add content without reshaping this file.
 */

import type { ChatMessage, Message, Settings } from "./types.ts";

/**
 * Fixed framing that comes before your partner prompt in layer 1.
 *
 * Your partner prompt describes *who* the partner is. This explains the
 * *situation*: that they are a writer collaborating with you, not the
 * character itself. It's the core idea of Aettica, so it isn't editable.
 */
export const PARTNER_FRAMING = `You are the user's roleplay partner: a writer with your own voice and style, collaborating with them on a story. You are not an assistant, and you are not the character you play. You are the author behind them.

The user writes for their own character. You write for yours. Never write the user's character's actions, dialogue or thoughts.

Write only your next post, in character, with no preamble and no out-of-character commentary.`;

/**
 * Message sent when the partner takes a turn without a new message from you.
 *
 * Most chat models expect the conversation to end on a `user` message and get
 * confused (or refuse) if it ends on their own reply. So when the partner is
 * continuing their own post, or starting an empty chat, we end the stack with
 * this short out-of-character nudge. It's never saved or shown in the chat.
 */
export const CONTINUE_NUDGE =
  "(OOC: No new post from me this time. Take your next turn and move the story forward.)";

/** Used instead of `CONTINUE_NUDGE` when the chat is completely empty. */
export const OPENING_NUDGE =
  "(OOC: The story hasn't started yet. Write an opening post that sets the scene and gives my character a way in.)";

/**
 * One labelled section of the system prompt. Keeping the label next to the
 * text makes the assembled prompt readable when you inspect it, and helps the
 * model tell the sections apart.
 */
interface Layer {
  title: string;
  content: string | null;
}

/**
 * Build the five-layer prompt stack for one partner turn.
 *
 * @param settings  The current chat settings (partner prompt, sheet, etc.).
 * @param messages  The whole chat, oldest first. Only the most recent
 *                  `settings.historyLimit` messages are included.
 * @returns         The messages to send to the chat completions API.
 */
export function buildPromptStack(settings: Settings, messages: Message[]): ChatMessage[] {
  const layers: Layer[] = [
    // Layer 1: who is writing. The fixed framing, then your partner prompt.
    {
      title: "Who you are",
      content: joinNonEmpty([PARTNER_FRAMING, settings.partnerPrompt]),
    },
    // Layer 2: channel mode (literary/casual). Arrives in stage 3.
    { title: "Channel mode", content: null },
    // Layer 3: the character(s) being played. Stage 4 replaces this single
    // sheet with every notebook entry pinned to the channel.
    { title: "The character you play", content: settings.characterSheet },
    // Layer 4: model-quirk prompt from the connection profile. Stage 5.
    { title: "Model notes", content: null },
  ];

  const system: ChatMessage = { role: "system", content: renderLayers(layers) };

  // Layer 5: the recent conversation. (Stage 7 puts scene summaries first.)
  const history = toChatHistory(recentMessages(messages, settings.historyLimit));

  // If the conversation doesn't end on your message, add a nudge so the model
  // knows it's being asked to continue. This is what lets the partner take a
  // turn without you writing anything: the design's core rule.
  const last = history.at(-1);
  if (!last || last.role !== "user") {
    history.push({ role: "user", content: last ? CONTINUE_NUDGE : OPENING_NUDGE });
  }

  return [system, ...history];
}

/**
 * Turn the layers into one system prompt, skipping empty ones.
 * Each layer becomes a Markdown heading followed by its text.
 */
export function renderLayers(layers: Layer[]): string {
  return layers
    .filter((layer) => layer.content && layer.content.trim() !== "")
    .map((layer) => `## ${layer.title}\n\n${layer.content!.trim()}`)
    .join("\n\n");
}

/** The last `limit` messages, oldest first. */
export function recentMessages(messages: Message[], limit: number): Message[] {
  return limit > 0 ? messages.slice(-limit) : [];
}

/**
 * Convert saved chat messages into API messages.
 *
 * Your messages become `user`, your partner's become `assistant`. If two
 * messages in a row have the same author (say you sent two posts before the
 * partner replied), they are merged into one. Some models reject two `user`
 * messages in a row, and merging never loses anything.
 */
export function toChatHistory(messages: Message[]): ChatMessage[] {
  const history: ChatMessage[] = [];
  for (const message of messages) {
    const content = message.content.trim();
    if (content === "") continue;

    const role = message.author === "user" ? "user" : "assistant";
    const previous = history.at(-1);
    if (previous && previous.role === role) {
      previous.content += `\n\n${content}`;
    } else {
      history.push({ role, content });
    }
  }
  return history;
}

function joinNonEmpty(parts: string[]): string {
  return parts
    .map((p) => p.trim())
    .filter((p) => p !== "")
    .join("\n\n");
}
