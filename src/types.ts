/**
 * Shared data shapes for Aettica.
 *
 * Everything the server saves or sends to the browser is described here, so
 * this file doubles as a map of the data model. Each stage grows it:
 * stage 2 added channels and message authorship; stage 3 added scene breaks
 * and channel modes; stage 3.5 added themes; stage 4 added the notebook and
 * the cast; and so on.
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
 * - `"rp"`: a storyline. Its cast is the notebook entries pinned to it: your
 *   partner writes their characters (and shared ones), you write yours.
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

// ------------------------------------------------------------- notebook

/**
 * Who something in the notebook belongs to. Only the owner changes its
 * settings (see `src/permissions.ts`).
 *
 * - `"user"`: you.
 * - `"partner"`: your partner.
 * - `"joint"`: shared lore. Always visible to both, and always
 *   suggest-only: changes go through a suggestion the other person reviews.
 */
export type Owner = "user" | "partner" | "joint";

/** Whether the *other* person (not the owner) can see an entry. */
export type Visibility = "visible" | "hidden";

/**
 * What the *other* person (not the owner) may do to an entry's contents:
 *
 * - `"open"`: edit it directly.
 * - `"suggest"`: suggest changes, which the owner accepts or rejects.
 * - `"locked"`: nothing.
 */
export type Editing = "open" | "suggest" | "locked";

/** Characters can be in a channel's cast and voice messages; lore can't. */
export type EntryKind = "character" | "lore";

/** One labelled field of an entry, e.g. `{ label: "Age", value: "34" }`. */
export interface EntryField {
  label: string;
  value: string;
}

/**
 * A folder of entries. Its visibility and editing settings pass down to the
 * entries in it, unless an entry sets its own.
 */
export interface NotebookFolder {
  id: string;
  name: string;
  owner: Owner;
  visibility: Visibility;
  editing: Editing;
  position: number;
  createdAt: string;
}

/** One notebook entry: a character or a piece of lore. */
export interface NotebookEntry {
  id: string;
  kind: EntryKind;
  /** The entry's title: the character's name, or the lore's subject. */
  name: string;
  /** Xoul-style labelled fields, in order. */
  fields: EntryField[];
  /**
   * Optional instructions for your partner, added to the prompt whenever
   * this entry is in play (e.g. "Ilse never raises her voice").
   */
  systemPrompt: string;
  /**
   * Your characters only: a short proxy tag for casual scenes, e.g. `k`, so
   * `k: *waves*` posts as this character. `null` if none.
   */
  proxyPrefix: string | null;
  /** The folder it's in, or `null` for none. */
  folderId: string | null;
  owner: Owner;
  /** Its own visibility, or `null` to use its folder's. */
  visibility: Visibility | null;
  /** Its own editing setting, or `null` to use its folder's. */
  editing: Editing | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * The settings that actually apply to an entry, after folder inheritance
 * and the rules for shared lore. Worked out by `effectiveSettings`.
 */
export interface EffectiveSettings {
  owner: Owner;
  visibility: Visibility;
  editing: Editing;
}

/** What a suggestion would change: any of these, or deleting the entry. */
export interface SuggestedChange {
  name?: string;
  fields?: EntryField[];
  systemPrompt?: string;
  delete?: true;
}

/**
 * A suggested change to an entry you can't edit directly: shown to the
 * owner as a before/after comparison to accept or reject.
 */
export interface Suggestion {
  id: string;
  entryId: string;
  /** Who suggested it. */
  author: Author;
  change: SuggestedChange;
  status: "pending" | "accepted" | "rejected" | "withdrawn";
  createdAt: string;
  resolvedAt: string | null;
}

/**
 * Someone in a channel's cast, as one person sees them. If the entry is
 * hidden from that person, only `hidden: true` and a placeholder name are
 * given away.
 */
/**
 * Who plays a character: you, your partner, or either of you (shared
 * characters).
 */
export type Player = Author | "both";

export interface CastMember {
  entryId: string;
  /** The character's name, or "??? (hidden)". */
  name: string;
  /** Who plays them (see `playedBy` in src/permissions.ts). */
  playedBy: Player;
  owner: Owner;
  /** Characters make up the cast; lore can be pinned too, for reference. */
  kind: EntryKind;
  /** Hidden from the person looking. */
  hidden: boolean;
  proxyPrefix: string | null;
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
  /**
   * The profile or roulette that writes here, overriding the server-wide
   * one for this kind of channel (see `Settings.rpAssignment`), or `null`.
   */
  assignment: string | null;
  /** Where the channel sits in the sidebar: 0 is the top. */
  position: number;
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
  /** For partner messages: which model wrote it. */
  model?: string;
  /**
   * For partner messages: the name of the connection profile that wrote it,
   * as it was called at the time (profiles can be renamed or deleted later).
   */
  profile?: string;
  /**
   * Ids of notebook entries you attached to this message: they're sent to
   * your partner in full while the message is in the conversation.
   */
  attachments: string[];
}

/**
 * Settings that apply to the whole server, changed from the settings panel.
 * Per-channel settings (name, character) live on `Channel` instead.
 */
export interface Settings {
  /** Your partner's name, shown on their OOC messages. */
  partnerName: string;
  /**
   * Layer 1 of the prompt stack, in every channel: who your partner is.
   * This describes the *writer*, not a character they play.
   */
  partnerPrompt: string;
  /**
   * Layer 2, per kind of channel: how your partner writes there. Each is
   * only sent in its own kind of channel, so instructions for one (long
   * prose posts) never leak into another (short OOC chat).
   */
  literaryPrompt: string;
  /** How your partner writes casual scenes (see `literaryPrompt`). */
  casualPrompt: string;
  /** How your partner talks out of character (see `literaryPrompt`). */
  oocPrompt: string;
  /**
   * Which connection profile or roulette writes each job, server-wide:
   * `"profile:<id>"`, `"roulette:<id>"`, or `""` for the first profile.
   * A channel can override its own (`Channel.assignment`).
   */
  rpAssignment: string;
  /** See `rpAssignment`. OOC chat prefers tool-capable profiles. */
  oocAssignment: string;
  /** The app theme's id (see `src/themes.ts`). "classic" is the default look. */
  appTheme: string;
  /**
   * Where you've moved a theme's sliders (see `ThemeOption` in
   * src/themes.ts), by theme id, then option id. Options you haven't moved
   * use the theme's defaults.
   */
  themeOptions: Record<string, Record<string, number>>;
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
 * With tools (stage 6), an assistant message can also ask for tool calls,
 * and each call's result comes back as a `tool` message.
 */
export type ChatMessage =
  | { role: "system" | "user" | "assistant"; content: string }
  | { role: "tool"; content: string; tool_call_id: string };

/**
 * A message as sent to the API, which also covers a reply that only called
 * tools: its content is `null` (some providers reject an empty string there).
 */
export type ApiMessage = ChatMessage | { role: "assistant"; content: string | null; tool_calls: ApiToolCall[] };

/** A tool call as the API writes it inside an assistant message. */
export interface ApiToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

// ------------------------------------------------------------ stage 5

/** How hard a reasoning model thinks before answering (`null`: the model's default). */
export type ReasoningEffort = "low" | "medium" | "high";

/** What a turn is for: roleplay writing, or OOC chat. */
export type Job = "rp" | "ooc";

/**
 * A connection profile: one model and its settings (see `src/profiles.ts`).
 * It changes how your partner's words are produced, never who they are.
 */
export interface Profile {
  id: string;
  /** Your name for it, e.g. "DeepSeek, warm". */
  name: string;
  /** nanoGPT model id, e.g. `deepseek-ai/DeepSeek-V3.1-Terminus`. */
  model: string;
  /** Sampling temperature: higher is more varied. Most models like 0.7 to 1.1. */
  temperature: number;
  /** Upper limit on one reply's length, in tokens. */
  maxTokens: number;
  /** Nucleus sampling, or `null` to leave it to the model. */
  topP: number | null;
  reasoningEffort: ReasoningEffort | null;
  /** Whether the model can call tools (stage 6). Turns on it are given tools only if so. */
  supportsTools: boolean;
  /** Layer 4 of the prompt stack: notes that tame this model's habits. */
  quirkPrompt: string;
  /** More request fields, as a JSON object in text (e.g. `{"top_k": 40}`), or "". */
  extraParams: string;
  position: number;
  createdAt: string;
}

/** A weighted set of profiles; each turn picks one (see `src/profiles.ts`). */
export interface Roulette {
  id: string;
  name: string;
  entries: { profileId: string; weight: number }[];
  position: number;
  createdAt: string;
}

// ------------------------------------------------------------ stage 6

/**
 * One tool call your partner made during a turn, as kept in the tool log
 * (see `src/activity.ts`).
 */
export interface ToolCallRecord {
  id: string;
  channelId: string;
  /** The turn it belongs to: the same id as the messages that turn wrote. */
  turnId: string;
  /** Which round of the turn (a model can call tools, see results, and call more). */
  round: number;
  name: string;
  /** The arguments exactly as the model wrote them. */
  arguments: string;
  /** What was sent back to the model, as JSON text. */
  result: string;
  status: "ok" | "error";
  /** For people: "pinned Tamsin to #story". For errors, what went wrong. */
  summary: string;
  /** `native` if the API returned it as a tool call; `text` if it was written out in the reply. */
  source: "native" | "text";
  profile: string | null;
  createdAt: string;
}

/** One comment on a message. The first comment of a thread holds its quote. */
export interface Comment {
  id: string;
  messageId: string;
  /** The id of the thread's first comment (its own id, for the first). */
  threadId: string;
  author: Author;
  /** The highlighted text (first comment only; "" for the whole message). */
  quote: string;
  note: string;
  createdAt: string;
}

/** A thread of comments on one part of a message. */
export interface CommentThread {
  id: string;
  messageId: string;
  quote: string;
  resolved: boolean;
  comments: Comment[];
}

/** Something your partner asked you to approve (other than notebook suggestions). */
export interface Proposal {
  id: string;
  kind: "delete_channel";
  targetId: string;
  targetName: string;
  reason: string;
  status: "pending" | "approved" | "denied";
  createdAt: string;
  resolvedAt: string | null;
}
