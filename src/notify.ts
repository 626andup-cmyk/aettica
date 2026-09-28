/**
 * Phone notifications, through Termux (borrowed from Kitsikai).
 *
 * When your partner writes on their own (a wake-up or the heartbeat) and
 * the app isn't on screen, you should still find out. The server runs
 * Termux:API's `termux-notification`, titled "Arlo in #ooc" with the message
 * as the text; tapping it opens the app at that channel:
 *
 *   termux-notification --title "Arlo in #ooc" --content "I had an idea…"
 *                       --action "termux-open-url 'http://127.0.0.1:4747/#/channel/…'"
 *
 * The server also takes a **wake lock** (`termux-wake-lock`) when the
 * heartbeat is on, so the phone doesn't put it to sleep (exempt Termux from
 * battery optimization too; see the README).
 *
 * **When**: only when the app isn't on screen. The app tells the server
 * whether it's visible (POST /api/presence) when that changes, and every 15
 * seconds while it is; no word for a minute means it isn't.
 *
 * On a computer (no Termux), there's nothing to run, so notifications are
 * quietly off, and Settings says so.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

export interface Notification {
  title: string;
  text: string;
  /** The channel to open when it's tapped. */
  channelId: string;
  /** Whose channel it is (src/hub.ts), so the app opens the right partner. */
  partnerId?: string;
}

/** Something that can post notifications. Tests use a fake one. */
export interface Notifier {
  available(): boolean;
  notify(notification: Notification): void;
}

const MAX_TEXT = 500;
const TERMUX_BIN = "/data/data/com.termux/files/usr/bin";

/** Where a command is, or `null` (Termux's own folder is checked too, for proot). */
function find(command: string): string | null {
  const path = `${TERMUX_BIN}/${command}`;
  return Bun.which(command) ?? (existsSync(path) ? path : null);
}

function run(command: string, args: string[]): void {
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", (error) => console.warn(`[notify] ${command} failed: ${error.message}`));
    child.unref();
  } catch (error) {
    console.warn(`[notify] ${command} failed: ${(error as Error).message}`);
  }
}

/** Notifications through Termux:API. */
export class TermuxNotifier implements Notifier {
  /** @param appUrl  Where the app is, like http://127.0.0.1:4747, for tapping a notification. */
  constructor(private readonly appUrl: string) {}

  available(): boolean {
    return find("termux-notification") !== null;
  }

  notify({ title, text, channelId, partnerId }: Notification): void {
    const command = find("termux-notification");
    if (!command) return;
    const partner = partnerId ? `/p/${encodeURIComponent(partnerId)}` : "";
    const url = `${this.appUrl}/#${partner}/channel/${encodeURIComponent(channelId)}`;
    run(command, [
      "--title",
      title,
      "--content",
      text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text,
      // One per channel: a newer message replaces the older one.
      "--id",
      `aettica-${channelId}`,
      "--group",
      "aettica",
      // The URL is ours (a channel id is letters, digits and dashes), so
      // quoting it keeps the shell from reading it as anything else.
      "--action",
      `termux-open-url '${url}'`,
    ]);
  }
}

/** Keep the phone from putting the server to sleep, if Termux can. */
export function keepAwake(): void {
  const command = find("termux-wake-lock");
  if (command) run(command, []);
}

/** How long the app counts as on screen after it last said so (ms). */
export const PRESENCE_TIMEOUT_MS = 60_000;

/** Whether the app is on screen, as it last reported. */
export class Presence {
  /** When the app last said it's on screen; `null` once it says it isn't. */
  private visibleAt: number | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  set(visible: boolean): void {
    this.visibleAt = visible ? this.now() : null;
  }

  isVisible(): boolean {
    return this.visibleAt !== null && this.now() - this.visibleAt < PRESENCE_TIMEOUT_MS;
  }
}
