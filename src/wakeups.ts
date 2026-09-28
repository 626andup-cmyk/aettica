/**
 * Wake-ups (stage 8): your partner taking a turn without a message from you.
 *
 * The design's core rule is that *a partner turn never requires a user
 * message*, and stage 8 is where that pays off. Your partner gets a turn
 * when something happens:
 *
 *   - **you open the app** ("away" if you haven't written for a while,
 *     `awayHours`; otherwise just "opened")
 *   - **a scene ends** (one you ended, once it's been summarized)
 *   - **a suggestion of yours is waiting for their review**
 *   - (endgame) **the heartbeat**, a timer: see src/heartbeat.ts
 *
 * A wake-up is a turn in your OOC channel (the one you talked in last),
 * with tools if the profile has them. Its prompt says why they're up, how
 * long it's been since you last wrote, what's waiting, and the summary of
 * a scene that just ended; OOC's prompt already has the server digest. They
 * can write, act with tools, or do nothing (`do_nothing`, or replying
 * `[nothing]` without tools), which is usually right.
 *
 * ## Rules that aren't up to anyone
 *
 * - **Chattiness** (`Settings.wakeups`) decides which events count at all:
 *   off; quiet (coming back after being away, and reviews); normal (also a
 *   scene ending); chatty (also any time you open the app).
 * - **Quiet hours**: never, except reviews (which are silent work).
 * - **A cooldown** between wake-ups (`wakeCooldownMinutes`, reviews 10).
 * - **Never twice in a row**: once your partner has reached out, they wait
 *   for you to write before reaching out again (reviews excepted).
 * - Not while they're writing in that channel, and not without an API key.
 *
 * ## Jev decides whether it's the moment
 *
 * Before a writer model is even called, Jev (src/jev.ts) is asked, with a
 * snapshot of what's going on: "the user just came back after 2 days: would
 * a short message feel natural and welcome right now?" A confident yes
 * wakes your partner; no, or unsure, doesn't (the safe path). Reviews skip
 * the question: they're work, not conversation. With Jev turned off (and no
 * fallback profile), your partner's own turn decides, through do_nothing.
 *
 * Every wake-up that got as far as Jev is in the wake-up log (Settings →
 * Your partner reaching out), with what came of it and why.
 */

import type { Database } from "bun:sqlite";
import { confidentChoice, percent, probabilityOf, tier, type Decider, type Question } from "./jev.ts";
import { BusyError, pickProfile, type Partner } from "./partner.ts";
import type { WakeContext, WakeReason } from "./prompt.ts";
import type { Store } from "./store.ts";
import { splitScenes } from "./summaries.ts";
import type { Channel, Message } from "./types.ts";

/** What can wake your partner up from outside. */
export type WakeEvent = "opened" | "scene-ended" | "review" | "heartbeat";

/** What came of a wake-up. */
export type WakeOutcome = "posted" | "quiet" | "declined" | "failed";

/** One wake-up in the log. */
export interface WakeRecord {
  id: string;
  at: string;
  reason: WakeReason;
  outcome: WakeOutcome;
  channelId: string | null;
  detail: string;
}

/** What `Wakeups.event` did. */
export interface WakeResult {
  /** `null` when the event didn't count (off, quiet hours, cooldown...): nothing was logged. */
  outcome: WakeOutcome | null;
  reason: WakeReason | null;
  detail: string;
  messages: Message[];
}

/** Reviews can come again this soon (minutes), whatever the cooldown. */
export const REVIEW_COOLDOWN_MINUTES = 10;

/** A scene break older than this (minutes) when summarized didn't "just" end the scene. */
export const FRESH_SCENE_MINUTES = 60;

/** How many of the newest OOC messages Jev's snapshot shows. */
const SNAPSHOT_LINES = 8;

// --------------------------------------------------------------- the log

interface WakeRow {
  id: string;
  at: string;
  reason: WakeReason;
  outcome: WakeOutcome;
  channel_id: string | null;
  detail: string;
}

/** The wake-up log: what could have woken your partner, and what came of it. */
export class WakeLog {
  constructor(private readonly db: Database) {}

  add(record: Omit<WakeRecord, "id">): WakeRecord {
    const id = crypto.randomUUID();
    this.db
      .query(
        `INSERT INTO wakeups (id, at, reason, outcome, channel_id, detail)
         VALUES ($id, $at, $reason, $outcome, $channelId, $detail)`,
      )
      .run({ id, ...record });
    // Keep the last few hundred; older ones don't help anyone.
    this.db.query("DELETE FROM wakeups WHERE id NOT IN (SELECT id FROM wakeups ORDER BY at DESC LIMIT 300)").run();
    return { id, ...record };
  }

  /** The newest wake-ups, newest first. */
  recent(limit = 30): WakeRecord[] {
    const rows = this.db.query("SELECT * FROM wakeups ORDER BY at DESC LIMIT $limit").all({ limit }) as WakeRow[];
    return rows.map((r) => ({ id: r.id, at: r.at, reason: r.reason, outcome: r.outcome, channelId: r.channel_id, detail: r.detail }));
  }

  /** When your partner last actually took a wake-up turn (posted or chose quiet), for these reasons. */
  lastTurnAt(reasons?: WakeReason[]): Date | null {
    const rows = this.recent(300).filter(
      (r) => (r.outcome === "posted" || r.outcome === "quiet") && (!reasons || reasons.includes(r.reason)),
    );
    return rows[0] ? new Date(rows[0].at) : null;
  }

  /** When your partner last *wrote* on a wake-up. */
  lastPostedAt(): Date | null {
    const row = this.recent(300).find((r) => r.outcome === "posted");
    return row ? new Date(row.at) : null;
  }
}

// -------------------------------------------------------------- helpers

/** "3 minutes", "5 hours", "2 days". */
export function humanDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

/** Whether `now` is within quiet hours (`start` to `end`, wrapping past midnight). -1 means none. */
export function inQuietHours(now: Date, start: number, end: number): boolean {
  if (start < 0 || start === end) return false;
  const hour = now.getHours();
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

/** Which events count at each chattiness. */
const COUNTS: Record<string, WakeReason[]> = {
  off: [],
  quiet: ["away", "review", "heartbeat"],
  normal: ["away", "review", "heartbeat", "scene-ended"],
  chatty: ["away", "review", "heartbeat", "scene-ended", "opened"],
};

// ----------------------------------------------------------- wake-ups

/** Decides whether your partner wakes up, and runs the turn if so. */
export class Wakeups {
  private running = false;

  constructor(
    private readonly store: Store,
    private readonly partner: Partner,
    private readonly decider: Decider,
    private readonly hasApiKey: boolean,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Something happened that could wake your partner. Resolves once it's
   * decided (and, if they woke, once their turn is done). Never throws.
   *
   * @param detail  For "scene-ended": the channel and the scene break.
   *                For "heartbeat": the idea being shared, if any.
   */
  async event(event: WakeEvent, detail: { channelId?: string; breakId?: string; idea?: string; ideas?: string[] } = {}): Promise<WakeResult> {
    const skip = (why: string): WakeResult => ({ outcome: null, reason: null, detail: why, messages: [] });
    if (this.running) return skip("Your partner is already waking up.");
    this.running = true;
    try {
      return await this.decide(event, detail, skip);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[wake] ${event} failed: ${message}`);
      return { outcome: "failed", reason: null, detail: message, messages: [] };
    } finally {
      this.running = false;
    }
  }

  private async decide(
    event: WakeEvent,
    detail: { channelId?: string; breakId?: string; idea?: string; ideas?: string[] },
    skip: (why: string) => WakeResult,
  ): Promise<WakeResult> {
    const { store } = this;
    const settings = store.getSettings();
    const now = this.now();
    if (!this.hasApiKey) return skip("There's no API key yet.");

    // Where your partner is, and how long since you wrote.
    const channels = store.listChannels();
    const all = channels.flatMap((c) => store.getMessages(c.id).filter((m) => m.kind === "post"));
    all.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const yourLast = all.filter((m) => m.author === "user").at(-1) ?? null;
    const sinceMs = yourLast ? now.getTime() - new Date(yourLast.createdAt).getTime() : null;

    const reason: WakeReason =
      event === "opened" ? (sinceMs !== null && sinceMs >= settings.awayHours * 3_600_000 ? "away" : "opened") : event;

    // The rules that aren't up to anyone.
    if (!COUNTS[settings.wakeups]!.includes(reason)) return skip(`"${reason}" doesn't wake your partner at this chattiness.`);
    if (reason !== "review" && inQuietHours(now, settings.quietStart, settings.quietEnd)) return skip("It's quiet hours.");
    const cooldown = reason === "review" ? REVIEW_COOLDOWN_MINUTES : settings.wakeCooldownMinutes;
    const lastTurn = store.wakeLog.lastTurnAt(reason === "review" ? ["review"] : undefined);
    if (lastTurn && now.getTime() - lastTurn.getTime() < cooldown * 60_000) return skip("It's too soon after the last wake-up.");
    if (reason !== "review") {
      const lastPosted = store.wakeLog.lastPostedAt();
      if (lastPosted && (!yourLast || new Date(yourLast.createdAt) < lastPosted)) {
        return skip("Your partner already reached out, and is waiting for you to write.");
      }
    }
    if (reason === "opened" && all.at(-1) && now.getTime() - new Date(all.at(-1)!.createdAt).getTime() < 30 * 60_000) {
      return skip("You were talking just now: that's a conversation, not a wake-up.");
    }

    let channel = homeChannel(store, channels);
    if (!channel) return skip("There's no OOC channel for your partner to write in.");
    if (this.partner.isBusy(channel.id)) return skip("Your partner is writing there already.");
    if (reason === "review" && !pickProfile(store, channel).supportsTools) {
      return skip("The profile that writes OOC can't use tools, so it couldn't review anything.");
    }

    // What they're told about why they're up.
    const context = wakeContext(store, reason, sinceMs, detail);

    // Jev: is it the moment? (Not for reviews: those are work.)
    if (reason !== "review" && this.decider.enabled()) {
      const question = QUESTIONS[reason](context);
      // Several OOC channels: Jev picks the one this fits best, in the same
      // call (Kitsikai's "which channel?"). Unsure keeps the one you used last.
      const oocs = channels.filter((c) => c.kind === "ooc");
      const pick: Question | null =
        oocs.length > 1
          ? { id: "channel", kind: "choice", question: "Which of the out-of-character channels (listed above) fits this message best?", options: oocs.map((c) => c.name) }
          : null;
      let state = snapshot(store, channel, context, now);
      if (pick) state += `\nThe out-of-character channels:\n${oocs.map((c) => `#${c.name}: ${channelLine(store, c)}`).join("\n")}`;
      let yes: number;
      try {
        const answers = await this.decider.ask(state, pick ? [question, pick] : [question], { purpose: `Wake-up (${reason})` });
        const answer = answers.get(question.id);
        const picked = pick ? confidentChoice(answers.get("channel"), settings.decisionConfidence) : null;
        const chosen = picked ? oocs.find((c) => c.name === picked) : undefined;
        if (chosen && !this.partner.isBusy(chosen.id)) channel = chosen;
        yes = probabilityOf(answer, "yes");
        const verdict = tier(answer, settings.decisionConfidence);
        if (verdict !== "yes") {
          const why = `Jev: ${verdict === "no" ? "not the moment" : "unsure, so not now"} (${percent(yes)} yes).`;
          return this.log(reason, "declined", channel, why);
        }
      } catch (error) {
        return this.log(reason, "failed", channel, `Jev couldn't answer: ${error instanceof Error ? error.message : error}`);
      }
      console.log(`[wake] ${reason}: Jev says yes (${percent(yes)})`);
    }

    try {
      const result = await this.partner.takeTurn(channel.id, "wake", { wake: context });
      const wrote = result.messages.length > 0;
      const acted = result.toolCalls.filter((c) => c.status === "ok").map((c) => c.summary);
      const why = wrote ? "They wrote to you." : acted.length ? `They acted (${acted.join("; ")}) and didn't write.` : "They chose not to write.";
      return { ...this.log(reason, wrote ? "posted" : "quiet", channel, why), messages: result.messages };
    } catch (error) {
      if (error instanceof BusyError) return skip("Your partner is writing there already.");
      return this.log(reason, "failed", channel, error instanceof Error ? error.message : String(error));
    }
  }

  private log(reason: WakeReason, outcome: WakeOutcome, channel: Channel, detail: string): WakeResult {
    this.store.wakeLog.add({ at: this.now().toISOString(), reason, outcome, channelId: channel.id, detail });
    console.log(`[wake] ${reason} → ${outcome}: ${detail}`);
    return { outcome, reason, detail, messages: [] };
  }
}

/** The OOC channel your partner wakes up in: the one you talked in last (or the first). */
export function homeChannel(store: Store, channels: Channel[]): Channel | null {
  const ooc = channels.filter((c) => c.kind === "ooc");
  let best: Channel | null = null;
  let bestAt = "";
  for (const channel of ooc) {
    const last = store.lastMessage(channel.id)?.createdAt ?? "";
    if (!best || last > bestAt) {
      best = channel;
      bestAt = last;
    }
  }
  return best;
}

/** What a wake-up turn is told: why, since when, what's waiting, and a scene that just ended. */
export function wakeContext(
  store: Store,
  reason: WakeReason,
  sinceMs: number | null,
  detail: { channelId?: string; breakId?: string; idea?: string; ideas?: string[] },
): WakeContext {
  const waiting: string[] = [];
  const entries = store.notebook.listEntries("partner");
  const nameOf = (entryId: string) => entries.find((e) => e.id === entryId)?.name ?? "an entry";
  for (const s of store.notebook.waitingFor("partner")) {
    waiting.push(`The user's suggested change to ${nameOf(s.entryId)} is waiting for your review.`);
  }
  for (const s of store.notebook.waitingFor("user").filter((s) => s.author === "partner")) {
    waiting.push(`Your suggested change to ${nameOf(s.entryId)} is waiting for the user.`);
  }
  for (const p of store.proposals.pending()) waiting.push(`Your proposal to delete #${p.targetName} is waiting for the user.`);

  const context: WakeContext = { reason, sinceUser: sinceMs === null ? null : humanDuration(sinceMs), waiting };
  if (detail.idea) context.idea = detail.idea;
  if (detail.ideas?.length) context.ideas = detail.ideas;
  if (reason === "scene-ended" && detail.channelId) {
    const channel = store.getChannel(detail.channelId);
    const messages = store.summaries.withSeq(channel.id, store.getMessages(channel.id));
    const scenes = splitScenes(messages, channel.kind);
    const ended = scenes.find((s) => s.end?.id === detail.breakId) ?? scenes.filter((s) => s.end).at(-1);
    context.scene = {
      channel: channel.name,
      title: ended?.start?.content ?? "",
      summary: ended?.end ? (store.summaries.get(channel.id, "scene", ended.end.id)?.content ?? null) : null,
    };
  }
  return context;
}

/** The question Jev is asked for each reason: is it the moment? */
const QUESTIONS: Record<Exclude<WakeReason, "review">, (context: WakeContext) => Question> = {
  away: (c) => ({
    id: "reach",
    kind: "yesno",
    question: `The user just came back to the app after ${c.sinceUser ?? "a while"} away. Would a short, friendly message from their writing partner feel natural and welcome right now?`,
  }),
  opened: () => ({
    id: "reach",
    kind: "yesno",
    question: "The user just opened the app. Would a short message from their writing partner feel natural right now, rather than too much?",
  }),
  "scene-ended": () => ({
    id: "reach",
    kind: "yesno",
    question:
      "The user just ended a scene of their story. Would a short out-of-character reaction from their writing partner (how it went, or what might come next) feel natural and welcome right now?",
  }),
  heartbeat: (c) => ({
    id: "reach",
    kind: "yesno",
    question: c.idea
      ? `Their writing partner has an idea to share: "${c.idea}". Would texting it to the user right now feel natural and welcome?`
      : "Would a short message from their writing partner, out of nowhere, feel natural and welcome right now?",
  }),
};

/** A channel in a line, for choosing between them: its digest, or its newest post. */
function channelLine(store: Store, channel: Channel): string {
  const digest = store.summaries.get(channel.id, "digest")?.content;
  if (digest) return digest.replace(/\s+/g, " ").slice(0, 300);
  const last = store.getMessages(channel.id).filter((m) => m.kind === "post").at(-1);
  return last ? `last message: ${last.content.replace(/\s+/g, " ").slice(0, 200)}` : "empty";
}

/** What Jev is shown: the time, the silence, the recent OOC chat, what's waiting. */
export function snapshot(store: Store, channel: Channel, context: WakeContext, now: Date): string {
  const settings = store.getSettings();
  const lines = [
    `It's ${now.toLocaleString("en-US", { weekday: "long", hour: "numeric", minute: "2-digit" })}.`,
    context.sinceUser ? `The user last wrote ${context.sinceUser} ago.` : "The user hasn't written anything yet.",
  ];
  const recent = store
    .getMessages(channel.id)
    .filter((m) => m.kind === "post")
    .slice(-SNAPSHOT_LINES)
    .map((m) => `${m.author === "user" ? "User" : settings.partnerName}: ${m.content.replace(/\s+/g, " ").slice(0, 300)}`);
  if (recent.length) lines.push(`Their latest out-of-character chat (#${channel.name}), newest last:`, ...recent);
  if (context.scene?.summary) lines.push(`The scene that just ended in #${context.scene.channel}: ${context.scene.summary}`);
  if (context.waiting.length) lines.push("Waiting:", ...context.waiting);
  return lines.join("\n");
}
