/**
 * The partner's turn: the single place where your partner writes something.
 *
 * The design doc's core rule is that *a partner turn never requires a user
 * message*. There is one "partner takes a turn" function, and anything can
 * call it:
 *
 *   - you sending a message         (stage 1)
 *   - you pressing "Partner's turn" (stage 1)
 *   - you asking for a regeneration (stage 1)
 *   - you commenting on their post  (stage 6: they reply in the thread)
 *   - an event like opening the app (stage 8)
 *   - a timer, the "heartbeat"      (endgame)
 *
 * The turn itself only ever looks at what's already saved: it reads the
 * channel, builds the prompt stack, asks the model, and saves the reply. It
 * never receives your message as an argument. That's what keeps proactive
 * turns an add-on instead of a rewrite later.
 *
 * ## Tools (stage 6)
 *
 * If the turn's connection profile can use tools, the model is offered them
 * (src/tools.ts), and a turn becomes a small loop:
 *
 *   1. Ask the model. It replies with text, tool calls, or both.
 *   2. If it called tools, run each one (as your partner, with every
 *      permission applied), log it, and send the results back.
 *   3. Repeat, up to `MAX_ROUNDS` times, until it replies without calling
 *      anything. Its text is the post.
 *
 * Tool calls written out in the reply's text instead of the API's field
 * (some models do this) are found and run too (src/toolcalls.ts). Every
 * call, and every mistake, goes into the tool log, which the app shows.
 *
 * Actions take effect as they happen. If a turn is stopped or fails after
 * a tool ran, the action stays done; the log shows it.
 */

import { CancelledError, createChatCompletion, type ApiOptions, type ToolSpec } from "./nanogpt.ts";
import { replyToMessages } from "./posts.ts";
import { parseExtraParams } from "./profiles.ts";
import { buildPromptStack, type PromptMemory, type PromptReview, type PromptThread } from "./prompt.ts";
import { channelSummaryText, splitScenes, windowStart, type SeqMessage } from "./summaries.ts";
import type { Store } from "./store.ts";
import { extractTextToolCalls, parseArguments, type ParsedCall } from "./toolcalls.ts";
import { runTool, toolSpecs, type ToolContext, type ToolOutcome } from "./tools.ts";
import type { ApiMessage, ApiToolCall, Channel, ChatMessage, CommentThread, Message, Profile, ToolCallRecord } from "./types.ts";

/** The most rounds of tool calls in one turn. The last round is offered no tools, so it has to write. */
export const MAX_ROUNDS = 6;

/**
 * What caused a turn. Used for the server log, and where the stage 8 event
 * triggers ("app-opened", "scene-ended", ...) will go.
 */
export type TurnTrigger = "user-message" | "continue" | "regenerate" | "comment";

/** Extra options for a turn. */
export interface TurnOptions {
  /**
   * Ids of existing partner messages this turn replaces (a regeneration:
   * one literary post, or every bubble of a casual reply). They're left out
   * of the prompt, as if never written, and deleted only once the new reply
   * has been saved. If generation fails, or writes nothing, they stay.
   */
  replacing?: string[];
  /**
   * Write with this connection profile instead of picking one from the
   * channel's assignment ("Regenerate with...").
   */
  profileId?: string;
}

/** Everything one turn produced. */
export interface TurnResult {
  /** The new message(s): one post, several casual bubbles, or none. */
  messages: Message[];
  /** Every tool call made during the turn, in order. */
  toolCalls: ToolCallRecord[];
  /** The messages that were replaced (a regeneration that wrote something). */
  replaced: string[];
  /** Your partner chose not to write (do_nothing, or nothing to say after acting). */
  skipped: boolean;
  /** For a reply to a comment: the thread, with the reply in it. */
  thread?: CommentThread;
}

/** Thrown when a turn is requested in a channel where one is still being written. */
export class BusyError extends Error {
  constructor() {
    super("Your partner is already writing in this channel. Wait for that reply first.");
    this.name = "BusyError";
  }
}

/**
 * The connection profile for one turn in a channel: the channel's own
 * assignment if it has one, otherwise the server-wide one for its kind.
 * A roulette picks at random each time (pass `random` to choose).
 *
 * OOC chat is an agentic job, so its roulettes prefer tool-capable profiles.
 */
export function pickProfile(store: Store, channel: Channel, random?: number, job: "turn" | "summary" = "turn"): Profile {
  const settings = store.getSettings();
  // Summaries (stage 7) have their own assignment, or use roleplay's.
  if (job === "summary") return store.profiles.pick(settings.summaryAssignment || settings.rpAssignment, false, random);
  const assignment = channel.assignment ?? (channel.kind === "ooc" ? settings.oocAssignment : settings.rpAssignment);
  return store.profiles.pick(assignment, channel.kind === "ooc", random);
}

/** Options for building a channel's prompt. */
export interface PromptOptions {
  /** Messages to leave out (the ones being regenerated). */
  excludeIds?: string[];
  /** The profile writing: its model notes (layer 4), and whether tools are offered. */
  profile?: Profile;
  /** A comment thread your partner is replying to. */
  replyingTo?: string;
}

/**
 * Build the prompt stack for a channel from what's saved.
 *
 * Used by the turn itself and by the "Preview prompt" button, so the preview
 * is always exactly what a turn would send.
 */
export function promptForChannel(store: Store, channelId: string, options: PromptOptions = {}): ChatMessage[] {
  const excluded = new Set(options.excludeIds ?? []);
  const channel = store.getChannel(channelId);
  const channels = store.listChannels();
  const settings = store.getSettings();
  const messages = store.getMessages(channelId).filter((m) => !excluded.has(m.id));
  const byId = new Map(messages.map((m) => [m.id, m]));

  // Everything from the notebook is as *your partner* may see it: entries
  // hidden from them never reach the prompt.
  const notebook = channel.kind === "rp" ? store.notebook.forPrompt(channelId) : undefined;

  // Which messages are sent in full, and the summaries of those before
  // them (stage 7).
  const seqMessages = store.summaries.withSeq(channelId, messages);
  const current = store.summaries.all(channelId).find((s) => s.kind === "current") ?? null;
  const start = windowStart(seqMessages, channel.kind, {
    historyLimit: settings.historyLimit,
    summaryEvery: settings.summaryEvery,
    enabled: settings.summaries,
    current,
  });
  const memory = settings.summaries ? memoryFor(store, channel, seqMessages, start) : undefined;

  // Notes you attached to messages still in the conversation, unless
  // they're already in the prompt as the cast, lore or linked notes.
  const inPrompt = new Set([...(notebook?.pinned ?? []), ...(notebook?.linked ?? [])].map((p) => p.entry.id));
  const window = messages.slice(start);
  const attached = store.notebook
    .forPromptEntries(window.flatMap((m) => m.attachments))
    .filter((p) => !inPrompt.has(p.entry.id));

  const tools = options.profile?.supportsTools ?? false;
  const replying = options.replyingTo ? store.comments.thread(options.replyingTo) : undefined;

  return buildPromptStack({
    settings,
    channel,
    channels,
    messages,
    windowStart: start,
    memory,
    digests: channel.kind === "ooc" && settings.summaries ? digestsFor(store, channels) : undefined,
    mentioned: channel.kind === "ooc" && settings.summaries ? mentionedChannels(store, channel, channels, window) : undefined,
    notebook,
    overview:
      channel.kind === "ooc"
        ? {
            castNames: Object.fromEntries(channels.map((c) => [c.id, partnerCharacterNames(store, c.id)])),
            entries: store.notebook.partnerOverview(),
          }
        : undefined,
    modelNotes: options.profile?.quirkPrompt,
    attached,
    threads: openThreads(store, channelId, byId, replying?.id),
    reviews: tools ? reviewsFor(store) : [],
    recentActions: recentActions(store, channelId),
    tools,
    replyingTo: replying
      ? {
          threadId: replying.id,
          quote: replying.quote,
          note: replying.comments.at(-1)?.note ?? "",
          onYourMessage: byId.get(replying.messageId)?.author === "partner",
        }
      : undefined,
  });
}

/** How many finished scenes' summaries are sent in full (besides the story so far). */
export const RECENT_SCENES = 2;

/**
 * Layer 5's summaries for a channel whose prompt starts at `start`: only
 * what covers messages that aren't sent in full.
 *
 * - The story so far, if anything before the recent messages is missing.
 * - The last `RECENT_SCENES` finished scenes that aren't all in the
 *   recent messages.
 * - What happened earlier in the current scene (or OOC conversation), if
 *   its oldest messages were folded into a summary.
 */
export function memoryFor(store: Store, channel: Channel, messages: SeqMessage[], start: number): PromptMemory {
  if (start === 0) return {};
  const scenes = splitScenes(messages, channel.kind);
  const firstSent = messages[start]?.seq ?? Infinity;
  const memory: PromptMemory = {};

  const story = store.summaries.get(channel.id, "story");
  if (story?.content) memory.story = story.content;

  memory.scenes = scenes
    .map((scene, index) => ({ scene, index }))
    // Finished scenes with at least some of their messages not sent in full.
    .filter(({ scene }) => scene.end && (scene.posts[0]?.seq ?? Infinity) < firstSent)
    .map(({ scene, index }) => ({ index, title: scene.start?.content, summary: store.summaries.get(channel.id, "scene", scene.end!.id) }))
    .filter((s) => s.summary?.content)
    .slice(-RECENT_SCENES)
    .map((s) => ({ heading: `Scene ${s.index + 1}${s.title ? `, "${s.title}"` : ""}`, summary: s.summary!.content }));

  const scene = scenes.at(-1)!;
  const current = store.summaries.get(channel.id, "current", scene.start?.id ?? "");
  if (current?.content && !current.stale && current.throughSeq < firstSent) memory.earlier = current.content;
  return memory;
}

/** Every channel's digest, by channel id (for OOC's overview). */
function digestsFor(store: Store, channels: Channel[]): Record<string, string> {
  const digests: Record<string, string> = {};
  for (const channel of channels) {
    const digest = store.summaries.get(channel.id, "digest");
    if (digest?.content) digests[channel.id] = digest.content;
  }
  return digests;
}

/** How many of the newest OOC messages are checked for channels that come up. */
const MENTION_WINDOW = 6;

/**
 * Channels that came up in the last few OOC messages (by `#name`, or by
 * name as a word), with their fuller summary: the story so far, the last
 * scene, and what's happened in the scene still going. At most two.
 */
export function mentionedChannels(store: Store, ooc: Channel, channels: Channel[], window: Message[]): { name: string; summary: string }[] {
  const text = window
    .filter((m) => m.kind === "post")
    .slice(-MENTION_WINDOW)
    .map((m) => m.content.toLowerCase())
    .join("\n");
  const escape = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found: { name: string; summary: string }[] = [];
  for (const channel of channels) {
    if (channel.id === ooc.id || found.length >= 2) continue;
    const name = channel.name.toLowerCase();
    const named =
      text.includes(`#${name}`) || (name.length >= 3 && new RegExp(`(^|[^\\w])${escape(name)}($|[^\\w])`).test(text));
    if (!named) continue;
    // (Its digest is already in the list of channels.)
    const summary = channelSummaryText(store, channel, { withDigest: false });
    if (summary) found.push({ name: channel.name, summary });
  }
  return found;
}

/** Unresolved threads on this channel's messages, newest ten, plus the one being replied to. */
function openThreads(store: Store, channelId: string, byId: Map<string, Message>, replyingTo?: string): PromptThread[] {
  return store.comments
    .forChannel(channelId)
    .filter((t) => (!t.resolved || t.id === replyingTo) && byId.has(t.messageId))
    .slice(-10)
    .map((t) => ({
      id: t.id,
      quote: t.quote,
      onYourMessage: byId.get(t.messageId)!.author === "partner",
      comments: t.comments.map((c) => ({ author: c.author, note: c.note })),
    }));
}

/** Suggestions waiting for your partner, described. */
function reviewsFor(store: Store): PromptReview[] {
  return store.notebook.waitingFor("partner").flatMap((suggestion) => {
    const entry = store.notebook.listEntries("partner").find((e) => e.id === suggestion.entryId);
    if (!entry) return [];
    const change = suggestion.change;
    const parts: string[] = [];
    if (change.delete) parts.push("delete it");
    if (change.name !== undefined) parts.push(`rename it to "${change.name}"`);
    if (change.fields !== undefined) {
      const before = new Map(entry.fields.map((f) => [f.label, f.value]));
      const after = new Map(change.fields.map((f) => [f.label, f.value]));
      const changed = [...new Set([...before.keys(), ...after.keys()])].filter((l) => before.get(l) !== after.get(l));
      parts.push(
        ...changed.map((label) =>
          after.has(label) ? `set ${label} to "${after.get(label)}"` : `remove ${label}`,
        ),
      );
    }
    if (change.systemPrompt !== undefined) parts.push(`change its notes to "${change.systemPrompt}"`);
    return [{ id: suggestion.id, entry: entry.name, description: parts.join("; ") || "a change" }];
  });
}

/** Tool actions that changed something (not reading), newest last, plus how proposals went. */
function recentActions(store: Store, channelId: string): string[] {
  const quiet = new Set(["read_notebook_entry", "search_notebook", "do_nothing"]);
  const actions = store.toolLog
    .forChannel(channelId, 60)
    .filter((call) => call.status === "ok" && !quiet.has(call.name))
    .slice(-8)
    .map((call) => `${call.summary} (${ago(call.createdAt)})`);
  const proposals = [
    ...store.proposals.pending().map((p) => `You proposed deleting #${p.targetName}; the user hasn't decided yet.`),
    ...store.proposals
      .recentlyResolved(3)
      .map((p) => `The user ${p.status === "approved" ? "approved" : "denied"} your proposal to delete #${p.targetName}.`),
  ];
  return [...actions, ...proposals];
}

/** "5 minutes ago", "2 hours ago", "3 days ago". */
function ago(iso: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/**
 * The characters your partner plays in a channel's cast (their own and
 * shared ones they can see), in cast order.
 */
export function partnerCharacterNames(store: Store, channelId: string): string[] {
  return store.notebook
    .forPrompt(channelId)
    .pinned.filter((p) => p.entry.kind === "character" && p.entry.owner !== "user")
    .map((p) => p.entry.name);
}

/** The request settings a profile locks in (everything but the messages). */
export function profileRequest(profile: Profile) {
  return {
    model: profile.model,
    temperature: profile.temperature,
    maxTokens: profile.maxTokens,
    topP: profile.topP,
    reasoningEffort: profile.reasoningEffort,
    extraParams: parseExtraParams(profile.extraParams),
  };
}

export class Partner {
  /**
   * The channels the partner is writing in right now, each with the
   * controller that can stop that turn (see `cancel`).
   *
   * Only one turn may run per channel at a time. Without this, tapping Send
   * twice would start two generations that both read the same channel and
   * both save a reply, and your partner would answer the same post twice.
   * Different channels don't block each other.
   */
  private readonly writingIn = new Map<string, AbortController>();

  constructor(
    private readonly store: Store,
    private readonly api: ApiOptions,
  ) {}

  /** Whether a turn is in progress in a channel. */
  isBusy(channelId: string): boolean {
    return this.writingIn.has(channelId);
  }

  /** Every channel with a turn in progress. */
  busyChannels(): string[] {
    return [...this.writingIn.keys()];
  }

  /**
   * Stop the turn running in a channel, if there is one (the Stop button).
   *
   * The request to the model is abandoned and nothing more is saved, so the
   * channel is left as it was, apart from any tool actions already taken.
   * The channel is free again as soon as this returns.
   *
   * @returns `true` if a turn was stopped, `false` if none was running.
   */
  cancel(channelId: string): boolean {
    const controller = this.writingIn.get(channelId);
    if (!controller) return false;
    controller.abort();
    // Free the channel right away rather than waiting for the aborted
    // request to wind down.
    this.writingIn.delete(channelId);
    console.log(`[partner] turn stopped in channel ${channelId}`);
    return true;
  }

  /**
   * Your partner takes one turn in a channel: reads it, acts if they want
   * to, writes a reply, saves it.
   *
   * @throws NotFoundError  if the channel doesn't exist.
   * @throws BusyError      if a turn is already running in that channel.
   * @throws CancelledError if the turn was stopped with `cancel`.
   * @throws ApiError       if the model couldn't produce a reply.
   *                        In those cases no message is saved.
   */
  takeTurn(channelId: string, trigger: TurnTrigger, options: TurnOptions = {}): Promise<TurnResult> {
    return this.run(channelId, trigger, options);
  }

  /**
   * Your partner replies to a comment thread (after you comment). The reply
   * goes in the thread, never into the channel as a post.
   */
  replyToComment(threadId: string): Promise<TurnResult> {
    const thread = this.store.comments.thread(threadId);
    const channelId = this.store.getMessage(thread.messageId).channelId;
    return this.run(channelId, "comment", {}, threadId);
  }

  private async run(channelId: string, trigger: TurnTrigger, options: TurnOptions, replyingTo?: string): Promise<TurnResult> {
    if (this.writingIn.has(channelId)) throw new BusyError();
    const channel = this.store.getChannel(channelId); // throws if missing

    const controller = new AbortController();
    this.writingIn.set(channelId, controller);
    try {
      const profile = options.profileId ? this.store.profiles.get(options.profileId) : pickProfile(this.store, channel);
      const conversation: ApiMessage[] = promptForChannel(this.store, channelId, {
        excludeIds: options.replacing,
        profile,
        replyingTo,
      });
      const context: ToolContext = { store: this.store, channel, mode: replyingTo ? "comment" : "post" };
      const tools = profile.supportsTools ? toolSpecs(context) : [];
      const turnId = crypto.randomUUID();

      const started = Date.now();
      console.log(
        `[partner] turn started in #${channel.name} (${trigger}) using "${profile.name}" (${profile.model})` +
          (tools.length ? `, ${tools.length} tools` : ""),
      );

      const loop = await this.toolLoop({ conversation, tools, context, profile, turnId, signal: controller.signal });

      // Belt and braces: if the turn was stopped just as the reply arrived,
      // don't save it.
      if (controller.signal.aborted) throw new CancelledError();
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      console.log(
        `[partner] turn finished in ${seconds}s after ${loop.rounds} round(s), ${loop.toolCalls.length} tool call(s)` +
          (loop.content ? "" : ", no text"),
      );

      const result: TurnResult = { messages: [], toolCalls: loop.toolCalls, replaced: [], skipped: false };
      if (loop.stopped || loop.content === "") {
        // Nothing to write: your partner chose not to, or only acted. A
        // regeneration keeps the reply it would have replaced.
        result.skipped = true;
        return result;
      }

      if (replyingTo) {
        result.thread = this.store.comments.reply("partner", replyingTo, loop.content);
        return result;
      }

      // Re-read the channel: its cast or mode may have changed while the
      // model was writing (possibly through its own tools).
      const current = this.store.getChannel(channelId);
      const newMessages = replyToMessages(
        current,
        loop.content,
        profile.model,
        partnerCharacterNames(this.store, channelId).map((name) => ({ name })),
      ).map((m) => ({ ...m, profile: profile.name }));

      // Swap old for new in one transaction: never both, never neither.
      result.messages = this.store.db.transaction(() => {
        for (const id of options.replacing ?? []) this.store.deleteMessage(id);
        return this.store.addTurn(newMessages, turnId);
      })();
      result.replaced = options.replacing ?? [];
      return result;
    } finally {
      // Always release the lock, even if generation failed. Otherwise one
      // network error would leave the channel "busy" forever. (Only if it's
      // still *this* turn's lock: after a Stop, a new turn may already have
      // started in the channel.)
      if (this.writingIn.get(channelId) === controller) this.writingIn.delete(channelId);
    }
  }

  /**
   * Ask the model, run any tools it calls, send back the results, and
   * repeat until it writes without calling anything (see the top of this
   * file).
   *
   * @returns The text to post (possibly ""), the calls made, and whether
   *          your partner chose to do nothing.
   */
  private async toolLoop(turn: {
    conversation: ApiMessage[];
    tools: ToolSpec[];
    context: ToolContext;
    profile: Profile;
    turnId: string;
    signal: AbortSignal;
  }): Promise<{ content: string; toolCalls: ToolCallRecord[]; stopped: boolean; rounds: number }> {
    const { conversation, tools, context, profile, turnId, signal } = turn;
    const toolCalls: ToolCallRecord[] = [];
    let content = "";

    for (let round = 0; round < MAX_ROUNDS; round++) {
      if (signal.aborted) throw new CancelledError();
      // The last round offers no tools, so the model has to write.
      const offered = round < MAX_ROUNDS - 1 ? tools : [];
      const response = await createChatCompletion(this.api, {
        ...profileRequest(profile),
        messages: conversation,
        tools: offered,
        // After acting, the model may have nothing more to say.
        allowEmpty: round > 0,
        signal,
      });

      // Tool calls from the API, or failing that, written in the text.
      let calls: ParsedCall[] = response.toolCalls.map((c) => ({ ...c, source: "native" as const }));
      let text = response.content;
      if (calls.length === 0 && tools.length > 0) {
        const found = extractTextToolCalls(text);
        calls = found.calls;
        text = found.content;
      }
      if (text.trim() !== "") content = text.trim();
      if (calls.length === 0) return { content, toolCalls, stopped: false, rounds: round + 1 };

      // Record the model's request in the conversation, then each result.
      const native = calls.every((c) => c.source === "native");
      if (native) {
        const apiCalls: ApiToolCall[] = calls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: c.arguments },
        }));
        conversation.push({ role: "assistant", content: response.content || null, tool_calls: apiCalls });
      } else {
        conversation.push({ role: "assistant", content: response.content });
      }

      let stopped = false;
      const textResults: string[] = [];
      for (const call of calls) {
        const outcome =
          offered.length === 0
            ? failed("You're out of tool rounds for this turn, so this wasn't run. Write your reply now.")
            : this.runCall(context, call);
        toolCalls.push(
          this.store.toolLog.add({
            channelId: context.channel.id,
            turnId,
            round,
            name: call.name,
            arguments: call.arguments,
            result: JSON.stringify(outcome.result),
            status: outcome.ok ? "ok" : "error",
            summary: outcome.summary,
            source: call.source,
            profile: profile.name,
          }),
        );
        console.log(
          `[tools] #${context.channel.name} round ${round + 1} (${call.source}): ${call.name} ${call.arguments.slice(0, 200)}` +
            ` -> ${outcome.ok ? "ok" : "error"}: ${outcome.summary}`,
        );
        if (native) conversation.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(outcome.result) });
        else textResults.push(`${call.name}: ${JSON.stringify(outcome.result)}`);
        if (outcome.stop) stopped = true;
      }
      if (!native) conversation.push({ role: "user", content: `(Tool results)\n${textResults.join("\n")}` });

      if (stopped) return { content: "", toolCalls, stopped: true, rounds: round + 1 };
      // The last round ran nothing; whatever text it had is the reply.
      if (offered.length === 0) return { content, toolCalls, stopped: false, rounds: round + 1 };
    }
    return { content, toolCalls, stopped: false, rounds: MAX_ROUNDS };
  }

  /** Parse one call's arguments and run it. */
  private runCall(context: ToolContext, call: ParsedCall): ToolOutcome {
    const args = parseArguments(call.arguments);
    if (!args.ok) return failed(`${args.error} Call ${call.name} again with valid JSON arguments.`);
    return runTool(context, call.name, args.value);
  }
}

function failed(message: string): ToolOutcome {
  return { ok: false, result: { error: message }, summary: message };
}

/** The outcome of testing whether a profile's model can call tools. */
export interface ToolTestResult {
  /**
   * `native`: it called the tool through the API, the best case.
   * `text`: it wrote the call out in its reply, which works, but less reliably.
   * `none`: it didn't call the tool at all.
   * `broken`: it called it, but the arguments couldn't be read.
   */
  verdict: "native" | "text" | "none" | "broken";
  /** A sentence explaining the verdict. */
  detail: string;
  /** What the model wrote, if anything. */
  content: string;
  /** The call's arguments, as written. */
  arguments: string | null;
  seconds: number;
}

/**
 * Check whether a profile's model can call tools, with one tiny request:
 * the model is asked to call a `check_in` tool with a given word.
 * Throws `ApiError` if the request itself fails.
 */
export async function testToolCalling(api: ApiOptions, profile: Profile): Promise<ToolTestResult> {
  const spec: ToolSpec = {
    type: "function",
    function: {
      name: "check_in",
      description: "Check in, with a word.",
      parameters: {
        type: "object",
        properties: { word: { type: "string", description: "The word to check in with." } },
        required: ["word"],
      },
    },
  };
  const started = Date.now();
  const response = await createChatCompletion(api, {
    ...profileRequest(profile),
    messages: [
      { role: "system", content: "This is a test of tool calling. Call the check_in tool with the word \"lighthouse\". Write nothing else." },
      { role: "user", content: "Call check_in now, please." },
    ],
    tools: [spec],
    allowEmpty: true,
  });
  const seconds = Math.round((Date.now() - started) / 100) / 10;

  const native = response.toolCalls.find((c) => c.name === "check_in");
  const written = native ? undefined : extractTextToolCalls(response.content).calls.find((c) => c.name === "check_in");
  const call = native ?? written;
  if (!call) {
    return {
      verdict: "none",
      detail: "The model didn't call the tool. Turn off \"Can use tools\" for this profile, or try another model.",
      content: response.content,
      arguments: null,
      seconds,
    };
  }
  const args = parseArguments(call.arguments);
  if (!args.ok || typeof args.value.word !== "string") {
    return {
      verdict: "broken",
      detail: `The model called the tool, but its arguments couldn't be read${args.ok ? "" : `: ${args.error}`}`,
      content: response.content,
      arguments: call.arguments,
      seconds,
    };
  }
  return native
    ? {
        verdict: "native",
        detail: "The model called the tool properly, through the API. Tools should work well.",
        content: response.content,
        arguments: call.arguments,
        seconds,
      }
    : {
        verdict: "text",
        detail: "The model wrote the tool call into its reply instead of using the API. Aettica can read it, but it may be less reliable.",
        content: response.content,
        arguments: call.arguments,
        seconds,
      };
}
