/**
 * Shared data shapes for Aettica.
 *
 * Everything the server saves or sends to the browser is described here, so
 * this file doubles as a map of the data model. Each stage grows it:
 * stage 2 added channels and message authorship; stage 3 will add scene
 * breaks, stage 4 notebook entries, and so on.
 *
 * How these shapes are stored in the database is in `src/db.ts`.
 */

/**
 * Who wrote a message.
 *
 * - `"user"`: you.
 * - `"partner"`: your AI RP partner.
 */
export type Author = "user" | "partner";

/**
 * What a channel is for.
 *
 * - `"rp"`: a storyline. Your partner writes as the channel's character.
 * - `"ooc"`: out of character. Your partner talks to you as themselves, like
 *   a friend, and can see which storylines exist on the server.
 */
export type ChannelKind = "rp" | "ooc";

/** A channel: one storyline, or one out-of-character conversation. */
export interface Channel {
  /** Unique id, generated when the channel is created. */
  id: string;
  /** Display name, shown with a `#` in front. */
  name: string;
  /** RP or OOC. Chosen when the channel is created and never changed. */
  kind: ChannelKind;
  /** Where the channel sits in the sidebar: 0 is the top. */
  position: number;
  /**
   * RP channels only: the name of the character your partner plays here.
   * Recorded on each partner message as the character it voices, and shown
   * as the author name. Empty for OOC channels.
   */
  characterName: string;
  /**
   * RP channels only: that character's sheet (layer 3 of the prompt stack).
   * Stage 4 replaces this with notebook entries pinned to the channel.
   */
  characterSheet: string;
  /** When the channel was created, as an ISO 8601 timestamp. */
  createdAt: string;
}

/** One message in a channel. */
export interface Message {
  /** Unique id, generated when the message is created. */
  id: string;
  /** The channel the message belongs to. */
  channelId: string;
  author: Author;
  /** The message text, exactly as written (or as the model returned it). */
  content: string;
  /**
   * The character(s) this message voices. Empty for narration, OOC chat, and
   * (until stage 3 lets you post as a character) your own messages.
   */
  characters: string[];
  /** When the message was created, as an ISO 8601 timestamp. */
  createdAt: string;
  /** When the message was last edited, if ever. */
  editedAt?: string;
  /**
   * For partner messages: which model wrote it. Stage 5 replaces this with a
   * connection profile id, but recording the model now means old messages
   * are never a mystery.
   */
  model?: string;
}

/**
 * Settings that apply to the whole server, changed from the settings panel.
 * Per-channel settings (name, character) live on `Channel` instead.
 */
export interface Settings {
  /** Your partner's name, shown on their OOC messages. */
  partnerName: string;
  /**
   * Layer 1 of the prompt stack: who your partner is and how they write.
   * This describes the *writer*, not a character they play.
   */
  partnerPrompt: string;
  /** nanoGPT model id, e.g. `deepseek-ai/DeepSeek-V3.1-Terminus`. */
  model: string;
  /**
   * Sampling temperature. Higher is more varied, lower is more predictable.
   * Most models are happy somewhere between 0.7 and 1.1.
   */
  temperature: number;
  /** Upper limit on the length of one partner reply, in tokens. */
  maxTokens: number;
  /**
   * How many of the most recent messages in a channel are sent to the model.
   * Older messages are left out until stage 7 adds scene summaries.
   */
  historyLimit: number;
}

/**
 * One message in the format the chat completions API expects.
 *
 * nanoGPT speaks the same API as OpenAI, where every message has a role:
 * `system` for instructions, `user` for the human, `assistant` for the model.
 */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}
