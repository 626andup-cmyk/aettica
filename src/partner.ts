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
 *   - an event like opening the app (stage 8)
 *   - a timer, the "heartbeat"      (endgame)
 *
 * The turn itself only ever looks at what's already saved: it reads the
 * channel, builds the prompt stack, asks the model, and saves the reply. It
 * never receives your message as an argument. That's what keeps proactive
 * turns an add-on instead of a rewrite later.
 */

import type { ApiOptions } from "./nanogpt.ts";
import { CancelledError, createChatCompletion } from "./nanogpt.ts";
import { replyToMessages } from "./posts.ts";
import { buildPromptStack } from "./prompt.ts";
import type { Store } from "./store.ts";
import type { ChatMessage, Message } from "./types.ts";

/**
 * What caused a turn. Stage 1 only uses this for the server log, but it's
 * where the stage 8 event triggers ("app-opened", "scene-ended", ...) will go.
 */
export type TurnTrigger = "user-message" | "continue" | "regenerate";

/** Extra options for a turn. */
export interface TurnOptions {
  /**
   * Ids of existing partner messages this turn replaces (a regeneration:
   * one literary post, or every bubble of a casual reply). They're left out
   * of the prompt, as if never written, and deleted only once the new reply
   * has been saved. If generation fails, they stay.
   */
  replacing?: string[];
}

/** Thrown when a turn is requested in a channel where one is still being written. */
export class BusyError extends Error {
  constructor() {
    super("Your partner is already writing in this channel. Wait for that reply first.");
    this.name = "BusyError";
  }
}

/**
 * Build the prompt stack for a channel from what's saved.
 *
 * Used by the turn itself and by the "Preview prompt" button, so the preview
 * is always exactly what a turn would send.
 *
 * @param excludeIds  Messages to leave out (the ones being regenerated).
 */
export function promptForChannel(store: Store, channelId: string, excludeIds: string[] = []): ChatMessage[] {
  const excluded = new Set(excludeIds);
  const channel = store.getChannel(channelId);
  const channels = store.listChannels();
  return buildPromptStack({
    settings: store.getSettings(),
    channel,
    channels,
    messages: store.getMessages(channelId).filter((m) => !excluded.has(m.id)),
    // Everything from the notebook is as *your partner* may see it: entries
    // hidden from them never reach the prompt.
    notebook: channel.kind === "rp" ? store.notebook.forPrompt(channelId) : undefined,
    overview:
      channel.kind === "ooc"
        ? {
            castNames: Object.fromEntries(channels.map((c) => [c.id, partnerCharacterNames(store, c.id)])),
            entries: store.notebook.partnerOverview(),
          }
        : undefined,
  });
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
   * The request to the model is abandoned and nothing is saved, so the
   * channel is left as it was before the turn. The channel is free again as
   * soon as this returns.
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
   * Your partner takes one turn in a channel: reads it, writes a reply,
   * saves it.
   *
   * @param channelId  Where to write.
   * @param trigger    Why the turn is happening (for logging).
   * @param options    See `TurnOptions`.
   * @returns          The partner's new message(s), as saved: one, or
   *                   several bubbles in a casual scene.
   * @throws NotFoundError if the channel doesn't exist.
   * @throws BusyError     if a turn is already running in that channel.
   * @throws CancelledError if the turn was stopped with `cancel`.
   * @throws ApiError      if the model couldn't produce a reply.
   *                       In both of those cases nothing is saved, so the
   *                       channel is unchanged.
   */
  async takeTurn(channelId: string, trigger: TurnTrigger, options: TurnOptions = {}): Promise<Message[]> {
    if (this.writingIn.has(channelId)) throw new BusyError();
    const channel = this.store.getChannel(channelId); // throws if missing

    const controller = new AbortController();
    this.writingIn.set(channelId, controller);
    try {
      const settings = this.store.getSettings();
      const messages = promptForChannel(this.store, channelId, options.replacing);

      const started = Date.now();
      console.log(`[partner] turn started in #${channel.name} (${trigger}) using ${settings.model}`);

      const result = await createChatCompletion(this.api, {
        model: settings.model,
        messages,
        temperature: settings.temperature,
        maxTokens: settings.maxTokens,
        signal: controller.signal,
      });

      // Belt and braces: if the turn was stopped just as the reply arrived,
      // don't save it.
      if (controller.signal.aborted) throw new CancelledError();

      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      console.log(`[partner] turn finished in ${seconds}s (finish reason: ${result.finishReason ?? "unknown"})`);

      // Re-read the channel: its character may have been renamed while the
      // model was writing, and the messages should carry the current name.
      const current = this.store.getChannel(channelId);
      // Record the model we *asked* for rather than the one the API reports,
      // because that's the id you'd put back in settings to get it again.
      const newMessages = replyToMessages(
        current,
        result.content,
        settings.model,
        partnerCharacterNames(this.store, channelId).map((name) => ({ name })),
      );

      // Swap old for new in one transaction: never both, never neither.
      return this.store.db.transaction(() => {
        for (const id of options.replacing ?? []) this.store.deleteMessage(id);
        return this.store.addTurn(newMessages);
      })();
    } finally {
      // Always release the lock, even if generation failed. Otherwise one
      // network error would leave the channel "busy" forever. (Only if it's
      // still *this* turn's lock: after a Stop, a new turn may already have
      // started in the channel.)
      if (this.writingIn.get(channelId) === controller) this.writingIn.delete(channelId);
    }
  }
}
