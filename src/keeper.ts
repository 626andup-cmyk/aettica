/**
 * The notebook keeper: notices what the story establishes, and writes it
 * into the notebook, as your partner, between turns.
 *
 * A character gets a name, a place turns out to be haunted, Ilse admits she
 * had a brother. Those are lasting facts, and the notebook is where they
 * belong, so neither of you has to stop and write them down. But a keeper
 * that writes down wrong things is worse than none, so every step is
 * checked, and unsure always means "leave the notebook alone":
 *
 *   1. **Is there anything?** Every few posts in a roleplay channel
 *      (`keeperEvery`, or when a scene ends), Jev reads the new posts and the
 *      notebook's names and is asked, each in two phrasings that must agree
 *      (a series, see src/jev.ts): is there a new named character, place or
 *      thing that will matter? Is there a lasting fact about something
 *      already in the notebook? Does the story contradict something the
 *      notes say (Kitsikai's "does this take back the note?")? Usually the
 *      answer is no, and that's one cheap call.
 *   2. **What exactly?** Only on a yes, a writer model (the profile that
 *      writes summaries) drafts the changes as JSON: new entries, and notes
 *      to add to existing ones, each with a one-sentence claim of what the
 *      story established.
 *   3. **Is it really in the text?** Jev checks every claim against the
 *      posts alone, again in two or three phrasings that must all agree.
 *      Anything not confidently supported is dropped.
 *   4. **Made as your partner.** New entries are shared ("joint"). Notes and
 *      corrections go through the notebook's permissions like any of your
 *      partner's edits (locked entries are left alone), except that your own
 *      entries only ever get suggestions: nothing of yours changes unless
 *      you say so. What was done shows in the channel ("⚙ Arlo added Tamsin to
 *      the notebook") and in your partner's recent actions.
 *
 * ## Nothing hidden leaks
 *
 * Like summaries, the keeper works from the messages, which you can read,
 * and only shows the writer entries that aren't hidden from you. Claims are
 * checked against the messages alone. So nothing from a secret entry can
 * end up in a shared one.
 *
 * It only reads roleplay channels: in OOC you're talking *about* the story,
 * and ideas there aren't canon yet. It reads each post once (edits to old
 * posts don't set it off again).
 */

import type { Database } from "bun:sqlite";
import { describeVerdict, type Decider, type SeriesQuestion } from "./jev.ts";
import { extractJson } from "./json.ts";
import { createChatCompletion, type ApiOptions } from "./nanogpt.ts";
import type { EntryView } from "./notebook.ts";
import { pickProfile, profileRequest } from "./partner.ts";
import type { Store } from "./store.ts";
import { transcript, type SeqMessage } from "./summaries.ts";
import type { Channel, ChatMessage, EntryField, Profile } from "./types.ts";

/** At most this many of the newest unread posts are read at once. */
export const KEEPER_BATCH = 24;

/** At most this many changes per run. */
export const KEEPER_MAX_CHANGES = 4;

/** A change the writer drafted. */
export type KeeperChange =
  | { action: "create"; kind: "character" | "lore"; name: string; fields: EntryField[]; claim: string }
  | { action: "add"; entry: string; fields: EntryField[]; claim: string }
  /** Notes that are now wrong: these fields are rewritten, not added to. */
  | { action: "replace"; entry: string; fields: EntryField[]; claim: string };

/** What a run did, for tests and the log. */
export interface KeeperReport {
  channelId: string;
  /** Why it stopped where it did. */
  outcome: "off" | "not-due" | "nothing" | "unsure" | "no-changes" | "applied" | "failed";
  detail: string;
  applied: string[];
  dropped: string[];
}

// ------------------------------------------------------------- the state

/** How far the keeper has read in each channel. */
export class KeeperState {
  constructor(private readonly db: Database) {}

  /** The newest message (by seq) read in a channel, or `null` if none yet. */
  get(channelId: string): number | null {
    const row = this.db.query("SELECT through_seq FROM keeper_state WHERE channel_id = $channelId").get({ channelId }) as {
      through_seq: number;
    } | null;
    return row?.through_seq ?? null;
  }

  set(channelId: string, throughSeq: number): void {
    this.db
      .query(
        `INSERT INTO keeper_state (channel_id, through_seq) VALUES ($channelId, $throughSeq)
         ON CONFLICT (channel_id) DO UPDATE SET through_seq = excluded.through_seq`,
      )
      .run({ channelId, throughSeq });
  }
}

// ------------------------------------------------------------- questions

/** Step 1: is there anything to note? Each asked two ways. */
export const DETECT: SeriesQuestion[] = [
  {
    id: "new",
    phrasings: [
      "Do the new messages introduce a named character, place, group or object that is not in the notebook list and is likely to matter again in the story?",
      "Is someone or something given a name in the new messages that the notebook doesn't have an entry for yet, and that the story will probably come back to?",
    ],
  },
  {
    id: "facts",
    phrasings: [
      "Do the new messages establish a lasting fact (history, relationships, appearance, abilities, a revealed secret) about a character or thing already in the notebook, that its notes don't already say?",
      "Would a careful note-keeper add something from the new messages to an existing notebook entry, because it's now true for the rest of the story (not just a passing action or mood)?",
    ],
  },
  {
    // Kitsikai's "do the new messages take back or change this note?"
    id: "changed",
    phrasings: [
      "Do the new messages contradict or take back something the notebook's notes say (a fact that changed, or was retold differently)?",
      "Is anything written in the notebook's notes now wrong because of the new messages?",
    ],
  },
];

/** Step 3: is a drafted change really in the text? */
export function verifySeries(change: KeeperChange, index: number): SeriesQuestion {
  const claim = change.claim.replace(/\s+/g, " ").trim();
  const phrasings = [
    `According to the story messages, is this true: "${claim}"?`,
    `Is this stated or clearly shown in the messages, rather than guessed or invented: "${claim}"?`,
  ];
  if (change.action === "create") {
    phrasings.push(
      change.kind === "character"
        ? `Is "${change.name}" a character in these messages who is likely to matter again in the story?`
        : `Is "${change.name}" a named place, group, object or idea in these messages that is likely to matter again in the story?`,
    );
  }
  return { id: `c${index}`, phrasings };
}

// ---------------------------------------------------------------- writer

/** The writer's instructions. */
export function keeperRequest(partnerName: string, notebook: string, channelName: string, lines: string[]): ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        `You keep the notebook for a collaborative story between the user and their writing partner, ${partnerName}. Read the new part of the story and decide what the notebook should now record.`,
        "Record only what the messages state or clearly show. Never guess, never invent, never add what you know from elsewhere. Record only lasting things: who someone is, their relationships, history, appearance, abilities; what a place or thing is; secrets that were revealed. Not passing actions, moods or dialogue.",
        "Don't repeat what an entry's notes already say.",
        "Reply with JSON only, in this shape:",
        `{"changes": [
  {"action": "create", "kind": "character", "name": "Full Name", "fields": [{"label": "Appearance", "value": "short note"}], "claim": "One sentence saying what the story established."},
  {"action": "add", "entry": "Existing Entry Name", "fields": [{"label": "Background", "value": "short note"}], "claim": "One sentence saying what the story established."},
  {"action": "replace", "entry": "Existing Entry Name", "fields": [{"label": "Age", "value": "the corrected note, in full"}], "claim": "One sentence saying what changed."}
]}`,
        `Use "create" for someone or something new (kind "character", or "lore" for places, groups, objects, history), "add" for notes on an entry the notebook already has, and "replace" when the story changed or contradicted what a field says (give the field's whole corrected text). At most ${KEEPER_MAX_CHANGES} changes. Characters' field labels: Pronouns, Age, Appearance, Personality, Background, Speech. Lore's: Summary, Details. Values are short notes, not prose. If nothing is worth recording, reply {"changes": []}.`,
      ].join("\n\n"),
    },
    { role: "user", content: `The notebook:\n${notebook}\n\nThe new part of the story (#${channelName}):\n\n${lines.join("\n\n")}` },
  ];
}

/** Read the writer's JSON, keeping only well-formed changes. */
export function readChanges(content: string): KeeperChange[] {
  let json: unknown;
  try {
    json = extractJson(content);
  } catch {
    return [];
  }
  const list = (json as { changes?: unknown })?.changes;
  if (!Array.isArray(list)) return [];
  const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const changes: KeeperChange[] = [];
  for (const raw of list as Record<string, unknown>[]) {
    const fields = (Array.isArray(raw?.fields) ? (raw.fields as Record<string, unknown>[]) : [])
      .map((f) => ({ label: text(f?.label, 40), value: text(f?.value, 600) }))
      .filter((f) => f.label && f.value)
      .slice(0, 8);
    const claim = text(raw?.claim, 400);
    if (!claim) continue;
    if (raw?.action === "create") {
      const name = text(raw.name, 100);
      const kind = raw.kind === "lore" ? "lore" : "character";
      if (name) changes.push({ action: "create", kind, name, fields, claim });
    } else if (raw?.action === "add" || raw?.action === "replace") {
      const entry = text(raw.entry, 100);
      if (entry && fields.length) changes.push({ action: raw.action, entry, fields, claim });
    }
  }
  return changes.slice(0, KEEPER_MAX_CHANGES);
}

/** Add notes to fields: fill an empty field, append to one that doesn't say it yet, or add a new field. */
export function mergeFields(current: EntryField[], additions: EntryField[]): EntryField[] | null {
  const fields = current.map((f) => ({ ...f }));
  const plain = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  let changed = false;
  for (const add of additions) {
    const existing = fields.find((f) => f.label.toLowerCase() === add.label.toLowerCase());
    if (!existing) {
      fields.push({ ...add });
      changed = true;
    } else if (!existing.value.trim()) {
      existing.value = add.value;
      changed = true;
    } else if (!plain(existing.value).includes(plain(add.value))) {
      existing.value = `${existing.value.trim()}${/[.!?]$/.test(existing.value.trim()) ? "" : "."} ${add.value}`;
      changed = true;
    }
  }
  return changed ? fields : null;
}

/** Rewrite fields whose notes are now wrong (adding any that are missing). `null` if nothing changes. */
export function replaceFields(current: EntryField[], replacements: EntryField[]): EntryField[] | null {
  const fields = current.map((f) => ({ ...f }));
  let changed = false;
  for (const r of replacements) {
    const existing = fields.find((f) => f.label.toLowerCase() === r.label.toLowerCase());
    if (!existing) {
      fields.push({ ...r });
      changed = true;
    } else if (existing.value.trim() !== r.value.trim()) {
      existing.value = r.value;
      changed = true;
    }
  }
  return changed ? fields : null;
}

// ---------------------------------------------------------------- keeper

export class Keeper {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly runs = new Map<string, Promise<KeeperReport>>();

  /**
   * @param delayMs  How long after a change to look (so a turn's several
   *                 messages count once). Negative: only when asked (tests).
   */
  constructor(
    private readonly store: Store,
    private readonly api: ApiOptions,
    private readonly decider: Decider,
    private readonly delayMs = 8000,
  ) {
    store.watchMessages((channelId) => this.schedule(channelId));
  }

  schedule(channelId: string): void {
    if (this.delayMs < 0) return;
    clearTimeout(this.timers.get(channelId));
    this.timers.set(
      channelId,
      setTimeout(() => {
        this.timers.delete(channelId);
        void this.catchUp(channelId);
      }, this.delayMs),
    );
  }

  stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  /** Look at a channel's new posts now, after any look already running. Never throws. */
  catchUp(channelId: string): Promise<KeeperReport> {
    const previous = this.runs.get(channelId) ?? Promise.resolve(null);
    const run = previous.then(async () => {
      try {
        return await this.work(channelId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[keeper] couldn't read channel ${channelId}: ${message}`);
        return report(channelId, "failed", message);
      }
    });
    this.runs.set(channelId, run);
    return run;
  }

  private async work(channelId: string): Promise<KeeperReport> {
    const { store } = this;
    const settings = store.getSettings();
    if (!settings.notebookKeeper || !this.api.apiKey || !this.decider.enabled()) return report(channelId, "off", "The keeper is off.");
    let channel: Channel;
    try {
      channel = store.getChannel(channelId);
    } catch {
      return report(channelId, "off", "The channel is gone.");
    }
    if (channel.kind !== "rp") return report(channelId, "off", "Only roleplay channels are kept.");

    const messages = store.summaries.withSeq(channelId, store.getMessages(channelId));
    const through = store.keeper.get(channelId) ?? 0;
    const fresh = messages.filter((m) => m.seq > through);
    const posts = fresh.filter((m) => m.kind === "post");
    const sceneEnded = fresh.some((m) => m.kind === "scene_break");
    if (posts.length === 0 || (posts.length < settings.keeperEvery && !sceneEnded)) {
      return report(channelId, "not-due", `${posts.length} new post(s).`);
    }
    const reading = posts.slice(-KEEPER_BATCH);
    const done = () => store.keeper.set(channelId, fresh.at(-1)!.seq);
    const lines = transcript(reading, "rp", settings.partnerName);
    const threshold = settings.decisionConfidence;

    // What the keeper may know of the notebook: entries you can see too.
    const entries = store.notebook.listEntries("partner").filter((e) => store.notebook.canSeeEntry("user", e.id));

    // 1. Is there anything?
    // Entries the new posts mention come with their notes (so a contradiction
    // can be seen); the rest, just a name.
    const notebook = describeNotebook(entries, reading);
    const detect = await this.decider.askSeries(
      `The notebook:\n${notebook}\n\nThe new messages of the story:\n\n${lines.join("\n\n")}`,
      DETECT,
      threshold,
      { purpose: "Notebook keeper" },
    );
    const found = DETECT.filter((q) => detect.get(q.id)!.verdict === "yes");
    const verdicts = DETECT.map((q) => `${q.id} ${describeVerdict(detect.get(q.id)!)}`).join(", ");
    if (found.length === 0) {
      done();
      const unsure = DETECT.some((q) => detect.get(q.id)!.verdict === "unsure");
      return report(channelId, unsure ? "unsure" : "nothing", `Jev: ${verdicts}.`);
    }

    // 2. What exactly?
    const profile = pickProfile(store, channel, undefined, "summary");
    const drafted = await this.draft(profile, settings.partnerName, notebook, channel, lines);
    if (drafted.length === 0) {
      done();
      return report(channelId, "no-changes", `Jev: ${verdicts}; the writer found nothing to record.`);
    }

    // 3. Is each really in the text? (Checked against the messages alone.)
    const series = drafted.map(verifySeries);
    const checks = await this.decider.askSeries(
      `The story messages:\n\n${lines.join("\n\n")}`,
      series,
      threshold,
      { purpose: "Notebook keeper (check)" },
    );

    // 4. Make the changes, as your partner.
    const turnId = `keeper-${crypto.randomUUID()}`;
    const result = report(channelId, "applied", `Jev: ${verdicts}.`);
    drafted.forEach((change, i) => {
      const check = checks.get(`c${i}`)!;
      const name = change.action === "create" ? change.name : change.entry;
      if (check.verdict !== "yes") {
        result.dropped.push(`${name}: not confirmed (${describeVerdict(check)})`);
        return;
      }
      const done = this.apply(change, entries);
      if (!done) {
        result.dropped.push(`${name}: nothing to change`);
        return;
      }
      store.toolLog.add({
        channelId,
        turnId,
        round: 0,
        name: "notebook_keeper",
        arguments: JSON.stringify(change),
        result: JSON.stringify({ ...done.result, check: describeVerdict(check) }),
        status: "ok",
        summary: done.summary,
        source: "keeper",
        profile: profile.name,
      });
      result.applied.push(done.summary);
    });
    done();
    if (result.applied.length === 0) result.outcome = "no-changes";
    // Tell the app something changed (the actions show in the channel).
    else store.revision++;
    console.log(`[keeper] #${channel.name}: ${result.applied.join("; ") || "nothing applied"}${result.dropped.length ? ` (dropped: ${result.dropped.join("; ")})` : ""}`);
    return result;
  }

  /** Ask the writer for the changes. */
  private async draft(
    profile: Profile,
    partnerName: string,
    notebook: string,
    channel: Channel,
    lines: string[],
  ): Promise<KeeperChange[]> {
    const request = profileRequest(profile);
    const response = await createChatCompletion(this.api, {
      ...request,
      temperature: Math.min(request.temperature, 0.4),
      maxTokens: Math.max(request.maxTokens, 1024),
      messages: keeperRequest(partnerName, notebook, channel.name, lines),
    });
    return readChanges(response.content);
  }

  /** Make one change as your partner. `null` if there was nothing to do (or it wasn't allowed). */
  private apply(change: KeeperChange, entries: EntryView[]): { summary: string; result: Record<string, unknown> } | null {
    const { notebook } = this.store;
    const wanted = (change.action === "create" ? change.name : change.entry).toLowerCase();
    const existing = entries.find((e) => e.name.toLowerCase() === wanted);

    if (change.action === "create" && !existing) {
      const template = change.kind === "character" ? ["Pronouns", "Age", "Appearance", "Personality", "Background", "Speech"] : ["Summary", "Details"];
      const fields = mergeFields(
        template.map((label) => ({ label, value: "" })),
        change.fields,
      ) ?? template.map((label) => ({ label, value: "" }));
      const entry = notebook.createEntry("partner", { kind: change.kind, name: change.name, owner: "joint", fields });
      entries.push(entry);
      return { summary: `added ${change.name} to the notebook`, result: { created: entry.name } };
    }

    // Notes for an entry that exists (a "create" of one that exists is the same).
    if (!existing || existing.access.edit === "none") return null;
    const fields = change.action === "replace" ? replaceFields(existing.fields, change.fields) : mergeFields(existing.fields, change.fields);
    if (!fields) return null;
    try {
      // Your own entries only change when you say so: notes on them are suggestions.
      const outcome = notebook.editEntry("partner", existing.id, { fields }, { suggest: existing.owner === "user" });
      if ("suggestion" in outcome) return { summary: `suggested notes for ${existing.name}`, result: { suggested: existing.name } };
      existing.fields = outcome.entry.fields;
      const verb = change.action === "replace" ? "corrected" : "noted in";
      return { summary: `${verb} ${existing.name}: ${change.fields.map((f) => f.label).join(", ")}`, result: { edited: existing.name } };
    } catch (error) {
      console.warn(`[keeper] couldn't change ${existing.name}:`, error);
      return null;
    }
  }
}

/** The notebook for the keeper: notes for the entries the posts mention, names for the rest. */
function describeNotebook(entries: EntryView[], reading: SeqMessage[]): string {
  const text = reading.map((m) => `${m.characters.join(" ")} ${m.content}`).join(" ").toLowerCase();
  const mentioned = (e: EntryView) => e.name.toLowerCase().split(/\s+/).some((word) => word.length > 2 && text.includes(word));
  return (
    entries
      .map((e) =>
        mentioned(e)
          ? `- ${e.name} (${e.kind}): ${e.fields.filter((f) => f.value.trim()).map((f) => `${f.label}: ${f.value.trim()}`).join("; ").slice(0, 1500) || "no notes yet"}`
          : `- ${e.name} (${e.kind})`,
      )
      .join("\n") || "(empty)"
  );
}

function report(channelId: string, outcome: KeeperReport["outcome"], detail: string): KeeperReport {
  return { channelId, outcome, detail, applied: [], dropped: [] };
}
