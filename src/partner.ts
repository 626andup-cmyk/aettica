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
 * The turn itself only ever looks at what's already saved: it reads the chat,
 * builds the prompt stack, asks the model, and saves the reply. It never
 * receives your message as an argument. That's what keeps proactive turns an
 * add-on instead of a rewrite later.
 */

import type { ApiOptions } from "./nanogpt.ts";
import { createChatCompletion } from "./nanogpt.ts";
import { buildPromptStack } from "./prompt.ts";
import type { Store } from "./store.ts";
import type { Message } from "./types.ts";

/**
 * What caused a turn. Stage 1 only uses this for the server log, but it's
 * where the stage 8 event triggers ("app-opened", "scene-ended", ...) will go.
 */
export type TurnTrigger = "user-message" | "continue" | "regenerate";

/** Extra options for a turn. */
export interface TurnOptions {
  /**
   * Id of an existing partner message this turn replaces (a regeneration).
   * That message is left out of the prompt, as if it had never been written,
   * and is deleted only once the new reply has been saved. If generation
   * fails, the old message stays.
   */
  replacing?: string;
}

/** Thrown when a turn is requested while another one is still being written. */
export class BusyError extends Error {
  constructor() {
    super("Your partner is already writing. Wait for that reply first.");
    this.name = "BusyError";
  }
}

export class Partner {
  /**
   * True while a reply is being generated.
   *
   * Only one turn may run at a time. Without this, tapping Send twice would
   * start two generations that both read the same chat and both save a reply,
   * and your partner would answer the same post twice.
   */
  private writing = false;

  constructor(
    private readonly store: Store,
    private readonly api: ApiOptions,
  ) {}

  /** Whether a turn is in progress right now. */
  get busy(): boolean {
    return this.writing;
  }

  /**
   * Your partner takes one turn: reads the chat, writes a reply, saves it.
   *
   * @param trigger  Why the turn is happening (for logging).
   * @param options  See `TurnOptions`.
   * @returns        The partner's new message, as saved.
   * @throws BusyError if a turn is already running.
   * @throws ApiError  if the model couldn't produce a reply. Nothing is saved
   *                   in that case, so the chat is left exactly as it was.
   */
  async takeTurn(trigger: TurnTrigger, options: TurnOptions = {}): Promise<Message> {
    if (this.writing) throw new BusyError();
    this.writing = true;

    try {
      const settings = this.store.getSettings();
      const history = this.store.getMessages().filter((m) => m.id !== options.replacing);
      const messages = buildPromptStack(settings, history);

      const started = Date.now();
      console.log(`[partner] turn started (${trigger}) using ${settings.model}`);

      const result = await createChatCompletion(this.api, {
        model: settings.model,
        messages,
        temperature: settings.temperature,
        maxTokens: settings.maxTokens,
      });

      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      console.log(`[partner] turn finished in ${seconds}s (finish reason: ${result.finishReason ?? "unknown"})`);

      if (options.replacing) this.store.deleteMessage(options.replacing);

      // Record the model we *asked* for rather than the one the API reports,
      // because that's the id you'd put back in settings to get it again.
      return this.store.addMessage("partner", result.content, settings.model);
    } finally {
      // Always release the lock, even if generation failed. Otherwise one
      // network error would leave the partner "busy" forever.
      this.writing = false;
    }
  }
}
