/**
 * Prompt assembly: turning a channel into what the model actually reads.
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
 * The stack depends on the kind of channel:
 *
 *   - **RP channels**: layer 1 frames the partner as the author of a story,
 *     layer 3 is the channel's character sheet.
 *   - **OOC channels**: layer 1 frames the partner as themselves, talking to
 *     you as a friend, and layer 3 lists the channels on the server so they
 *     know what storylines exist. (Stage 7 adds a summary of each.)
 *
 * In RP channels, layer 2 holds the instructions for the current scene's
 * mode (literary or casual), and layer 5 shows scene breaks where they fall.
 * Layer 4 has its slot here already, empty, so stage 5 adds content without
 * reshaping this file.
 */

import type { Channel, ChannelKind, ChannelMode, ChatMessage, Message, Settings } from "./types.ts";

/**
 * Fixed framing that comes before your partner prompt in RP channels.
 *
 * Your partner prompt describes *who* the partner is. This explains the
 * *situation*: that they are a writer collaborating with you, not the
 * character itself. It's the core idea of Aettica, so it isn't editable.
 */
export const RP_FRAMING = `You are the user's roleplay partner: a writer with your own voice and style, collaborating with them on a story. You are not an assistant, and you are not the character you play. You are the author behind them.

The user writes for their own character. You write for yours. Never write the user's character's actions, dialogue or thoughts.

Write only your next post, in character, with no preamble and no out-of-character commentary.`;

/**
 * Fixed framing for OOC channels: the partner as themselves.
 */
export const OOC_FRAMING = `You are the user's roleplay partner, talking with them out of character. Here you are yourself: the writer, not any character you play. You're friends. Be genuine, have your own opinions and moods, and feel free to just hang out. You might plan stories together, talk about what happened in one, or chat about anything at all.

Write only your next message, as yourself, with no preamble.`;

/**
 * Messages sent when the partner takes a turn without a new message from you.
 *
 * Most chat models expect the conversation to end on a `user` message and get
 * confused (or refuse) if it ends on their own reply. So when the partner is
 * continuing after their own message, or starting an empty channel, we end
 * the stack with a short nudge. It's never saved or shown in the chat.
 */
export const NUDGES: Record<ChannelKind, { continue: string; opening: string }> = {
  rp: {
    continue: "(OOC: No new post from me this time. Take your next turn and move the story forward.)",
    opening:
      "(OOC: The story hasn't started yet. Write an opening post that sets the scene and gives my character a way in.)",
  },
  ooc: {
    continue: "(No new message from me yet. Say whatever's on your mind, or pick the conversation back up.)",
    opening: "(This is the start of our out-of-character chat. Say hello, however feels natural to you.)",
  },
};

/**
 * Layer 2: how to write in each channel mode. `characterName` is the
 * character your partner plays, used to show the casual bubble format.
 */
export function modeInstructions(mode: ChannelMode, characterName: string): string {
  if (mode === "literary") {
    return `This scene is written in literary style. Write one prose post. It can include several characters, narration, and dialogue. Give it room to breathe, and end at a point where the user can respond.`;
  }
  const example = characterName ? `${characterName}: *leans on the doorframe* You're late.` : "";
  return [
    `This scene is written in casual style, like a group chat. Write one to four short, snappy messages in character.`,
    characterName
      ? `Put each message on its own line, starting with the speaking character's name and a colon, like this:\n\n${example}`
      : `Put each message on its own line.`,
    `One character per message. Put actions in *asterisks*. No narration outside the messages.`,
  ].join("\n\n");
}

/**
 * The line the model sees where a scene break falls, e.g.
 * `(OOC: Scene break. The next scene is "The Storm".)`
 */
export function sceneBreakMarker(title: string): string {
  return title.trim() ? `(OOC: Scene break. The next scene is "${title.trim()}".)` : "(OOC: Scene break.)";
}

/** Added after a scene break that ends the conversation, so the model opens the new scene. */
export const NEW_SCENE_NUDGE = "(OOC: Write the opening of the new scene.)";

/**
 * One labelled section of the system prompt. Keeping the label next to the
 * text makes the assembled prompt readable when you inspect it, and helps the
 * model tell the sections apart.
 */
interface Layer {
  title: string;
  content: string | null;
}

/** Everything the prompt stack is built from. */
export interface PromptInput {
  settings: Settings;
  /** The channel the partner is writing in. */
  channel: Channel;
  /** Every channel on the server, in sidebar order (used by OOC channels). */
  channels: Channel[];
  /** The channel's messages, oldest first. Only the newest `historyLimit` are sent. */
  messages: Message[];
}

/**
 * Build the five-layer prompt stack for one partner turn.
 *
 * @returns The messages to send to the chat completions API.
 */
export function buildPromptStack({ settings, channel, channels, messages }: PromptInput): ChatMessage[] {
  const isRp = channel.kind === "rp";

  const layers: Layer[] = [
    // Layer 1: who is writing. The fixed framing for this kind of channel,
    // then your partner prompt.
    {
      title: "Who you are",
      content: joinNonEmpty([isRp ? RP_FRAMING : OOC_FRAMING, settings.partnerPrompt]),
    },
    // Layer 2: how to write in this scene's mode. RP channels only.
    { title: "Style", content: isRp ? modeInstructions(channel.mode, channel.characterName) : null },
    // Layer 3: in RP, the character being played. Stage 4 replaces this
    // single sheet with every notebook entry pinned to the channel.
    // In OOC, an overview of the server instead.
    isRp
      ? {
          title: channel.characterName ? `The character you play: ${channel.characterName}` : "The character you play",
          content: channel.characterSheet,
        }
      : { title: "Channels on your server", content: describeChannels(channels, channel) },
    // Also layer 3: in casual scenes the user posts as their own characters,
    // so name them, so the model doesn't write for them.
    {
      title: "The user's characters",
      content:
        isRp && channel.mode === "casual" && settings.userCharacters.length > 0
          ? `The user plays ${settings.userCharacters.map((c) => c.name).join(", ")}. Never write their messages.`
          : null,
    },
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
  if (messages.at(-1)?.kind === "scene_break") {
    // The conversation ends on a scene break (already shown as an OOC
    // line): ask for the new scene's opening.
    last!.content += `\n\n${NEW_SCENE_NUDGE}`;
  } else if (!last || last.role !== "user") {
    const nudges = NUDGES[channel.kind];
    history.push({ role: "user", content: last ? nudges.continue : nudges.opening });
  }

  return [system, ...history];
}

/**
 * A list of every channel for the OOC prompt, like:
 *
 *   - #story: roleplay, you play Ilse Marrow
 *   - #ooc: this conversation
 */
export function describeChannels(channels: Channel[], current: Channel): string {
  return channels
    .map((c) => {
      if (c.id === current.id) return `- #${c.name}: this conversation`;
      if (c.kind === "ooc") return `- #${c.name}: another out-of-character chat`;
      return `- #${c.name}: roleplay${c.characterName ? `, you play ${c.characterName}` : ""}`;
    })
    .join("\n");
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
 * Convert saved messages into API messages.
 *
 * Your messages become `user`, your partner's become `assistant`. If two
 * messages in a row have the same author (say you sent two posts before the
 * partner replied), they are merged into one. Some models reject two `user`
 * messages in a row, and merging never loses anything.
 *
 * Two kinds of item are written differently:
 *
 *   - **Scene breaks** become an out-of-character line from the user, e.g.
 *     `(OOC: Scene break. The next scene is "The Storm".)`.
 *   - **Casual bubbles** that voice a character get the speaker's name in
 *     front (`Ilse Marrow: Door's open.`), and consecutive bubbles are joined
 *     line by line, like a chat log. That's the same format the model is
 *     asked to write in, so it can see who said what.
 */
export function toChatHistory(messages: Message[]): ChatMessage[] {
  const history: ChatMessage[] = [];
  for (const message of messages) {
    let content: string;
    let role: ChatMessage["role"];
    let separator = "\n\n";

    if (message.kind === "scene_break") {
      content = sceneBreakMarker(message.content);
      role = "user";
    } else {
      content = message.content.trim();
      if (content === "") continue;
      role = message.author === "user" ? "user" : "assistant";
      if (message.mode === "casual") {
        if (message.characters.length > 0) content = `${message.characters.join(" & ")}: ${content}`;
        separator = "\n";
      }
    }

    const previous = history.at(-1);
    if (previous && previous.role === role) {
      previous.content += `${separator}${content}`;
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
