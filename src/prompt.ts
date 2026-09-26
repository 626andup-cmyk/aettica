/**
 * Prompt assembly: turning a channel into what the model actually reads.
 *
 * A model has no memory between requests. Every time your partner takes a
 * turn, we rebuild the whole context from scratch and send it along. The
 * design doc calls this the *prompt stack*, and it always has the same five
 * layers in the same order:
 *
 *   1. Partner identity and writing style   (who is writing)
 *   2. How to write in this channel         (literary, casual or OOC)
 *   3. The cast and pinned notebook entries (who's in the story)
 *   4. Connection profile's model-quirk     (taming this particular model)
 *   5. Scene summaries and recent messages  (what has happened)
 *
 * Layers 1–4 are instructions, so they are joined into one `system` message.
 * Layer 5 is the conversation itself, sent as alternating `user`/`assistant`
 * messages after it.
 *
 * The stack depends on the kind of channel:
 *
 *   - **RP channels**: layer 1 frames the partner as the author of a story.
 *     Layer 3 is the channel's cast and lore (the notebook entries pinned to
 *     it), any entries those link to with `[[Name]]`, and who plays whom.
 *     Entries hidden from you are included with a note to keep the secret;
 *     entries you hide from your partner never appear.
 *   - **OOC channels**: layer 1 frames the partner as themselves, talking to
 *     you as a friend, and layer 3 lists the channels on the server (with
 *     who they play in each) and the notebook's entries, so they know what
 *     storylines exist. (Stage 7 adds a summary of each.)
 *
 * Layer 2 holds the fixed instructions for the current scene's mode
 * (literary or casual; none in OOC), then your partner prompt for this kind
 * of channel: one each for literary scenes, casual scenes and OOC. Only the
 * one that applies is sent, so your partner can't mix them up. In RP
 * channels, layer 5 shows scene breaks where they fall.
 *
 * Layer 4 is the connection profile's "model notes": instructions that tame
 * the model running this turn ("don't restate the scene"), never who your
 * partner is. It changes with the profile, so a roulette can pair each
 * model with its own notes.
 */

import type { PromptEntry } from "./notebook.ts";
import { playedBy } from "./permissions.ts";
import type { Channel, ChannelKind, ChannelMode, ChatMessage, Message, NotebookEntry, Player, Settings } from "./types.ts";

/**
 * Your partner prompt for this kind of channel and scene: how they write in
 * literary scenes, casual scenes, or out of character. Only the one that
 * applies is sent, so the others can't be confused with it.
 */
export function channelPrompt(settings: Settings, channel: Channel): string {
  if (channel.kind === "ooc") return settings.oocPrompt;
  return channel.mode === "casual" ? settings.casualPrompt : settings.literaryPrompt;
}

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
  /**
   * RP channels: the notebook entries pinned to the channel, and the ones
   * they link to, as your partner may see them (see `Notebook.forPrompt`).
   */
  notebook?: { pinned: PromptEntry[]; linked: PromptEntry[] };
  /**
   * OOC channels: the names of the characters your partner plays in each
   * channel, by channel id, and every notebook entry they can see.
   */
  overview?: { castNames: Record<string, string[]>; entries: PromptEntry[] };
  /** Layer 4: the connection profile's notes on this model's habits. */
  modelNotes?: string;
  /** Notebook entries you attached to messages in the conversation, as your partner may see them. */
  attached?: PromptEntry[];
  /** Open comment threads on this channel's messages. */
  threads?: PromptThread[];
  /** Suggestions waiting for your partner's review (only offered with tools). */
  reviews?: PromptReview[];
  /** Short lines about what your partner did recently: tool actions, and how their proposals went. */
  recentActions?: string[];
  /** Whether your partner can use tools this turn (adds guidance on them). */
  tools?: boolean;
  /**
   * A comment your partner is replying to: the turn writes a reply in its
   * thread instead of a post.
   */
  replyingTo?: { threadId: string; quote: string; note: string; onYourMessage: boolean };
}

/** A comment thread, as your partner sees it. */
export interface PromptThread {
  id: string;
  quote: string;
  /** Whether the message is your partner's own. */
  onYourMessage: boolean;
  comments: { author: "user" | "partner"; note: string }[];
}

/** A suggestion waiting for your partner, described for them. */
export interface PromptReview {
  id: string;
  entry: string;
  description: string;
}

/**
 * Build the five-layer prompt stack for one partner turn.
 *
 * @returns The messages to send to the chat completions API.
 */
export function buildPromptStack({
  settings,
  channel,
  channels,
  messages,
  notebook,
  overview,
  modelNotes,
  attached,
  threads,
  reviews,
  recentActions,
  tools,
  replyingTo,
}: PromptInput): ChatMessage[] {
  const isRp = channel.kind === "rp";
  const pinned = notebook?.pinned ?? [];
  const characterNames = (player: Player) =>
    pinned.filter((p) => p.entry.kind === "character" && playedBy(p.entry) === player).map((p) => p.entry.name);
  const yourCharacters = characterNames("partner");
  const sharedCharacters = characterNames("both");
  const userCharacters = characterNames("user");

  const layers: Layer[] = [
    // Layer 1: who is writing. The fixed framing for this kind of channel,
    // then your partner prompt.
    {
      title: "Who you are",
      content: joinNonEmpty([isRp ? RP_FRAMING : OOC_FRAMING, settings.partnerPrompt]),
    },
    // Layer 2: how to write here. The fixed instructions for this scene's
    // mode (RP only), then your partner prompt for this kind of channel.
    {
      title: isRp ? "Style" : "How you talk here",
      content: joinNonEmpty([
        isRp ? modeInstructions(channel.mode, yourCharacters[0] ?? sharedCharacters[0] ?? "") : "",
        channelPrompt(settings, channel),
      ]),
    },
    // Layer 3, in RP: the notebook entries pinned to the channel (the cast
    // and any lore), then the entries they link to.
    { title: "The cast", content: isRp ? describeEntries(pinned.filter((p) => p.entry.kind === "character")) : null },
    { title: "Lore", content: isRp ? describeEntries(pinned.filter((p) => p.entry.kind === "lore")) : null },
    { title: "Linked notes", content: isRp ? describeEntries(notebook?.linked ?? []) : null },
    {
      title: "Whose characters are whose",
      content: isRp ? castRules(yourCharacters, sharedCharacters, userCharacters) : null,
    },
    // Layer 3, in OOC: an overview of the server and the notebook instead.
    { title: "Channels on your server", content: isRp ? null : describeChannels(channels, channel, overview?.castNames ?? {}) },
    { title: "Your shared notebook", content: isRp ? null : describeNotebook(overview?.entries ?? []) },
    // Still layer 3, in both: notes attached to messages, comment threads,
    // what's waiting for your partner, and what they've done lately.
    { title: "Attached notes", content: describeEntries(attached ?? []) },
    { title: "Comment threads", content: describeThreads(threads ?? []) },
    { title: "Waiting for your review", content: tools ? describeReviews(reviews ?? []) : null },
    { title: "What you did recently", content: (recentActions ?? []).map((line) => `- ${line}`).join("\n") },
    { title: "Tools", content: tools ? toolGuidance(channel.kind) : null },
    // Layer 4: the connection profile's notes on this model's habits.
    { title: "Model notes", content: modelNotes ?? null },
  ];

  const system: ChatMessage = { role: "system", content: renderLayers(layers) };

  // Layer 5: the recent conversation. (Stage 7 puts scene summaries first.)
  const history = toChatHistory(recentMessages(messages, settings.historyLimit));

  // If the conversation doesn't end on your message, add a nudge so the model
  // knows it's being asked to continue. This is what lets the partner take a
  // turn without you writing anything: the design's core rule.
  const last = history.at(-1);
  if (replyingTo) {
    // A reply to a comment: whatever came last, ask for the reply.
    history.push({ role: "user", content: commentNudge(replyingTo) });
  } else if (messages.at(-1)?.kind === "scene_break") {
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
 * Open comment threads, with the short ids your partner uses to reply:
 *
 *   [a1b2c3d4] On your message: "the lamp guttered"
 *     The user: Love this image.
 *     You: Thank you!
 */
export function describeThreads(threads: PromptThread[]): string | null {
  if (threads.length === 0) return null;
  const blocks = threads.map((t) => {
    const where = t.onYourMessage ? "your message" : "the user's message";
    const head = `[${t.id.slice(0, 8)}] On ${where}${t.quote ? `: "${t.quote}"` : ""}`;
    const lines = t.comments.map((c) => `  ${c.author === "user" ? "The user" : "You"}: ${c.note}`);
    return [head, ...lines].join("\n");
  });
  return [
    "Out-of-character notes on messages. The characters never know about these.",
    "",
    ...blocks,
  ].join("\n");
}

/** Suggestions waiting for your partner, with ids for `review_suggestion`. */
function describeReviews(reviews: PromptReview[]): string | null {
  if (reviews.length === 0) return null;
  return [
    "The user suggested these notebook changes. Accept or reject each with review_suggestion when you've considered it.",
    "",
    ...reviews.map((r) => `- [${r.id.slice(0, 8)}] ${r.entry}: ${r.description}`),
  ].join("\n");
}

/** How to use tools, by kind of channel. */
export function toolGuidance(kind: ChannelKind): string {
  const common = [
    "You can act through tools. Use them only when they help: most turns need none, and doing nothing is fine.",
    "To check details on a character or lore, use read_notebook_entry. Never guess at what an entry says.",
    "Never mention tools, ids or tool results in what you write.",
  ];
  return (
    kind === "rp"
      ? [...common, "After any tools, still write your post, unless you call do_nothing."]
      : [...common, "Act when the user asks, or when you're building something together. Then tell them in your own words what you did."]
  ).join("\n");
}

/** The last message of a comment-reply turn. */
export function commentNudge(comment: NonNullable<PromptInput["replyingTo"]>): string {
  const where = comment.onYourMessage ? "your message" : "their own message";
  const quote = comment.quote ? ` on "${comment.quote}"` : "";
  return `(OOC: The user left a comment on ${where}${quote}: "${comment.note}". Reply to their comment as yourself, out of character, in one to three sentences. Don't continue the story or write a post. Your reply goes in the comment thread.)`;
}

/**
 * A list of every channel for the OOC prompt, like:
 *
 *   - #story: roleplay, you play Ilse Marrow
 *   - #ooc: this conversation
 *
 * @param castNames  The characters your partner plays in each channel, by id.
 */
export function describeChannels(channels: Channel[], current: Channel, castNames: Record<string, string[]>): string {
  return channels
    .map((c) => {
      if (c.id === current.id) return `- #${c.name}: this conversation`;
      if (c.kind === "ooc") return `- #${c.name}: another out-of-character chat`;
      const names = castNames[c.id] ?? [];
      return `- #${c.name}: roleplay${names.length ? `, you play ${names.join(", ")}` : ""}`;
    })
    .join("\n");
}

/** The note added to entries hidden from the user. */
export const SECRET_NOTE = "Hidden from the user: this is your secret. Use it in the story, but never reveal it outright.";

/**
 * Notebook entries written out for the prompt, each as a `###` heading with
 * its fields and any notes for the writer:
 *
 *   ### Ilse Marrow (you play this character)
 *   Age: 34
 *   Speech: Short sentences.
 *   Notes for you: Ilse never raises her voice.
 *
 * Entries hidden from the user are marked, so the model keeps their secrets.
 * `[[Links]]` are written as plain names.
 */
export function describeEntries(entries: PromptEntry[]): string {
  return entries
    .map(({ entry, hiddenFromUser }) => {
      const lines = [`### ${entry.name}${entryRole(entry)}`];
      if (hiddenFromUser) lines.push(`(${SECRET_NOTE})`);
      for (const field of entry.fields) {
        if (field.value.trim()) lines.push(`${field.label}: ${plainLinks(field.value.trim())}`);
      }
      if (entry.systemPrompt.trim()) lines.push(`Notes for you: ${plainLinks(entry.systemPrompt.trim())}`);
      return lines.join("\n");
    })
    .join("\n\n");
}

/** " (you play this character)", " (the user plays this character)", and so on, or "" for lore. */
function entryRole(entry: NotebookEntry): string {
  if (entry.kind !== "character") return "";
  const player = playedBy(entry);
  if (player === "both") return " (shared: either of you can play this character)";
  return player === "user" ? " (the user plays this character)" : " (you play this character)";
}

/** `[[Name]]` becomes `Name`, and `[[Name|shown]]` becomes `shown`. */
export function plainLinks(text: string): string {
  return text.replace(/\[\[([^\]|\n]+)(?:\|([^\]\n]*))?\]\]/g, (_m, name: string, shown?: string) => (shown ?? name).trim());
}

/**
 * Who plays whom in this channel, so the model never writes for the user's
 * characters, and knows shared ones are open to both.
 */
function castRules(yours: string[], shared: string[], theirs: string[]): string | null {
  const lines: string[] = [];
  if (yours.length) lines.push(`You play ${yours.join(", ")}.`);
  if (shared.length) {
    lines.push(
      `You and the user share ${shared.join(", ")}: either of you can write for them. Keep to what the user has written for them.`,
    );
  }
  if (theirs.length) lines.push(`The user plays ${theirs.join(", ")}. Never write their actions, dialogue or thoughts.`);
  return lines.length ? lines.join(" ") : null;
}

/**
 * The OOC overview of the notebook: every entry your partner can see, by
 * name, with whose it is and whether it's a secret from the user.
 */
export function describeNotebook(entries: PromptEntry[]): string | null {
  if (entries.length === 0) return null;
  const whose = (entry: NotebookEntry) =>
    entry.owner === "joint" ? "shared" : entry.owner === "partner" ? "yours" : "the user's";
  const lines = entries.map(
    ({ entry, hiddenFromUser }) =>
      `- ${entry.name} (${entry.kind}, ${whose(entry)}${hiddenFromUser ? ", hidden from the user" : ""})`,
  );
  if (entries.some((e) => e.hiddenFromUser)) {
    lines.push("", "Entries marked hidden are secrets you're keeping from the user. Don't reveal them here either.");
  }
  return lines.join("\n");
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
