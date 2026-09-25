/**
 * Shared data shapes for Aettica.
 *
 * Everything the server saves or sends to the browser is described here, so
 * this file doubles as a map of the data model. Each stage grows it:
 * stage 2 added channels and message authorship; stage 3 added scene breaks
 * and channel modes; stage 3.5 added themes; stage 4 will add notebook
 * entries, and so on.
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

/**
 * How an RP channel is written and shown (see "Channel modes" in DESIGN.md).
 *
 * - `"literary"`: your partner writes one prose post per turn, which may
 *   cover several characters. Shown as wide prose blocks.
 * - `"casual"`: short in-character messages, one character per bubble,
 *   like a group chat. You post as one of your characters.
 *
 * A mode change waits for the next scene break, so a scene never mixes
 * styles.
 */
export type ChannelMode = "literary" | "casual";

/**
 * What an item in a channel is.
 *
 * - `"post"`: an ordinary message.
 * - `"scene_break"`: a divider between scenes. Its `content` is the scene's
 *   title, which may be empty.
 */
export type MessageKind = "post" | "scene_break";

/**
 * One of your characters, for posting in casual mode.
 *
 * Starting a line with the prefix and a colon (`k: *waves*`) posts that line
 * as the character, like Tupperbox on Discord.
 */
export interface UserCharacter {
  name: string;
  /** Short proxy tag, e.g. `k`. No spaces or colons. */
  prefix: string;
}

/** A channel: one storyline, or one out-of-character conversation. */
export interface Channel {
  /** Unique id, generated when the channel is created. */
  id: string;
  /** Display name, shown with a `#` in front. */
  name: string;
  /** RP or OOC. Chosen when the channel is created and never changed. */
  kind: ChannelKind;
  /**
   * RP channels only: the mode of the current scene. (Stored for OOC
   * channels too, but ignored.)
   */
  mode: ChannelMode;
  /**
   * A mode change waiting for the next scene break, or `null` if none.
   * Changing mode in the middle of a scene sets this instead of `mode`.
   */
  pendingMode: ChannelMode | null;
  /**
   * The channel's own theme (a theme id), or `null` to use the app theme.
   * It only restyles the channel itself; see `src/themes.ts`.
   */
  theme: string | null;
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

/**
 * One item in a channel: a message, or a scene break.
 *
 * Scene breaks live alongside messages so that the two stay in order. A
 * scene break's `author` is whoever made it, and its `content` is its title.
 */
export interface Message {
  /** Unique id, generated when the message is created. */
  id: string;
  /** The channel the message belongs to. */
  channelId: string;
  /** A message, or a scene break. */
  kind: MessageKind;
  author: Author;
  /** The message text (or a scene break's title), exactly as written or returned by the model. */
  content: string;
  /**
   * RP channels only: the mode the message was written in, which is how it's
   * displayed and sent to the model. `null` in OOC channels and for scene
   * breaks.
   */
  mode: ChannelMode | null;
  /**
   * Messages written together share a turn id: all the bubbles of one
   * partner reply in casual mode, or several lines you sent at once.
   * Regenerating replaces the whole turn. `null` for older messages.
   */
  turnId: string | null;
  /**
   * The character(s) this message voices. Empty for narration, OOC chat,
   * your literary posts, and scene breaks.
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
  /** Your characters, for posting in casual mode. */
  userCharacters: UserCharacter[];
  /** The app theme's id (see `src/themes.ts`). "classic" is the default look. */
  appTheme: string;
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
