/**
 * The summarizer (stage 7): writes a channel's summaries in the background,
 * with the model, whenever its messages change (see src/summaries.ts for
 * what each summary is).
 *
 * After a channel changes, it waits a few seconds (so a reply and your next
 * message don't each set it off), then catches the channel up, in order:
 *
 *   1. **Finished scenes** without a summary (or whose messages changed):
 *      each is summarized, starting from its "earlier in this scene" notes
 *      when it has them, so a long scene is never read twice.
 *   2. **The story so far**: new scene summaries are folded into it. If
 *      something it covers changed, it's rebuilt from the scene summaries.
 *   3. **Earlier in this scene** (in OOC, the conversation): once more than
 *      `historyLimit + summaryEvery` of the scene's messages are waiting,
 *      the oldest are folded into it, leaving `historyLimit` in full.
 *   4. **The digest**, when the channel has moved on since the last one.
 *
 * Only one catch-up runs per channel at a time, and they never block your
 * partner's turns. If a request fails, the summarizer stops there and tries
 * again the next time the channel changes (or when you press "Update now").
 * Long material is read in chunks, each folded into the notes so far.
 */

import { createChatCompletion, type ApiOptions } from "./nanogpt.ts";
import { pickProfile, profileRequest } from "./partner.ts";
import type { Store } from "./store.ts";
import {
  chunkLines,
  cleanSummary,
  splitScenes,
  summaryRequest,
  transcript,
  type Scene,
  type SeqMessage,
  type SummaryJob,
} from "./summaries.ts";
import type { Channel, ChannelSummaries, Profile, Summary } from "./types.ts";

/** A new digest is written once this many posts have been added since the last one. */
export const DIGEST_EVERY = 8;

/** How many of the newest posts a digest is written from (besides the summaries). */
const DIGEST_RECENT = 12;

export class Summarizer {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Each channel's catch-up in progress (or the last one), so they run one after another. */
  private readonly runs = new Map<string, Promise<void>>();
  private readonly running = new Set<string>();
  private readonly errors = new Map<string, string>();

  /**
   * @param delayMs  How long to wait after a change before catching up. A
   *                 negative number never catches up on its own (only when
   *                 asked with `catchUp`): for tests.
   */
  constructor(
    private readonly store: Store,
    private readonly api: ApiOptions,
    private readonly delayMs = 4000,
  ) {
    store.onMessagesChanged = (channelId) => this.schedule(channelId);
  }

  /** Catch a channel up a little later (see `delayMs`). */
  schedule(channelId: string, delayMs = this.delayMs): void {
    if (delayMs < 0) return;
    clearTimeout(this.timers.get(channelId));
    this.timers.set(
      channelId,
      setTimeout(() => {
        this.timers.delete(channelId);
        void this.catchUp(channelId);
      }, delayMs),
    );
  }

  /** Catch every channel up (on startup, in case the server was stopped mid-way). */
  scheduleAll(delayMs = this.delayMs): void {
    for (const channel of this.store.listChannels()) this.schedule(channel.id, delayMs);
  }

  /** Stop any waiting catch-ups (when the server shuts down, and in tests). */
  stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  /**
   * Catch a channel's summaries up now, after any catch-up already running.
   * Never throws: a failure is kept, and shown with the summaries.
   */
  catchUp(channelId: string): Promise<void> {
    const previous = this.runs.get(channelId) ?? Promise.resolve();
    const run = previous.then(async () => {
      this.running.add(channelId);
      try {
        await this.work(channelId);
        this.errors.delete(channelId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.errors.set(channelId, message);
        console.warn(`[summaries] couldn't update channel ${channelId}: ${message}`);
      } finally {
        this.running.delete(channelId);
      }
    });
    this.runs.set(channelId, run);
    return run;
  }

  /** Rewrite all of a channel's summaries from its messages, your edits included. */
  rebuild(channelId: string): Promise<void> {
    this.store.summaries.rebuildAll(channelId);
    return this.catchUp(channelId);
  }

  /** A channel's summaries, as the app shows them. */
  view(channelId: string): ChannelSummaries {
    const all = this.store.summaries.all(channelId);
    const one = (kind: Summary["kind"]) => all.find((s) => s.kind === kind) ?? null;
    return {
      scenes: Object.fromEntries(all.filter((s) => s.kind === "scene").map((s) => [s.sceneId, s])),
      story: one("story"),
      current: one("current"),
      digest: one("digest"),
      running: this.running.has(channelId),
      error: this.errors.get(channelId) ?? null,
    };
  }

  // ------------------------------------------------------------ the work

  private async work(channelId: string): Promise<void> {
    const { store } = this;
    const settings = store.getSettings();
    // Off, or no API key yet (the app already says so): nothing to do.
    if (!settings.summaries || !this.api.apiKey) return;
    let channel: Channel;
    try {
      channel = store.getChannel(channelId);
    } catch {
      return; // deleted in the meantime
    }
    const messages = store.summaries.withSeq(channelId, store.getMessages(channelId));
    if (messages.length === 0) return;
    const scenes = splitScenes(messages, channel.kind);
    const profile = pickProfile(store, channel, undefined, "summary");
    const write = (job: SummaryJob, notes: string, lines: string[], heading: string) =>
      this.fold(profile, job, notes, lines, heading);
    const lines = (posts: SeqMessage[]) => transcript(posts, channel.kind, settings.partnerName);

    // 1. Finished scenes.
    const finished = scenes.filter((s): s is Scene & { end: SeqMessage } => s.end !== null && s.posts.length > 0);
    for (const scene of finished) {
      const existing = store.summaries.get(channelId, "scene", scene.end.id);
      if (existing && !(existing.stale && !existing.edited)) continue;
      // Start from the notes kept while the scene was going, if any.
      const startId = scene.start?.id ?? "";
      const current = store.summaries.get(channelId, "current", startId);
      const seed = current && !current.stale ? current : null;
      const posts = seed ? scene.posts.filter((p) => p.seq > seed.throughSeq) : scene.posts;
      const content = await write("scene", seed?.content ?? "", lines(posts), sceneHeading(scene, scenes.indexOf(scene)));
      store.summaries.save(channelId, "scene", scene.end.id, content, scene.end.seq);
      if (current) store.summaries.remove(channelId, "current", startId);
    }

    // 2. The story so far, from the scene summaries.
    const sceneSummaries = finished
      .map((scene) => ({ scene, index: scenes.indexOf(scene), summary: store.summaries.get(channelId, "scene", scene.end.id) }))
      .filter((s) => s.summary !== null);
    if (sceneSummaries.length > 0) {
      const story = store.summaries.get(channelId, "story");
      const rebuild = !story || (story.stale && !story.edited);
      const fresh = rebuild ? sceneSummaries : sceneSummaries.filter((s) => s.scene.end.seq > story!.throughSeq);
      if (fresh.length > 0) {
        const blocks = fresh.map((s) => `${sceneHeading(s.scene, s.index)}: ${s.summary!.content}`);
        const content = await write("story", rebuild ? "" : story!.content, blocks, "Summaries of the newest scenes");
        store.summaries.save(channelId, "story", "", content, fresh.at(-1)!.scene.end.seq);
      }
    }

    // 3. Earlier in the scene still going (in OOC, the conversation).
    const scene = scenes.at(-1)!;
    const sceneId = scene.start?.id ?? "";
    for (const other of store.summaries.all(channelId)) {
      // Notes left from a scene that has ended (and was summarized without them).
      if (other.kind === "current" && other.sceneId !== sceneId) store.summaries.remove(channelId, "current", other.sceneId);
    }
    let current = store.summaries.get(channelId, "current", sceneId);
    if (current?.stale && !current.edited) {
      store.summaries.remove(channelId, "current", sceneId);
      current = null;
    }
    const waiting = scene.posts.filter((p) => p.seq > (current?.throughSeq ?? 0));
    if (waiting.length >= settings.historyLimit + settings.summaryEvery) {
      const folding = waiting.slice(0, waiting.length - settings.historyLimit);
      const job = channel.kind === "ooc" ? "conversation" : "current";
      const content = await write(job, current?.content ?? "", lines(folding), "What happened next");
      store.summaries.save(channelId, "current", sceneId, content, folding.at(-1)!.seq);
    }

    // 4. The digest, if the channel has moved on.
    const posts = messages.filter((m) => m.kind === "post");
    if (posts.length === 0) return;
    const digest = store.summaries.get(channelId, "digest");
    const story = store.summaries.get(channelId, "story");
    const newPosts = posts.filter((p) => p.seq > (digest?.throughSeq ?? 0)).length;
    const due =
      !digest ||
      digest.stale ||
      newPosts >= DIGEST_EVERY ||
      (story !== null && story.updatedAt > digest.updatedAt && newPosts > 0);
    if (due) {
      const latest = sceneSummaries.at(-1)?.summary;
      const known = [
        story ? `The story so far: ${story.content}` : "",
        latest ? `The last scene: ${latest.content}` : "",
        store.summaries.get(channelId, "current", sceneId)?.content
          ? `Earlier in the current scene: ${store.summaries.get(channelId, "current", sceneId)!.content}`
          : "",
      ].filter(Boolean);
      const material = [...known, "The newest messages:", ...lines(posts.slice(-DIGEST_RECENT))];
      const job = channel.kind === "ooc" ? "ooc-digest" : "digest";
      const content = await write(job, "", material, `#${channel.name}`);
      store.summaries.save(channelId, "digest", "", content, posts.at(-1)!.seq);
    }
  }

  /**
   * Ask the model for notes on some material, in chunks if it's long: each
   * chunk is folded into the notes from the ones before.
   */
  private async fold(profile: Profile, job: SummaryJob, notes: string, lines: string[], heading: string): Promise<string> {
    let result = notes;
    for (const chunk of chunkLines(lines)) {
      const request = profileRequest(profile);
      const response = await createChatCompletion(this.api, {
        ...request,
        // Summaries want care more than flair, and room to finish.
        temperature: Math.min(request.temperature, 0.7),
        maxTokens: Math.max(request.maxTokens, 1024),
        messages: summaryRequest(job, result, chunk, heading),
      });
      result = cleanSummary(response.content);
      console.log(`[summaries] wrote a ${job} summary (${result.length} characters) with "${profile.name}"`);
    }
    return result;
  }
}

/** "Scene 3, "The Storm"" (the title is the break that started it). */
function sceneHeading(scene: Scene, index: number): string {
  const title = scene.start?.content;
  return `Scene ${index + 1}${title ? `, "${title}"` : ""}`;
}
