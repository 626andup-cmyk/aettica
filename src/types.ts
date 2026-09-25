/**
 * Shared data shapes for Aettica.
 *
 * Everything the server saves or sends to the browser is described here, so
 * this file doubles as a map of the stage 1 data model. Later stages grow it:
 * stage 2 adds channels, stage 4 adds notebook entries, and so on.
 */

/**
 * Who wrote a message.
 *
 * - `"user"`: you.
 * - `"partner"`: your AI RP partner.
 *
 * The design doc also wants each message to record which character(s) it
 * voices; that arrives in stage 2 along with message authorship proper.
 */
export type Author = "user" | "partner";

/** One message in the chat. */
export interface Message {
  /** Unique id, generated when the message is created. */
  id: string;
  author: Author;
  /** The message text, exactly as written (or as the model returned it). */
  content: string;
  /** When the message was created, as an ISO 8601 timestamp. */
  createdAt: string;
  /** When the message was last edited, if ever. */
  editedAt?: string;
  /**
   * For partner messages: which model wrote it. Stage 5 replaces this with a
   * full connection profile id, but recording the model now means old
   * messages are never a mystery.
   */
  model?: string;
}

/**
 * Everything you can change from the settings panel.
 *
 * In stage 1 there is exactly one partner, one character sheet and one model.
 */
export interface Settings {
  /**
   * Layer 1 of the prompt stack: who your partner is and how they write.
   * This describes the *writer*, not a character they play.
   */
  partnerPrompt: string;
  /**
   * Layer 3 of the prompt stack: the character your partner plays in this
   * chat. Stage 4 replaces this single sheet with pinned notebook entries.
   */
  characterSheet: string;
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
   * How many of the most recent messages are sent to the model. Older
   * messages are simply left out until stage 7 adds scene summaries.
   */
  historyLimit: number;
}

/** The shape of the whole save file on disk (`data/chat.json`). */
export interface SaveData {
  /**
   * Save-format version. If the format ever changes, the loader can look at
   * this number and upgrade old files instead of breaking on them.
   */
  version: 1;
  settings: Settings;
  messages: Message[];
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
