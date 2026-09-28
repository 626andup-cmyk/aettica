/**
 * The heartbeat: your partner reaching out out of nowhere, the way a friend
 * texts "wait, I just had an idea". An endgame feature from DESIGN.md.
 *
 * Every `heartbeatHours` (each gap varies by ±20%, so it never feels like
 * clockwork), the server checks in on its own, even with the app closed:
 *
 *   1. **The rules first** (`Wakeups.blocked`): chattiness, quiet hours, the
 *      cooldown, never twice unanswered, not mid-conversation. Most beats
 *      stop here, costing nothing.
 *   2. **Generate**: your partner (the profile that writes OOC) comes up
 *      with a few ideas: a new story, a character, a twist for a story
 *      you're in, or a thought about something you talked about. They see
 *      the server digest, the recent OOC chat, the notebook's names, and
 *      ideas they've had before, so they don't repeat themselves.
 *   3. **Grade**: Jev grades each idea, in a series of three questions that
 *      must all agree: is it fresh (not already done or talked about, the
 *      way Kitsikai checks a reminder isn't redundant)? Would the user be
 *      excited by it? Is it worth texting about, not generic? Confident
 *      yes: exciting. Confident no: dropped. Unsure: into the drawer.
 *   4. **Share the best**: the best exciting idea becomes a wake-up
 *      ("heartbeat"), with the idea in the prompt, and Jev's usual "is it
 *      the moment?" before it. If it isn't shared, it goes in the drawer.
 *
 * With no exciting idea, and a long enough silence (at least
 * `heartbeatHours`), your partner may still check in "just because", with
 * the best ideas from the drawer to bring up if they fit.
 *
 * **The idea drawer** (src/ideas.ts) is also offered on other wake-ups
 * (coming back, a scene ending). After a wake-up message, Jev is asked
 * which of them it actually brought up, and those are marked shared.
 *
 * A message on a heartbeat (or any wake-up) sends a phone notification
 * when the app isn't on screen (src/notify.ts).
 */

import { describeVerdict, type Decider, type SeriesQuestion } from "./jev.ts";
import { extractJson } from "./json.ts";
import { createChatCompletion, type ApiOptions } from "./nanogpt.ts";
import type { IdeaKind } from "./ideas.ts";
import { pickProfile, profileRequest } from "./partner.ts";
import type { Store } from "./store.ts";
import { homeChannel, type WakeResult, type Wakeups } from "./wakeups.ts";
import type { ChatMessage } from "./types.ts";

/** How many ideas one beat comes up with. */
export const IDEAS_PER_BEAT = 3;

/** Where the next beat's time is kept (app_state). */
const NEXT_KEY = "heartbeat.next";

/** What a beat did. */
export interface BeatResult {
  outcome: "off" | "not-due" | "blocked" | "no-ideas" | "woke" | "failed";
  detail: string;
  wake?: WakeResult;
}

/** The writer's instructions for ideas. */
export function ideasRequest(partnerName: string, partnerPrompt: string, context: string): ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        `You are ${partnerName}, the user's creative writing partner.`,
        partnerPrompt.trim() ? `Who you are:\n${partnerPrompt.trim()}` : "",
        `You're between conversations, and something might be worth texting the user about. Come up with ${IDEAS_PER_BEAT} ideas you could bring them: a new roleplay premise ("story"), a character ("character"), a twist or next step for a story you're in together ("twist"), or a thought about something you talked about ("thought").`,
        "Make each specific to the two of you and what you've been writing, not generic. Don't repeat ideas you've had before (listed below). One or two sentences each, in your own voice.",
        'Reply with JSON only: {"ideas": [{"kind": "story", "idea": "..."}]}',
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
    { role: "user", content: context },
  ];
}

/** Read the writer's ideas, keeping only well-formed ones. */
export function readIdeas(content: string): { kind: IdeaKind; content: string }[] {
  let json: unknown;
  try {
    json = extractJson(content);
  } catch {
    return [];
  }
  const list = (json as { ideas?: unknown })?.ideas;
  if (!Array.isArray(list)) return [];
  const kinds: IdeaKind[] = ["story", "character", "twist", "thought"];
  return list
    .map((raw: Record<string, unknown>) => ({
      kind: kinds.includes(raw?.kind as IdeaKind) ? (raw.kind as IdeaKind) : "thought",
      content: typeof raw?.idea === "string" ? raw.idea.trim().slice(0, 600) : "",
    }))
    .filter((i) => i.content)
    .slice(0, IDEAS_PER_BEAT);
}

/** Jev's grading of one idea: three questions that must agree. */
export function gradeSeries(idea: string, index: number): SeriesQuestion {
  return {
    id: `i${index}`,
    phrasings: [
      `Is this idea fresh: not something their stories have already done, and not something they already talked about? The idea: "${idea}"`,
      `Given what the user writes and talks about, would they likely be excited to hear this idea? The idea: "${idea}"`,
      `Is this idea specific and worth texting the user about, rather than generic or forgettable? The idea: "${idea}"`,
    ],
  };
}

export class Heartbeat {
  private timer: ReturnType<typeof setInterval> | null = null;
  private beating = false;

  constructor(
    private readonly store: Store,
    private readonly api: ApiOptions,
    private readonly decider: Decider,
    private readonly wakeups: Wakeups,
    private readonly now: () => Date = () => new Date(),
    private readonly random: () => number = Math.random,
  ) {}

  /** Check every `checkMs` whether a beat is due. */
  start(checkMs = 10 * 60_000): void {
    this.stop();
    this.timer = setInterval(() => void this.tick(), checkMs);
    // Right away too: schedules the first beat (or beats, if one was due while the server was off).
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** When the next beat is due, or `null` if the heartbeat is off. */
  nextAt(): Date | null {
    if (this.store.getSettings().heartbeatHours <= 0) return null;
    const value = this.store.appState.get(NEXT_KEY);
    return value ? new Date(value) : null;
  }

  /** Set the next beat's time: `heartbeatHours` from now, ±20%. */
  private schedule(): Date {
    const hours = this.store.getSettings().heartbeatHours * (0.8 + 0.4 * this.random());
    const next = new Date(this.now().getTime() + hours * 3_600_000);
    this.store.appState.set(NEXT_KEY, next.toISOString());
    return next;
  }

  /**
   * Beat if it's time (or `force`: Settings → "Beat now"). Never throws.
   */
  async tick(force = false): Promise<BeatResult> {
    if (this.beating) return { outcome: "not-due", detail: "A beat is already running." };
    const settings = this.store.getSettings();
    if (settings.heartbeatHours <= 0 && !force) return { outcome: "off", detail: "The heartbeat is off." };
    if (!force) {
      const next = this.nextAt();
      // The first check after turning it on only sets the time.
      if (!next) {
        this.schedule();
        return { outcome: "not-due", detail: "First beat scheduled." };
      }
      if (this.now() < next) return { outcome: "not-due", detail: `Next beat at ${next.toISOString()}.` };
    }
    this.beating = true;
    try {
      if (settings.heartbeatHours > 0) this.schedule();
      return await this.beat();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[heartbeat] failed: ${message}`);
      return { outcome: "failed", detail: message };
    } finally {
      this.beating = false;
    }
  }

  private async beat(): Promise<BeatResult> {
    const { store } = this;
    const blocked = this.wakeups.blocked("heartbeat");
    if (blocked) {
      console.log(`[heartbeat] ${blocked}`);
      return { outcome: "blocked", detail: blocked };
    }
    const settings = store.getSettings();
    const channels = store.listChannels();
    const ooc = homeChannel(store, channels)!;

    // 2. Generate.
    const profile = pickProfile(store, ooc);
    const request = profileRequest(profile);
    const response = await createChatCompletion(this.api, {
      ...request,
      maxTokens: Math.max(request.maxTokens, 800),
      messages: ideasRequest(settings.partnerName, settings.partnerPrompt, this.context()),
    });
    const ideas = readIdeas(response.content);
    console.log(`[heartbeat] ${ideas.length} idea(s) from "${profile.name}"`);

    // 3. Grade (only with Jev: without it, nothing is judged exciting).
    let best: { index: number; grade: number } | null = null;
    const graded: { status: "drawer" | "dropped"; grade: number; note: string }[] = [];
    if (ideas.length > 0 && this.decider.enabled()) {
      const verdicts = await this.decider.askSeries(
        this.gradingState(),
        ideas.map((idea, i) => gradeSeries(idea.content, i)),
        settings.decisionConfidence,
        { purpose: "Heartbeat: grading ideas" },
      );
      ideas.forEach((_, i) => {
        const v = verdicts.get(`i${i}`)!;
        const grade = v.yes.reduce((a, b) => a + b, 0) / Math.max(1, v.yes.length);
        graded[i] = {
          status: v.verdict === "no" ? "dropped" : "drawer",
          grade,
          note: v.verdict === "no" ? `Jev: not worth it (${describeVerdict(v)}).` : `Jev: ${describeVerdict(v)}.`,
        };
        if (v.verdict === "yes" && (!best || grade > best.grade)) best = { index: i, grade };
      });
    } else {
      ideas.forEach(() => graded.push({ status: "drawer", grade: 0, note: "Not graded (Jev is off)." }));
    }

    // Everything but the best goes in the drawer (or is dropped).
    const saved = ideas.map((idea, i) =>
      store.ideas.add({ kind: idea.kind, content: idea.content, grade: graded[i]!.grade, status: graded[i]!.status, note: graded[i]!.note }),
    );

    // 4. Share the best.
    const chosen = best as { index: number; grade: number } | null;
    if (chosen) {
      const idea = saved[chosen.index]!;
      const wake = await this.wakeups.event("heartbeat", { idea: idea.content });
      if (wake.outcome === "posted") store.ideas.setStatus(idea.id, "shared", "Shared on a heartbeat.");
      else store.ideas.setStatus(idea.id, "drawer", `Exciting, but not shared yet: ${wake.detail}`);
      return { outcome: "woke", detail: `Shared "${idea.content.slice(0, 80)}"? ${wake.outcome ?? "skipped"}: ${wake.detail}`, wake };
    }

    // No exciting idea: after a long silence, maybe check in anyway.
    const since = this.silenceHours();
    if (since !== null && since >= settings.heartbeatHours) {
      const wake = await this.wakeups.event("heartbeat", {});
      return { outcome: "woke", detail: `Just because: ${wake.outcome ?? "skipped"}: ${wake.detail}`, wake };
    }
    return { outcome: "no-ideas", detail: `No idea exciting enough (${saved.length} kept or dropped).` };
  }

  /** Hours since you last wrote anything, or `null` if you never have. */
  private silenceHours(): number | null {
    let last = "";
    for (const c of this.store.listChannels()) {
      const m = this.store.getMessages(c.id).filter((m) => m.author === "user" && m.kind === "post").at(-1);
      if (m && m.createdAt > last) last = m.createdAt;
    }
    return last ? (this.now().getTime() - new Date(last).getTime()) / 3_600_000 : null;
  }

  /** What the writer sees: the server, the recent chat, the notebook, past ideas. */
  private context(): string {
    const { store } = this;
    const settings = store.getSettings();
    const channels = store.listChannels();
    const parts: string[] = [];
    const digests = channels
      .map((c) => {
        const digest = store.summaries.get(c.id, "digest")?.content;
        return digest ? `#${c.name} (${c.kind === "rp" ? "roleplay" : "out of character"}): ${digest}` : "";
      })
      .filter(Boolean);
    if (digests.length) parts.push(`Your server:\n${digests.join("\n")}`);
    const ooc = homeChannel(store, channels);
    if (ooc) {
      const recent = store
        .getMessages(ooc.id)
        .filter((m) => m.kind === "post")
        .slice(-12)
        .map((m) => `${m.author === "user" ? "User" : settings.partnerName}: ${m.content.replace(/\s+/g, " ").slice(0, 300)}`);
      if (recent.length) parts.push(`Your latest chat with the user (#${ooc.name}), newest last:\n${recent.join("\n")}`);
    }
    const entries = store.notebook.listEntries("partner").filter((e) => store.notebook.canSeeEntry("user", e.id));
    if (entries.length) parts.push(`The notebook: ${entries.map((e) => e.name).join(", ")}.`);
    const past = store.ideas.list().slice(0, 20);
    if (past.length) parts.push(`Ideas you've had before (don't repeat these):\n${past.map((i) => `- ${i.content}`).join("\n")}`);
    return parts.join("\n\n") || "You haven't talked much yet.";
  }

  /** What Jev grades against: what you write and talk about, briefly. */
  private gradingState(): string {
    const { store } = this;
    const channels = store.listChannels();
    const digests = channels.map((c) => store.summaries.get(c.id, "digest")?.content).filter(Boolean);
    const ooc = homeChannel(store, channels);
    const recent = ooc
      ? store
          .getMessages(ooc.id)
          .filter((m) => m.kind === "post")
          .slice(-10)
          .map((m) => `${m.author === "user" ? "User" : "Partner"}: ${m.content.replace(/\s+/g, " ").slice(0, 300)}`)
      : [];
    const shared = store.ideas.list().filter((i) => i.status === "shared").slice(0, 10).map((i) => `- ${i.content}`);
    return [
      digests.length ? `What they write together:\n${digests.join("\n")}` : "",
      recent.length ? `Their latest chat, newest last:\n${recent.join("\n")}` : "",
      shared.length ? `Ideas the partner already shared:\n${shared.join("\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n\n") || "They haven't written much yet.";
  }
}
