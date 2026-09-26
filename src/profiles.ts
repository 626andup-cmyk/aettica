/**
 * Connection profiles and roulettes: which model writes, and how.
 *
 * A **connection profile** locks one model's settings together: the model
 * id, its samplers (temperature, top-p), its reasoning setting, how long a
 * reply may be, a "model notes" prompt that tames that particular model's
 * habits, and whether it can call tools. Swapping profiles changes how your
 * partner's words are produced, never who your partner is: the partner
 * prompts stay the same whichever model runs them.
 *
 * A **roulette** is a weighted set of profiles, like 40% DeepSeek and 60%
 * GLM. Each turn picks one at random, by weight, for variety.
 *
 * Each **job** (roleplay writing, OOC chat) is assigned a profile or a
 * roulette, server-wide, and any channel can override its own. An
 * assignment is written as `"profile:<id>"` or `"roulette:<id>"`; an empty
 * assignment means "the first profile".
 */

import type { Database } from "bun:sqlite";
import { NotFoundError, ValidationError } from "./errors.ts";
import type { Profile, ReasoningEffort, Roulette } from "./types.ts";

// ------------------------------------------------------------- validation

const REASONING: ReasoningEffort[] = ["low", "medium", "high"];

/** Request fields a profile's extra parameters can't override: the app sets these itself. */
const RESERVED_PARAMS = ["model", "messages", "tools", "tool_choice", "stream"];

function text(value: unknown, field: string, max: number, required: boolean): string {
  if (typeof value !== "string") throw new ValidationError(`${field} must be text`);
  if (required && value.trim() === "") throw new ValidationError(`${field} can't be empty`);
  if (value.length > max) throw new ValidationError(`${field} is too long`);
  return required ? value.trim() : value;
}

function number(value: unknown, field: string, min: number, max: number, whole = false): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new ValidationError(`${field} must be a number`);
  if (whole && !Number.isInteger(value)) throw new ValidationError(`${field} must be a whole number`);
  if (value < min || value > max) throw new ValidationError(`${field} must be between ${min} and ${max}`);
  return value;
}

/**
 * Check a profile's extra request fields: a JSON object (as text), or empty.
 * These are sent to nanoGPT as they are, for settings the form doesn't
 * cover (like `top_k` or `min_p`).
 */
export function parseExtraParams(value: string): Record<string, unknown> {
  if (value.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ValidationError('Extra request fields must be JSON, like {"top_k": 40}.');
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ValidationError('Extra request fields must be a JSON object, like {"top_k": 40}.');
  }
  const reserved = Object.keys(parsed).find((key) => RESERVED_PARAMS.includes(key));
  if (reserved) throw new ValidationError(`Extra request fields can't set "${reserved}": the app sets it.`);
  return parsed as Record<string, unknown>;
}

/** The editable parts of a profile, checked. Missing fields are left out. */
function profileInput(input: Record<string, unknown>): Partial<Profile> {
  const clean: Partial<Profile> = {};
  if (input.name !== undefined) clean.name = text(input.name, "name", 100, true);
  if (input.model !== undefined) clean.model = text(input.model, "model", 200, true);
  if (input.temperature !== undefined) clean.temperature = number(input.temperature, "temperature", 0, 2);
  if (input.maxTokens !== undefined) clean.maxTokens = number(input.maxTokens, "maxTokens", 16, 32000, true);
  if (input.topP !== undefined) clean.topP = input.topP === null ? null : number(input.topP, "topP", 0, 1);
  if (input.reasoningEffort !== undefined) {
    if (input.reasoningEffort !== null && !REASONING.includes(input.reasoningEffort as ReasoningEffort)) {
      throw new ValidationError("reasoningEffort must be low, medium, high, or null");
    }
    clean.reasoningEffort = input.reasoningEffort as ReasoningEffort | null;
  }
  if (input.supportsTools !== undefined) {
    if (typeof input.supportsTools !== "boolean") throw new ValidationError("supportsTools must be true or false");
    clean.supportsTools = input.supportsTools;
  }
  if (input.quirkPrompt !== undefined) clean.quirkPrompt = text(input.quirkPrompt, "quirkPrompt", 20_000, false);
  if (input.extraParams !== undefined) {
    clean.extraParams = text(input.extraParams, "extraParams", 5_000, false);
    parseExtraParams(clean.extraParams); // throws if it isn't a JSON object
  }
  return clean;
}

// -------------------------------------------------------------- mapping

interface ProfileRow {
  id: string;
  name: string;
  model: string;
  temperature: number;
  max_tokens: number;
  top_p: number | null;
  reasoning_effort: ReasoningEffort | null;
  supports_tools: number;
  quirk_prompt: string;
  extra_params: string;
  position: number;
  created_at: string;
}

function toProfile(row: ProfileRow): Profile {
  return {
    id: row.id,
    name: row.name,
    model: row.model,
    temperature: row.temperature,
    maxTokens: row.max_tokens,
    topP: row.top_p,
    reasoningEffort: row.reasoning_effort,
    supportsTools: row.supports_tools === 1,
    quirkPrompt: row.quirk_prompt,
    extraParams: row.extra_params,
    position: row.position,
    createdAt: row.created_at,
  };
}

// ------------------------------------------------------------- profiles

export class Profiles {
  constructor(private readonly db: Database) {}

  /** Every profile, in order. */
  list(): Profile[] {
    return (this.db.query("SELECT * FROM profiles ORDER BY position").all() as ProfileRow[]).map(toProfile);
  }

  get(id: string): Profile {
    const row = this.db.query("SELECT * FROM profiles WHERE id = $id").get({ id }) as ProfileRow | null;
    if (!row) throw new NotFoundError("profile");
    return toProfile(row);
  }

  /** Make a profile. Only `name` and `model` are needed; the rest have defaults. */
  create(input: Record<string, unknown>): Profile {
    const clean = profileInput({ temperature: 0.9, maxTokens: 1024, ...input });
    if (!clean.name || !clean.model) throw new ValidationError("A profile needs a name and a model.");
    const { next } = this.db.query("SELECT COALESCE(MAX(position) + 1, 0) AS next FROM profiles").get() as {
      next: number;
    };
    const id = crypto.randomUUID();
    this.db
      .query(
        `INSERT INTO profiles (id, name, model, temperature, max_tokens, top_p, reasoning_effort, supports_tools,
                               quirk_prompt, extra_params, position, created_at)
         VALUES ($id, $name, $model, $temperature, $maxTokens, $topP, $reasoningEffort, $supportsTools,
                 $quirkPrompt, $extraParams, $position, $now)`,
      )
      .run({
        id,
        name: clean.name,
        model: clean.model,
        temperature: clean.temperature!,
        maxTokens: clean.maxTokens!,
        topP: clean.topP ?? null,
        reasoningEffort: clean.reasoningEffort ?? null,
        supportsTools: clean.supportsTools === false ? 0 : 1,
        quirkPrompt: clean.quirkPrompt ?? "",
        extraParams: clean.extraParams ?? "",
        position: next,
        now: new Date().toISOString(),
      });
    return this.get(id);
  }

  /** Change any of a profile's settings. */
  update(id: string, input: Record<string, unknown>): Profile {
    const merged = { ...this.get(id), ...profileInput(input) };
    this.db
      .query(
        `UPDATE profiles SET name = $name, model = $model, temperature = $temperature, max_tokens = $maxTokens,
                top_p = $topP, reasoning_effort = $reasoningEffort, supports_tools = $supportsTools,
                quirk_prompt = $quirkPrompt, extra_params = $extraParams
          WHERE id = $id`,
      )
      .run({
        id,
        name: merged.name,
        model: merged.model,
        temperature: merged.temperature,
        maxTokens: merged.maxTokens,
        topP: merged.topP,
        reasoningEffort: merged.reasoningEffort,
        supportsTools: merged.supportsTools ? 1 : 0,
        quirkPrompt: merged.quirkPrompt,
        extraParams: merged.extraParams,
      });
    return this.get(id);
  }

  /**
   * Delete a profile. It leaves every roulette it was in (see the table's
   * `ON DELETE CASCADE`). The last profile can't be deleted: something has
   * to write.
   */
  delete(id: string): void {
    this.get(id);
    if (this.list().length === 1) throw new ValidationError("You need at least one profile, so the last one can't be deleted.");
    this.db.transaction(() => {
      this.db.query("DELETE FROM profiles WHERE id = $id").run({ id });
      this.forgetAssignment(`profile:${id}`);
    })();
  }

  // ---------------------------------------------------------- roulettes

  listRoulettes(): Roulette[] {
    const rows = this.db.query("SELECT * FROM roulettes ORDER BY position").all() as RouletteRow[];
    return rows.map((row) => this.toRoulette(row));
  }

  getRoulette(id: string): Roulette {
    const row = this.db.query("SELECT * FROM roulettes WHERE id = $id").get({ id }) as RouletteRow | null;
    if (!row) throw new NotFoundError("roulette");
    return this.toRoulette(row);
  }

  createRoulette(input: Record<string, unknown>): Roulette {
    const name = text(input.name, "name", 100, true);
    const entries = this.rouletteEntries(input.entries ?? []);
    const { next } = this.db.query("SELECT COALESCE(MAX(position) + 1, 0) AS next FROM roulettes").get() as {
      next: number;
    };
    const id = crypto.randomUUID();
    this.db.transaction(() => {
      this.db
        .query("INSERT INTO roulettes (id, name, position, created_at) VALUES ($id, $name, $position, $now)")
        .run({ id, name, position: next, now: new Date().toISOString() });
      this.saveEntries(id, entries);
    })();
    return this.getRoulette(id);
  }

  updateRoulette(id: string, input: Record<string, unknown>): Roulette {
    const current = this.getRoulette(id);
    const name = input.name === undefined ? current.name : text(input.name, "name", 100, true);
    const entries = input.entries === undefined ? current.entries : this.rouletteEntries(input.entries);
    this.db.transaction(() => {
      this.db.query("UPDATE roulettes SET name = $name WHERE id = $id").run({ id, name });
      this.db.query("DELETE FROM roulette_profiles WHERE roulette_id = $id").run({ id });
      this.saveEntries(id, entries);
    })();
    return this.getRoulette(id);
  }

  deleteRoulette(id: string): void {
    this.getRoulette(id);
    this.db.transaction(() => {
      this.db.query("DELETE FROM roulettes WHERE id = $id").run({ id });
      this.forgetAssignment(`roulette:${id}`);
    })();
  }

  /**
   * Stop using something that's been deleted: jobs assigned to it go back to
   * the first profile, and channels that used it go back to the server-wide
   * assignment.
   */
  private forgetAssignment(assignment: string): void {
    this.db.query("UPDATE channels SET assignment = NULL WHERE assignment = $assignment").run({ assignment });
    // Settings values are stored as JSON, so the text is in quotes.
    this.db
      .query("UPDATE settings SET value = '\"\"' WHERE key IN ('rpAssignment', 'oocAssignment') AND value = $value")
      .run({ value: JSON.stringify(assignment) });
  }

  // ---------------------------------------------------------- picking

  /**
   * Check that an assignment (`"profile:<id>"`, `"roulette:<id>"`, or `""`
   * for the default) points at something that exists.
   */
  checkAssignment(assignment: string): void {
    if (assignment === "") return;
    const [kind, id] = splitAssignment(assignment);
    if (kind === "profile") this.get(id);
    else if (kind === "roulette") this.getRoulette(id);
    else throw new ValidationError('An assignment must be "profile:<id>" or "roulette:<id>".');
  }

  /**
   * Pick the profile for one turn.
   *
   * @param assignment   What the job (or channel) is assigned to. If it's
   *                     empty, or points at something deleted, the first
   *                     profile is used.
   * @param preferTools  For jobs that act through tools (OOC chat): a
   *                     roulette only draws from its tool-capable profiles,
   *                     if it has any.
   * @param random       A number in [0, 1), for the roulette. Tests pass
   *                     their own.
   */
  pick(assignment: string, preferTools: boolean, random = Math.random()): Profile {
    const [kind, id] = splitAssignment(assignment);
    try {
      if (kind === "profile") return this.get(id);
      if (kind === "roulette") {
        const roulette = this.getRoulette(id);
        const profiles = new Map(this.list().map((p) => [p.id, p]));
        let entries = roulette.entries.filter((e) => profiles.has(e.profileId));
        if (preferTools && entries.some((e) => profiles.get(e.profileId)!.supportsTools)) {
          entries = entries.filter((e) => profiles.get(e.profileId)!.supportsTools);
        }
        const chosen = weightedPick(entries, random);
        if (chosen) return profiles.get(chosen.profileId)!;
      }
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
    }
    const first = this.list()[0];
    if (!first) throw new ValidationError("There are no connection profiles. Make one in Settings → Models.");
    return first;
  }

  // ---------------------------------------------------------- helpers

  private toRoulette(row: RouletteRow): Roulette {
    const entries = this.db
      .query(
        `SELECT rp.profile_id AS profileId, rp.weight FROM roulette_profiles rp
           JOIN profiles p ON p.id = rp.profile_id
          WHERE rp.roulette_id = $id ORDER BY p.position`,
      )
      .all({ id: row.id }) as { profileId: string; weight: number }[];
    return { id: row.id, name: row.name, entries, position: row.position, createdAt: row.created_at };
  }

  /** Check a roulette's list of {profileId, weight}. */
  private rouletteEntries(value: unknown): Roulette["entries"] {
    if (!Array.isArray(value)) throw new ValidationError("entries must be a list");
    const seen = new Set<string>();
    return value.map((item) => {
      const raw = (item ?? {}) as Record<string, unknown>;
      const profileId = text(raw.profileId, "profileId", 100, true);
      this.get(profileId); // must exist
      if (seen.has(profileId)) throw new ValidationError("A profile can only be in a roulette once.");
      seen.add(profileId);
      return { profileId, weight: number(raw.weight, "weight", 0.01, 1000) };
    });
  }

  private saveEntries(rouletteId: string, entries: Roulette["entries"]): void {
    const insert = this.db.query(
      "INSERT INTO roulette_profiles (roulette_id, profile_id, weight) VALUES ($rouletteId, $profileId, $weight)",
    );
    for (const entry of entries) insert.run({ rouletteId, ...entry });
  }
}

interface RouletteRow {
  id: string;
  name: string;
  position: number;
  created_at: string;
}

/** `"profile:abc"` → `["profile", "abc"]`. */
export function splitAssignment(assignment: string): [string, string] {
  const colon = assignment.indexOf(":");
  return colon < 0 ? [assignment, ""] : [assignment.slice(0, colon), assignment.slice(colon + 1)];
}

/**
 * Pick one entry at random, each with a chance proportional to its weight.
 * `random` is a number in [0, 1).
 *
 * Imagine the weights laid end to end on a line: `random` picks a point on
 * it, and the entry whose stretch contains that point wins.
 */
export function weightedPick<T extends { weight: number }>(entries: T[], random: number): T | undefined {
  const total = entries.reduce((sum, e) => sum + e.weight, 0);
  let point = random * total;
  for (const entry of entries) {
    point -= entry.weight;
    if (point < 0) return entry;
  }
  return entries.at(-1);
}
