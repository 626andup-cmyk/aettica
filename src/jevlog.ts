/**
 * The Jev log: every call to Jev from the last 36 hours, exactly as it went.
 *
 * Each row is one `JevCall` (src/jev.ts): what asked ("Wake-up",
 * "Notebook keeper"...), the request exactly as sent, the reply exactly as
 * received, any error, and the fallback profile's request and reply if it
 * was asked. It's for seeing what Jev is told and what it says back: why your
 * partner did or didn't reach out, why the notebook was or wasn't changed.
 *
 * It's a **rolling** log: anything older than 36 hours is deleted whenever
 * a call is added or the log is read, so it never grows past a day and a
 * half of calls. It stays on your phone, like everything else.
 *
 * Times come from the caller (`now`), so tests can move the clock.
 */

import type { Database } from "bun:sqlite";
import type { JevCall } from "./jev.ts";

/** How long a call is kept. */
export const JEV_LOG_HOURS = 36;

/** One call in the log. */
export interface JevLogEntry extends JevCall {
  id: string;
  /** When it was asked. */
  at: string;
}

interface JevLogRow {
  id: string;
  at: string;
  purpose: string;
  model: string;
  request: string | null;
  response: string;
  error: string | null;
  answered_by: JevCall["answeredBy"];
  summary: string;
  fallback: string | null;
  duration_ms: number;
}

function toEntry(row: JevLogRow): JevLogEntry {
  return {
    id: row.id,
    at: row.at,
    purpose: row.purpose,
    model: row.model,
    request: row.request === null ? null : JSON.parse(row.request),
    response: row.response,
    error: row.error,
    answeredBy: row.answered_by,
    summary: row.summary,
    fallback: row.fallback === null ? null : JSON.parse(row.fallback),
    durationMs: row.duration_ms,
  };
}

export class JevLog {
  constructor(private readonly db: Database) {}

  /** Add a call, and let go of any older than 36 hours. */
  add(call: JevCall, now: Date): JevLogEntry {
    const id = crypto.randomUUID();
    this.db
      .query(
        `INSERT INTO jev_log (id, at, purpose, model, request, response, error, answered_by, summary, fallback, duration_ms)
         VALUES ($id, $at, $purpose, $model, $request, $response, $error, $answeredBy, $summary, $fallback, $durationMs)`,
      )
      .run({
        id,
        at: now.toISOString(),
        purpose: call.purpose,
        model: call.model,
        request: call.request === null ? null : JSON.stringify(call.request),
        response: call.response,
        error: call.error,
        answeredBy: call.answeredBy,
        summary: call.summary,
        fallback: call.fallback === null ? null : JSON.stringify(call.fallback),
        durationMs: Math.round(call.durationMs),
      });
    this.prune(now);
    return { ...call, id, at: now.toISOString() };
  }

  /** The last 36 hours of calls, newest first; only the ones with an error, if asked. */
  recent(now: Date, options: { errorsOnly?: boolean } = {}): JevLogEntry[] {
    this.prune(now);
    const rows = this.db
      .query(`SELECT * FROM jev_log WHERE ($errorsOnly = 0 OR error IS NOT NULL) ORDER BY at DESC, rowid DESC`)
      .all({ errorsOnly: options.errorsOnly ? 1 : 0 }) as JevLogRow[];
    return rows.map(toEntry);
  }

  /** Delete calls older than 36 hours. Returns how many went. */
  prune(now: Date): number {
    const cutoff = new Date(now.getTime() - JEV_LOG_HOURS * 3600_000).toISOString();
    return this.db.query("DELETE FROM jev_log WHERE at < $cutoff").run({ cutoff }).changes;
  }
}
