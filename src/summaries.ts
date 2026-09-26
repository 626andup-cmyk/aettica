/**
 * Summaries (stage 7): how long stories fit in the context.
 *
 * A model can only read so much at once, so a prompt holds only the most
 * recent messages (`historyLimit`). Everything older is remembered through
 * summaries, layered so the context stays small without losing the thread:
 *
 *   messages ──> scene summaries ──> the story so far ──> the digest
 *        └────> "earlier in this scene"                        │
 *                                                              v
 *                                                        OOC's overview
 *
 * - **Scene summaries** are written when a scene ends (at each scene
 *   break): what happened in it, and how it ended.
 * - **The story so far** is updated from each new scene summary, folding it
 *   into what was there: updated incrementally, never rewritten from
 *   scratch (unless you ask, or something it covers changed).
 * - **Earlier in this scene** covers a long scene that's still going (in OOC
 *   channels, which have no scenes, the whole conversation). Once more than
 *   `historyLimit + summaryEvery` of its messages are waiting, the oldest
 *   ones are folded into it, leaving `historyLimit` in full. Until then
 *   they're all sent in full, so a message is always either in the prompt
 *   or in a summary, never lost in between.
 * - **The digest** is one or two lines per channel (who's in it, where the
 *   story stands, its emotional temperature). OOC channels read every
 *   channel's digest, and the fuller summary of a channel that comes up.
 *
 * **Nothing hidden from you ever reaches a summary.** Summaries are written
 * only from the messages themselves (which you can all read), never from
 * the notebook, where secrets live. And you can read, edit or regenerate
 * every summary in the app.
 *
 * This file stores summaries and decides what's covered; src/summarizer.ts
 * asks the model to write them.
 */

import type { Database } from "bun:sqlite";
import type { Store } from "./store.ts";
import type { Channel, ChannelKind, Message, Summary, SummaryKind } from "./types.ts";

/** A message with its position in the database (`seq`), which never changes. */
export type SeqMessage = Message & { seq: number };

/** One scene of a channel: its messages, between the breaks around it. */
export interface Scene {
  /** The break that started it, or `null` for the channel's first scene. */
  start: SeqMessage | null;
  /** The break that ended it, or `null` for the scene still going. */
  end: SeqMessage | null;
  /** Its posts (not breaks), oldest first. */
  posts: SeqMessage[];
}

interface SummaryRow {
  channel_id: string;
  kind: SummaryKind;
  scene_id: string;
  content: string;
  through_seq: number;
  stale: number;
  edited: number;
  updated_at: string;
}

function toSummary(row: SummaryRow): Summary {
  return {
    channelId: row.channel_id,
    kind: row.kind,
    sceneId: row.scene_id,
    content: row.content,
    throughSeq: row.through_seq,
    stale: row.stale === 1,
    edited: row.edited === 1,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------- storage

/** Reading and writing summaries, and keeping them honest when messages change. */
export class Summaries {
  constructor(private readonly db: Database) {}

  /** One summary, or `null`. */
  get(channelId: string, kind: SummaryKind, sceneId = ""): Summary | null {
    const row = this.db
      .query("SELECT * FROM summaries WHERE channel_id = $channelId AND kind = $kind AND scene_id = $sceneId")
      .get({ channelId, kind, sceneId }) as SummaryRow | null;
    return row ? toSummary(row) : null;
  }

  /** Every summary of a channel. */
  all(channelId: string): Summary[] {
    const rows = this.db.query("SELECT * FROM summaries WHERE channel_id = $channelId").all({ channelId }) as SummaryRow[];
    return rows.map(toSummary);
  }

  /** Save a summary written by the model: it's fresh, and no longer stale. */
  save(channelId: string, kind: SummaryKind, sceneId: string, content: string, throughSeq: number): Summary {
    this.db
      .query(
        `INSERT INTO summaries (channel_id, kind, scene_id, content, through_seq, stale, edited, updated_at)
         VALUES ($channelId, $kind, $sceneId, $content, $throughSeq, 0, 0, $now)
         ON CONFLICT (channel_id, kind, scene_id) DO UPDATE SET
           content = excluded.content, through_seq = excluded.through_seq, stale = 0,
           -- Folding new scenes into a story you edited keeps it yours.
           edited = CASE WHEN summaries.stale = 0 THEN summaries.edited ELSE 0 END,
           updated_at = excluded.updated_at`,
      )
      .run({ channelId, kind, sceneId, content, throughSeq, now: new Date().toISOString() });
    return this.get(channelId, kind, sceneId)!;
  }

  /**
   * Your own words for a summary: kept as you wrote them, never rewritten
   * by the model (until you ask it to rebuild).
   */
  edit(channelId: string, kind: SummaryKind, sceneId: string, content: string, throughSeq: number): Summary {
    this.db
      .query(
        `INSERT INTO summaries (channel_id, kind, scene_id, content, through_seq, stale, edited, updated_at)
         VALUES ($channelId, $kind, $sceneId, $content, $throughSeq, 0, 1, $now)
         ON CONFLICT (channel_id, kind, scene_id) DO UPDATE SET
           content = excluded.content, stale = 0, edited = 1, updated_at = excluded.updated_at`,
      )
      .run({ channelId, kind, sceneId, content, throughSeq, now: new Date().toISOString() });
    return this.get(channelId, kind, sceneId)!;
  }

  remove(channelId: string, kind: SummaryKind, sceneId = ""): void {
    this.db
      .query("DELETE FROM summaries WHERE channel_id = $channelId AND kind = $kind AND scene_id = $sceneId")
      .run({ channelId, kind, sceneId });
  }

  /** Forget every summary of a channel (its messages were cleared). */
  clear(channelId: string): void {
    this.db.query("DELETE FROM summaries WHERE channel_id = $channelId").run({ channelId });
  }

  /** Mark summaries to be rewritten (all of a kind, or one scene's). */
  markStale(channelId: string, kind: SummaryKind, sceneId?: string): void {
    this.db
      .query(
        `UPDATE summaries SET stale = 1
          WHERE channel_id = $channelId AND kind = $kind AND ($sceneId IS NULL OR scene_id = $sceneId)`,
      )
      .run({ channelId, kind, sceneId: sceneId ?? null });
  }

  /** Rewrite everything from the messages, your edits included (the "Rebuild" button). */
  rebuildAll(channelId: string): void {
    this.db.query("UPDATE summaries SET stale = 1, edited = 0 WHERE channel_id = $channelId").run({ channelId });
  }

  /** A channel's messages with their positions. */
  withSeq(channelId: string, messages: Message[]): SeqMessage[] {
    const rows = this.db.query("SELECT id, seq FROM messages WHERE channel_id = $channelId").all({ channelId }) as {
      id: string;
      seq: number;
    }[];
    const seqs = new Map(rows.map((r) => [r.id, r.seq]));
    return messages.filter((m) => seqs.has(m.id)).map((m) => ({ ...m, seq: seqs.get(m.id)! }));
  }

  /**
   * A message is about to be edited or deleted: whatever summarized it is
   * out of date. Call before the change (the message must still exist).
   *
   * - A post in a finished scene: that scene's summary, and so the story.
   * - A post already folded into "earlier in this scene": that summary.
   * - A scene break being deleted: the two scenes around it become one, so
   *   the summary of the scene it ended is dropped, the next scene's is
   *   rewritten, and so is the story.
   * - The digest, if it covered the message.
   */
  messageChanging(message: Message, deleting: boolean): void {
    const { channelId } = message;
    const seqOf = (id: string) =>
      (this.db.query("SELECT seq FROM messages WHERE id = $id").get({ id }) as { seq: number } | null)?.seq ?? 0;
    const seq = seqOf(message.id);
    // The first scene break after the message: the one that ended its scene.
    const nextBreak = this.db
      .query(
        `SELECT id FROM messages WHERE channel_id = $channelId AND kind = 'scene_break' AND seq > $seq
          ORDER BY seq LIMIT 1`,
      )
      .get({ channelId, seq }) as { id: string } | null;

    const digest = this.get(channelId, "digest");
    if (digest && digest.throughSeq >= seq) this.markStale(channelId, "digest");
    if (message.kind === "scene_break") {
      if (!deleting) return; // a new title changes nothing that was summarized
      this.remove(channelId, "scene", message.id);
      this.markStale(channelId, "story");
      if (nextBreak) this.markStale(channelId, "scene", nextBreak.id);
      // "Earlier in this scene" belonged to the scene this break started,
      // which is now part of the one before: it's rewritten from scratch.
      else this.remove(channelId, "current", message.id);
      return;
    }
    if (nextBreak) {
      this.markStale(channelId, "scene", nextBreak.id);
      this.markStale(channelId, "story");
      return;
    }
    const current = this.db
      .query("SELECT scene_id, through_seq FROM summaries WHERE channel_id = $channelId AND kind = 'current'")
      .get({ channelId }) as { scene_id: string; through_seq: number } | null;
    if (current && current.through_seq >= seq) this.markStale(channelId, "current", current.scene_id);
  }
}

// ------------------------------------------------------------ scenes

/**
 * Split a channel into scenes at its scene breaks. An OOC channel (no
 * scenes) is one long "scene", its whole conversation.
 */
export function splitScenes(messages: SeqMessage[], kind: ChannelKind): Scene[] {
  if (kind === "ooc") return [{ start: null, end: null, posts: messages.filter((m) => m.kind === "post") }];
  const scenes: Scene[] = [];
  let scene: Scene = { start: null, end: null, posts: [] };
  for (const message of messages) {
    if (message.kind === "scene_break") {
      scene.end = message;
      scenes.push(scene);
      scene = { start: message, end: null, posts: [] };
    } else {
      scene.posts.push(message);
    }
  }
  scenes.push(scene);
  return scenes;
}

/**
 * Where the prompt's messages start (an index into `messages`): what isn't
 * sent from before this point is covered by summaries.
 *
 * - With summaries off: the newest `historyLimit` messages, as before
 *   stage 7.
 * - If the scene still going has an "earlier in this scene" summary: every
 *   message after what it covers.
 * - Otherwise the newest `historyLimit` messages, reaching back to the
 *   start of the current scene if it's longer (its oldest messages wait to
 *   be summarized, up to `summaryEvery` of them).
 *
 * Either way at most `historyLimit + 2 × summaryEvery`, in case summaries
 * have fallen behind (the model writing them kept failing).
 */
export function windowStart(
  messages: SeqMessage[],
  kind: ChannelKind,
  options: { historyLimit: number; summaryEvery: number; enabled: boolean; current: Summary | null },
): number {
  const { historyLimit, summaryEvery, enabled, current } = options;
  const recent = Math.max(0, messages.length - historyLimit);
  if (!enabled) return recent;

  // The current scene starts at its scene break (shown as a marker), or at
  // the very beginning.
  let sceneStart = 0;
  if (kind === "rp") {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.kind === "scene_break") {
        sceneStart = i;
        break;
      }
    }
  }
  const currentSceneId = kind === "rp" ? (messages[sceneStart]?.kind === "scene_break" ? messages[sceneStart]!.id : "") : "";

  let start: number;
  if (current && !current.stale && current.sceneId === currentSceneId) {
    start = messages.findIndex((m, i) => i >= sceneStart && m.seq > current.throughSeq);
    if (start === -1) start = messages.length;
  } else {
    start = Math.min(sceneStart, recent);
  }
  return Math.max(start, messages.length - (historyLimit + 2 * summaryEvery));
}

/**
 * Everything summarized about a channel, as text for your partner: the
 * digest, the story so far, the last scene, and the scene still going.
 * Empty if nothing's been summarized yet. (Also what the
 * `read_channel_summary` tool returns.)
 */
export function channelSummaryText(store: Store, channel: Channel, { withDigest = true } = {}): string {
  const summaries = store.summaries.all(channel.id);
  const one = (kind: string) => summaries.find((s) => s.kind === kind)?.content;
  const messages = store.summaries.withSeq(channel.id, store.getMessages(channel.id));
  const scenes = splitScenes(messages, channel.kind);
  const lastEnded = scenes.filter((s) => s.end).at(-1);
  const lastScene = lastEnded ? summaries.find((s) => s.kind === "scene" && s.sceneId === lastEnded.end!.id)?.content : undefined;
  const parts = [
    withDigest && one("digest") ? `In short: ${one("digest")}` : "",
    one("story") ? `The story so far: ${one("story")}` : "",
    lastScene ? `The last scene: ${lastScene}` : "",
    one("current") ? `${channel.kind === "rp" ? "Earlier in the current scene" : "Earlier in the conversation"}: ${one("current")}` : "",
  ];
  return parts.filter(Boolean).join("\n\n");
}

// ---------------------------------------------------------- transcripts

/**
 * Messages as the text a summary is written from: one line (or paragraph)
 * per post, with who's speaking, and scene breaks marked.
 */
export function transcript(messages: Message[], kind: ChannelKind, partnerName: string): string[] {
  return messages.map((m) => {
    if (m.kind === "scene_break") return `--- Scene break${m.content ? `: "${m.content}"` : ""} ---`;
    let speaker: string;
    if (kind === "ooc") speaker = m.author === "user" ? "The user" : `You (${partnerName})`;
    else if (m.characters.length > 0) speaker = m.characters.join(" & ");
    else speaker = m.author === "user" ? "The user (narration)" : `${partnerName} (narration)`;
    return `${speaker}: ${m.content.trim()}`;
  });
}

/** Most text sent in one summary request, in characters (about 8,000 tokens). */
export const CHUNK_CHARS = 30_000;

/**
 * Split lines into chunks of at most `limit` characters, keeping lines
 * whole (a line longer than the limit gets a chunk of its own).
 */
export function chunkLines(lines: string[], limit = CHUNK_CHARS): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let size = 0;
  for (const line of lines) {
    if (current.length > 0 && size + line.length > limit) {
      chunks.push(current.join("\n\n"));
      current = [];
      size = 0;
    }
    current.push(line);
    size += line.length + 2;
  }
  if (current.length > 0) chunks.push(current.join("\n\n"));
  return chunks;
}

// --------------------------------------------------------- instructions

/** What a summary request is for. */
export type SummaryJob = "scene" | "current" | "story" | "conversation" | "digest" | "ooc-digest";

const SHARED = `You keep the memory of a collaborative roleplay: a story written together by two people, "the user" and their writing partner, who plays some of the characters. Your notes are read later by the partner, instead of the full text, so they must keep everything that matters to continue the story well.`;

/** The instructions for each kind of summary. */
export const SUMMARY_INSTRUCTIONS: Record<SummaryJob, string> = {
  scene: `${SHARED}

Summarize one scene: what happened, in order, and how it ended. Write in the past tense and the third person, using the characters' names. Keep the concrete details that matter later: decisions, promises and threats, what characters learned about each other, injuries, objects, places, how relationships changed, questions left open, and the mood at the end. No commentary, no headings. At most 200 words.`,

  current: `${SHARED}

Summarize the scene so far (it's still going): what has happened in it, in order, and where things stand now. Write in the past tense and the third person, using the characters' names. Keep the concrete details that matter later: decisions, promises and threats, what characters learned about each other, injuries, objects, places, how relationships changed, and questions left open. No commentary, no headings. At most 200 words.`,

  story: `${SHARED}

Write "the story so far": one running summary of the whole story, from the summaries of its scenes. Keep what matters for continuity: who the characters are to each other and what they want, the events that still matter, promises and threats, unresolved threads, and where things stand now. Compress older events more than recent ones. Past tense, third person. No headings. At most 350 words.`,

  conversation: `You keep the memory of an out-of-character conversation between "the user" and you, their roleplay writing partner. Your notes are read later by you, instead of the full text.

Summarize what was talked about. Keep what matters later: plans and ideas for stories, what the user likes and doesn't, things either of you promised, running jokes and topics, anything personal the user shared, and the mood. Write about yourself as "you" and about them as "the user". No headings. At most 250 words.`,

  digest: `Describe a roleplay channel for an overview of all of them, in one or two short lines (at most 40 words): who's in it, where the story stands, and its emotional temperature. No preamble, just the lines.`,

  "ooc-digest": `Describe an out-of-character channel between "the user" and you, their roleplay writing partner, for an overview of all channels, in one or two short lines (at most 40 words): what you've been talking about lately, and the mood. No preamble, just the lines.`,
};

/**
 * The messages for one summary request: the instructions, then the notes
 * so far (if any) and the new material, asking for the updated notes.
 */
export function summaryRequest(job: SummaryJob, notes: string, material: string, heading: string) {
  const parts = [
    notes.trim() ? `Your notes so far:\n\n${notes.trim()}` : "",
    `${heading}:\n\n${material.trim()}`,
    notes.trim()
      ? "Write the updated notes: fold the new part into your notes so far. Reply with the notes only."
      : "Reply with the notes only.",
  ].filter(Boolean);
  return [
    { role: "system" as const, content: SUMMARY_INSTRUCTIONS[job] },
    { role: "user" as const, content: parts.join("\n\n") },
  ];
}

/** Tidy a summary the model wrote: no "Summary:" label or wrapping quotes. */
export function cleanSummary(text: string): string {
  return text
    .trim()
    .replace(/^(?:\*\*)?(?:updated )?(?:notes|summary|the story so far)(?:\*\*)?\s*:\s*/i, "")
    .replace(/^"([\s\S]*)"$/, "$1")
    .trim();
}
