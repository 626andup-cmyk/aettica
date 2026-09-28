/**
 * The idea drawer: ideas your partner had on a heartbeat (src/heartbeat.ts),
 * kept whether or not they were shared.
 *
 * - **shared**: your partner brought it up with you.
 * - **drawer**: good, but not the moment (or not exciting enough yet). Kept
 *   privately, and offered to your partner on later wake-ups, to bring up
 *   if it fits then.
 * - **dropped**: Jev was confident it wasn't worth it (stale, generic, or
 *   something you'd already done). Kept a while, so the same idea isn't
 *   had again.
 *
 * You can see the drawer in Settings → Your partner reaching out, and
 * delete anything in it.
 */

import type { Database } from "bun:sqlite";
import { NotFoundError } from "./errors.ts";

export type IdeaKind = "story" | "character" | "twist" | "thought";
export type IdeaStatus = "drawer" | "shared" | "dropped";

export interface Idea {
  id: string;
  createdAt: string;
  kind: IdeaKind;
  content: string;
  /** How much Jev liked it: the average p(yes) of its grading (0 to 1). */
  grade: number;
  status: IdeaStatus;
  /** Why it has that status, in words. */
  note: string;
  sharedAt: string | null;
}

interface IdeaRow {
  id: string;
  created_at: string;
  kind: IdeaKind;
  content: string;
  grade: number;
  status: IdeaStatus;
  note: string;
  shared_at: string | null;
}

const toIdea = (r: IdeaRow): Idea => ({
  id: r.id,
  createdAt: r.created_at,
  kind: r.kind,
  content: r.content,
  grade: r.grade,
  status: r.status,
  note: r.note,
  sharedAt: r.shared_at,
});

/** How many ideas are kept in all (the oldest go first, the drawer last). */
export const MAX_IDEAS = 120;

export class Ideas {
  constructor(private readonly db: Database) {}

  add(idea: { kind: IdeaKind; content: string; grade: number; status: IdeaStatus; note: string }): Idea {
    const id = crypto.randomUUID();
    this.db
      .query(
        `INSERT INTO ideas (id, created_at, kind, content, grade, status, note, shared_at)
         VALUES ($id, $now, $kind, $content, $grade, $status, $note, NULL)`,
      )
      .run({ id, now: new Date().toISOString(), ...idea });
    this.prune();
    return this.get(id);
  }

  get(id: string): Idea {
    const row = this.db.query("SELECT * FROM ideas WHERE id = $id").get({ id }) as IdeaRow | null;
    if (!row) throw new NotFoundError("idea");
    return toIdea(row);
  }

  /** Every idea, newest first. */
  list(): Idea[] {
    return (this.db.query("SELECT * FROM ideas ORDER BY created_at DESC, rowid DESC").all() as IdeaRow[]).map(toIdea);
  }

  /** The best ideas in the drawer, to offer on a wake-up. */
  drawer(limit = 3): Idea[] {
    return (
      this.db.query("SELECT * FROM ideas WHERE status = 'drawer' ORDER BY grade DESC, created_at DESC LIMIT $limit").all({ limit }) as IdeaRow[]
    ).map(toIdea);
  }

  setStatus(id: string, status: IdeaStatus, note: string): void {
    this.get(id);
    this.db
      .query("UPDATE ideas SET status = $status, note = $note, shared_at = CASE WHEN $status = 'shared' THEN $now ELSE shared_at END WHERE id = $id")
      .run({ id, status, note, now: new Date().toISOString() });
  }

  remove(id: string): void {
    this.get(id);
    this.db.query("DELETE FROM ideas WHERE id = $id").run({ id });
  }

  private prune(): void {
    const { n } = this.db.query("SELECT COUNT(*) AS n FROM ideas").get() as { n: number };
    if (n <= MAX_IDEAS) return;
    this.db
      .query(
        `DELETE FROM ideas WHERE id IN (
           SELECT id FROM ideas ORDER BY CASE status WHEN 'drawer' THEN 1 ELSE 0 END, created_at LIMIT $extra)`,
      )
      .run({ extra: n - MAX_IDEAS });
  }
}

/** Small values the server keeps between runs (like when the next heartbeat is). */
export class AppState {
  constructor(private readonly db: Database) {}

  get(key: string): string | null {
    const row = this.db.query("SELECT value FROM app_state WHERE key = $key").get({ key }) as { value: string } | null;
    return row?.value ?? null;
  }

  set(key: string, value: string | null): void {
    if (value === null) this.db.query("DELETE FROM app_state WHERE key = $key").run({ key });
    else this.db.query("INSERT INTO app_state (key, value) VALUES ($key, $value) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run({ key, value });
  }
}
