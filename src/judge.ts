/**
 * Jev double-checks: the places Aettica used to guess, and now asks.
 *
 * Aettica makes a handful of small judgements outside the writing itself.
 * Most are plain rules and should stay that way (see docs/jev-audit.md for
 * every one, and why). These are the ones where a wrong guess costs
 * something, and a Jev **series** (one question in two phrasings that must
 * agree, see src/jev.ts) does better:
 *
 *   - **Comment replies** (`wantsReply`): your partner always answers
 *     comments on their own messages, or in threads they're in. A comment on
 *     *your* message used to get no answer, even "Arlo, is this too much?".
 *     Now Jev is asked whether it invites a reply.
 *   - **Deleting an entry** (`confirmDelete`): the one thing your partner can
 *     do that can't be undone. Before it happens, Jev is asked whether it's
 *     clearly wanted. If not confidently yes, it's held back, and your
 *     partner is told why.
 *   - **Faithful summaries** (`faithfulSummary`): scene summaries feed the
 *     story so far, the digests and every prompt after, so one invented
 *     detail spreads. Each new scene summary is checked against the scene;
 *     a confident "no" gets it rewritten once, more strictly.
 *   - **Channel mentions** (`aboutChannels`): in OOC, a channel's summary is
 *     added when it comes up. `#story` is clear; the bare word "story" often
 *     isn't about the channel. Bare-word matches are checked, and a
 *     confident no leaves the summary out.
 *
 * Every check needs Jev (or its fallback) and the "Double-check with Jev"
 * setting (`jevChecks`). Without them, things work as before. A check that
 * fails (Jev down) falls back the same way, except deleting, which waits.
 */

import { describeVerdict, type Decider, type SeriesQuestion, type SeriesVerdict } from "./jev.ts";
import type { EntryView } from "./notebook.ts";
import type { Store } from "./store.ts";
import type { Channel } from "./types.ts";

/** Longest material a check reads (characters); longer is skipped. */
export const CHECK_LIMIT = 30_000;

export class Judge {
  constructor(
    private readonly store: Store,
    private readonly decider: Decider,
  ) {}

  /** Whether checks can run: Jev (or a fallback) is set, and they're turned on. */
  enabled(): boolean {
    return this.store.getSettings().jevChecks && this.decider.enabled();
  }

  /** Ask a series; `null` if checks are off, or the call failed (logged). */
  private async ask(state: string, series: SeriesQuestion[], purpose: string): Promise<Map<string, SeriesVerdict> | null> {
    if (!this.enabled()) return null;
    try {
      const verdicts = await this.decider.askSeries(state, series, this.store.getSettings().decisionConfidence, { purpose });
      console.log(`[judge] ${purpose}: ${[...verdicts].map(([id, v]) => `${id} ${describeVerdict(v)}`).join(", ")}`);
      return verdicts;
    } catch (error) {
      console.warn(`[judge] ${purpose} failed: ${error instanceof Error ? error.message : error}`);
      return null;
    }
  }

  /**
   * A comment of yours on your own message, in a thread your partner isn't
   * in: does it invite their reply? Only a confident yes says so.
   */
  async wantsReply(quote: string, note: string, messageText: string): Promise<boolean> {
    const partner = this.store.getSettings().partnerName;
    const state = [
      `The user left a comment on their own message in a story they write with their partner, ${partner}.`,
      `The message: "${messageText.slice(0, 2000)}"`,
      quote ? `The comment is on the words: "${quote}"` : "",
      `The comment: "${note}"`,
    ]
      .filter(Boolean)
      .join("\n");
    const verdicts = await this.ask(
      state,
      [
        {
          id: "reply",
          phrasings: [
            `Does the comment ask ${partner} something, or invite a reply from them?`,
            `Would ${partner}, reading this comment, be expected to answer it (rather than it being a private note the user left for themselves)?`,
          ],
        },
      ],
      "Comment reply",
    );
    return verdicts?.get("reply")?.verdict === "yes";
  }

  /**
   * Your partner wants to delete one of their own entries: is it clearly
   * wanted? `ok: false` holds it back (with the reason for them).
   */
  async confirmDelete(entry: EntryView, recent: string[]): Promise<{ ok: boolean; why: string }> {
    if (!this.enabled()) return { ok: true, why: "" };
    const notes = entry.fields.filter((f) => f.value.trim()).map((f) => `${f.label}: ${f.value.trim()}`).join("; ");
    const state = [
      `The writing partner wants to permanently delete the notebook entry "${entry.name}" (${entry.kind}${notes ? `: ${notes.slice(0, 1500)}` : ", no notes"}).`,
      recent.length ? `The latest messages, newest last:\n${recent.join("\n")}` : "There are no recent messages.",
    ].join("\n\n");
    const verdicts = await this.ask(
      state,
      [
        {
          id: "delete",
          phrasings: [
            `Is deleting "${entry.name}" clearly wanted: asked for by the user, or clearly right because it's a duplicate, a mistake, or no longer part of any story?`,
            `Would the user be glad, rather than upset, that "${entry.name}" was deleted from the notebook right now?`,
          ],
        },
      ],
      "Deleting an entry",
    );
    const verdict = verdicts?.get("delete");
    if (!verdict) return { ok: false, why: "It couldn't be double-checked just now, so it wasn't deleted. Try again later, or leave it." };
    if (verdict.verdict === "yes") return { ok: true, why: "" };
    return {
      ok: false,
      why: `Held back: it isn't clear that deleting ${entry.name} is wanted (${describeVerdict(verdict)}). If the user asked for it, say so to them and they can delete it; otherwise, leave it.`,
    };
  }

  /**
   * Your partner wants to edit one of *your* entries, which you let them
   * edit directly: did you ask for it? (Kitsikai's planner rule: nothing of
   * yours changes on their idea alone.) If not confidently yes, the edit
   * becomes a suggestion for you to review.
   */
  async userAskedFor(entry: EntryView, change: string, recent: string[]): Promise<boolean> {
    const state = [
      `The writing partner wants to edit the user's own notebook entry "${entry.name}" (${entry.kind}). The edit: ${change.slice(0, 1500)}`,
      recent.length ? `The latest messages, newest last:
${recent.join("\n")}` : "There are no recent messages.",
    ].join("\n\n");
    const verdicts = await this.ask(
      state,
      [
        {
          id: "asked",
          phrasings: [
            `Did the user ask for this change to their entry "${entry.name}", or clearly agree to it? Not if it's only the partner's own idea.`,
            `Would the user expect this edit to "${entry.name}", because they asked for it in these messages?`,
          ],
        },
      ],
      "Editing your entry",
    );
    return verdicts?.get("asked")?.verdict === "yes";
  }

  /**
   * Is a scene summary faithful to the scene? "no" (confidently unfaithful)
   * means rewrite it; "yes" or "unsure" (or no check) means keep it.
   */
  async faithfulSummary(sceneLines: string[], summary: string): Promise<"yes" | "no" | "unsure" | null> {
    const scene = sceneLines.join("\n\n");
    if (scene.length > CHECK_LIMIT) return null;
    const verdicts = await this.ask(
      `A scene of a story:\n\n${scene}\n\nA summary of that scene:\n\n${summary}`,
      [
        {
          id: "faithful",
          phrasings: [
            "Is everything the summary says supported by the scene, with nothing invented or changed?",
            "Does the summary stick to what actually happens in the scene, without adding events, names or details that aren't there?",
          ],
        },
      ],
      "Summary check",
    );
    return verdicts?.get("faithful")?.verdict ?? null;
  }

  /**
   * In OOC, which channels named only by a bare word ("story") are really
   * being talked about? Returns the ids to leave out (confident no's).
   */
  async aboutChannels(candidates: Channel[], recentLines: string[]): Promise<Set<string>> {
    if (candidates.length === 0 || recentLines.length === 0) return new Set();
    const series: SeriesQuestion[] = candidates.map((c) => ({
      id: c.id,
      phrasings: [
        `Is the conversation talking about the roleplay channel called "${c.name}" (the story played there), rather than just using the word "${c.name}"?`,
        `Would it help to know what has happened in the storyline "${c.name}" to follow this conversation?`,
      ],
    }));
    const verdicts = await this.ask(
      `An out-of-character chat between the user and their writing partner, newest last:\n\n${recentLines.join("\n")}`,
      series,
      "Channel mentions",
    );
    const out = new Set<string>();
    for (const c of candidates) if (verdicts?.get(c.id)?.verdict === "no") out.add(c.id);
    return out;
  }
}
