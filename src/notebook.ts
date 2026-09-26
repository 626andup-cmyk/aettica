/**
 * The notebook: characters and lore, their folders, suggestions, and which
 * channels they're pinned to (the cast).
 *
 * Every method takes an `actor`: who is asking, you (`"user"`) or your
 * partner (`"partner"`). Each one checks the rules in `src/permissions.ts`
 * before doing anything, so the same code serves you now and your partner's
 * tools in stage 6. Things hidden from the actor behave as if they don't
 * exist (`NotFoundError`), so nothing leaks through an error message.
 *
 * Tables (see migration 4 in `src/db.ts`):
 *
 *   notebook_folders      folders, with the settings they pass down
 *   notebook_entries      characters and lore
 *   channel_cast          which entries are pinned to which channel
 *   notebook_suggestions  suggested changes, waiting for the owner
 */

import type { Database } from "bun:sqlite";
import { NotFoundError, PermissionError, ValidationError } from "./errors.ts";
import {
  canChangeSettings,
  canDelete,
  canSee,
  editAccess,
  effectiveSettings,
  HIDDEN_NAME,
  playedBy,
} from "./permissions.ts";
import type {
  Author,
  CastMember,
  EffectiveSettings,
  Editing,
  EntryField,
  EntryKind,
  NotebookEntry,
  NotebookFolder,
  Owner,
  SuggestedChange,
  Suggestion,
  Visibility,
} from "./types.ts";

// ------------------------------------------------------------------ views

/**
 * An entry as one person sees it: the entry, the settings that apply, and
 * what that person may do with it. This is what the app receives.
 */
export interface EntryView extends NotebookEntry {
  settings: EffectiveSettings;
  access: {
    /** How they may change its contents (see `editAccess`). */
    edit: "direct" | "suggest" | "none";
    /** Whether they may change its owner, visibility, editing and folder. */
    settings: boolean;
    /** Whether they may delete it outright. */
    delete: boolean;
  };
  /** Ids of the channels it's pinned to. */
  pinnedIn: string[];
}

/** An entry prepared for your partner's prompt (see `forPrompt`). */
export interface PromptEntry {
  entry: NotebookEntry;
  /** Hidden from you: your partner must keep its secrets. */
  hiddenFromUser: boolean;
}

/** The fields a new entry starts with, by kind: a template to fill in. */
export const ENTRY_TEMPLATES: Record<EntryKind, string[]> = {
  character: ["Pronouns", "Age", "Appearance", "Personality", "Background", "Speech"],
  lore: ["Summary", "Details"],
};

// ------------------------------------------------------------- validation

const LIMITS = { name: 100, label: 60, value: 20_000, fields: 50, systemPrompt: 20_000 } as const;
const OWNERS: Owner[] = ["user", "partner", "joint"];
const VISIBILITIES: Visibility[] = ["visible", "hidden"];
const EDITINGS: Editing[] = ["open", "suggest", "locked"];

function text(value: unknown, field: string, max: number, required: boolean): string {
  if (typeof value !== "string") throw new ValidationError(`${field} must be text`);
  if (required && value.trim() === "") throw new ValidationError(`${field} can't be empty`);
  if (value.length > max) throw new ValidationError(`${field} is too long`);
  return required ? value.trim() : value;
}

function oneOf<T extends string>(value: unknown, options: T[], field: string): T {
  if (!options.includes(value as T)) throw new ValidationError(`${field} must be one of: ${options.join(", ")}`);
  return value as T;
}

/** An entry's fields: a list of {label, value}. Empty labels are dropped. */
function fieldList(value: unknown): EntryField[] {
  if (!Array.isArray(value)) throw new ValidationError("fields must be a list");
  if (value.length > LIMITS.fields) throw new ValidationError(`An entry can have ${LIMITS.fields} fields at most`);
  return value
    .map((item) => {
      const raw = (item ?? {}) as Record<string, unknown>;
      return {
        label: text(raw.label ?? "", "A field's label", LIMITS.label, false).trim(),
        value: text(raw.value ?? "", "A field's value", LIMITS.value, false),
      };
    })
    .filter((field) => field.label !== "");
}

/** A proxy prefix: short, no spaces or colons. Empty means none. */
function proxyPrefix(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !/^[^\s:]{1,20}$/.test(value.trim())) {
    throw new ValidationError("A proxy prefix must be short, with no spaces or colons");
  }
  return value.trim();
}

/** The contents of an entry that can be edited (or suggested). */
function contentChanges(input: Record<string, unknown>): SuggestedChange {
  const change: SuggestedChange = {};
  if (input.name !== undefined) change.name = text(input.name, "name", LIMITS.name, true);
  if (input.fields !== undefined) change.fields = fieldList(input.fields);
  if (input.systemPrompt !== undefined) change.systemPrompt = text(input.systemPrompt, "systemPrompt", LIMITS.systemPrompt, false);
  return change;
}

// -------------------------------------------------------------- mapping

interface EntryRow {
  id: string;
  kind: EntryKind;
  name: string;
  fields: string;
  system_prompt: string;
  proxy_prefix: string | null;
  folder_id: string | null;
  owner: Owner;
  visibility: Visibility | null;
  editing: Editing | null;
  created_at: string;
  updated_at: string;
}

interface FolderRow {
  id: string;
  name: string;
  owner: Owner;
  visibility: Visibility;
  editing: Editing;
  position: number;
  created_at: string;
}

function toEntry(row: EntryRow): NotebookEntry {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    fields: JSON.parse(row.fields) as EntryField[],
    systemPrompt: row.system_prompt,
    proxyPrefix: row.proxy_prefix,
    folderId: row.folder_id,
    owner: row.owner,
    visibility: row.visibility,
    editing: row.editing,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toFolder(row: FolderRow): NotebookFolder {
  return {
    id: row.id,
    name: row.name,
    owner: row.owner,
    visibility: row.visibility,
    editing: row.editing,
    position: row.position,
    createdAt: row.created_at,
  };
}

/**
 * The names an entry links to with Obsidian-style `[[Name]]` links, from its
 * fields and system prompt. `[[Name|shown text]]` links to Name.
 */
export function linkedNames(entry: Pick<NotebookEntry, "fields" | "systemPrompt">): string[] {
  const all = [entry.systemPrompt, ...entry.fields.map((f) => f.value)].join("\n");
  const names = [...all.matchAll(/\[\[([^\]|\n]{1,100})(?:\|[^\]\n]*)?\]\]/g)].map((m) => m[1]!.trim());
  return [...new Set(names)];
}

// -------------------------------------------------------------- notebook

export class Notebook {
  constructor(private readonly db: Database) {}

  // ------------------------------------------------------------ folders

  /** Every folder the actor can see, in order. */
  listFolders(actor: Author): NotebookFolder[] {
    const rows = this.db.query("SELECT * FROM notebook_folders ORDER BY position").all() as FolderRow[];
    return rows.map(toFolder).filter((folder) => canSee(actor, folderSettings(folder)));
  }

  /** One folder the actor can see. */
  getFolder(actor: Author, id: string): NotebookFolder {
    const row = this.db.query("SELECT * FROM notebook_folders WHERE id = $id").get({ id }) as FolderRow | null;
    if (!row || !canSee(actor, folderSettings(toFolder(row)))) throw new NotFoundError("folder");
    return toFolder(row);
  }

  /**
   * Make a folder, owned by the actor. (Folders aren't shared: only the
   * owner can change one, so a shared folder could never be changed. Shared
   * lore can still go in anyone's folder.)
   */
  createFolder(actor: Author, input: Record<string, unknown>): NotebookFolder {
    const owner = actor;
    const { next } = this.db.query("SELECT COALESCE(MAX(position) + 1, 0) AS next FROM notebook_folders").get() as {
      next: number;
    };
    const id = crypto.randomUUID();
    this.db
      .query(
        `INSERT INTO notebook_folders (id, name, owner, visibility, editing, position, created_at)
         VALUES ($id, $name, $owner, $visibility, $editing, $position, $now)`,
      )
      .run({
        id,
        name: text(input.name, "name", LIMITS.name, true),
        owner,
        visibility: input.visibility === undefined ? "visible" : oneOf(input.visibility, VISIBILITIES, "visibility"),
        editing: input.editing === undefined ? "open" : oneOf(input.editing, EDITINGS, "editing"),
        position: next,
        now: new Date().toISOString(),
      });
    return this.getFolder(actor, id);
  }

  /** Rename a folder or change its settings. Only its owner can. */
  updateFolder(actor: Author, id: string, input: Record<string, unknown>): NotebookFolder {
    const folder = this.getFolder(actor, id);
    if (!canChangeSettings(actor, folder.owner)) throw new PermissionError("Only this folder's owner can change it.");
    const updated = {
      name: input.name === undefined ? folder.name : text(input.name, "name", LIMITS.name, true),
      visibility: input.visibility === undefined ? folder.visibility : oneOf(input.visibility, VISIBILITIES, "visibility"),
      editing: input.editing === undefined ? folder.editing : oneOf(input.editing, EDITINGS, "editing"),
    };
    this.db
      .query("UPDATE notebook_folders SET name = $name, visibility = $visibility, editing = $editing WHERE id = $id")
      .run({ id, ...updated });
    return this.getFolder(actor, id);
  }

  /** Delete a folder. Its entries aren't deleted: they move out of it. Only its owner can. */
  deleteFolder(actor: Author, id: string): void {
    const folder = this.getFolder(actor, id);
    if (!canChangeSettings(actor, folder.owner)) throw new PermissionError("Only this folder's owner can delete it.");
    this.db.query("DELETE FROM notebook_folders WHERE id = $id").run({ id });
  }

  // ------------------------------------------------------------ entries

  /** Every entry the actor can see, by name, with what they may do with each. */
  listEntries(actor: Author): EntryView[] {
    const rows = this.db.query("SELECT * FROM notebook_entries ORDER BY name COLLATE NOCASE").all() as EntryRow[];
    const folders = this.folderMap();
    return rows
      .map(toEntry)
      .filter((entry) => canSee(actor, this.settingsOf(entry, folders)))
      .map((entry) => this.view(actor, entry, folders));
  }

  /** One entry the actor can see. Hidden or missing entries are `NotFoundError`. */
  getEntry(actor: Author, id: string): EntryView {
    const entry = this.rawEntry(id);
    if (!entry || !canSee(actor, this.settingsOf(entry))) throw new NotFoundError("entry");
    return this.view(actor, entry);
  }

  /**
   * Make an entry. The actor can make entries of their own or shared ones;
   * you can also make one for your partner (they can't make their own until
   * stage 6). Starts from its kind's template if no fields are given.
   */
  createEntry(actor: Author, input: Record<string, unknown>): EntryView {
    const kind = oneOf(input.kind ?? "character", ["character", "lore"], "kind");
    const allowedOwners: Owner[] = actor === "user" ? OWNERS : ["partner", "joint"];
    const owner = input.owner === undefined ? actor : oneOf(input.owner, allowedOwners, "owner");
    // Only an entry's owner chooses who else can see and edit it.
    const hasSettings = (input.visibility ?? null) !== null || (input.editing ?? null) !== null;
    if (hasSettings && owner !== actor && owner !== "joint") {
      throw new PermissionError("Only an entry's owner chooses its visibility and editing.");
    }
    const contents = contentChanges({ ...input, name: input.name ?? "" });
    const folderId = input.folderId ? this.getFolder(actor, String(input.folderId)).id : null;
    const prefix = this.checkPrefix(proxyPrefix(input.proxyPrefix), kind, owner, null);
    const now = new Date().toISOString();
    const id = crypto.randomUUID();

    this.db
      .query(
        `INSERT INTO notebook_entries
           (id, kind, name, fields, system_prompt, proxy_prefix, folder_id, owner, visibility, editing, created_at, updated_at)
         VALUES ($id, $kind, $name, $fields, $systemPrompt, $prefix, $folderId, $owner, $visibility, $editing, $now, $now)`,
      )
      .run({
        id,
        kind,
        name: contents.name!,
        fields: JSON.stringify(contents.fields ?? ENTRY_TEMPLATES[kind].map((label) => ({ label, value: "" }))),
        systemPrompt: contents.systemPrompt ?? "",
        prefix,
        folderId,
        owner,
        visibility: input.visibility === undefined || input.visibility === null ? null : oneOf(input.visibility, VISIBILITIES, "visibility"),
        editing: input.editing === undefined || input.editing === null ? null : oneOf(input.editing, EDITINGS, "editing"),
        now,
      });
    return this.getEntry(actor, id);
  }

  /**
   * Change an entry's contents (name, fields, system prompt) and, for the
   * owner of a character of yours, its proxy prefix.
   *
   * If the actor may only *suggest* changes (see `editAccess`), a suggestion
   * is saved instead, for the owner to review, and returned.
   */
  editEntry(actor: Author, id: string, input: Record<string, unknown>): { entry: EntryView } | { suggestion: Suggestion } {
    const current = this.getEntry(actor, id);
    const change = contentChanges(input);

    if (current.access.edit === "none") throw new PermissionError("This entry is locked.");
    if (current.access.edit === "suggest") {
      if (Object.keys(change).length === 0) throw new ValidationError("There's nothing to suggest.");
      return { suggestion: this.addSuggestion(actor, id, change) };
    }

    const prefix =
      input.proxyPrefix === undefined || current.owner !== actor
        ? current.proxyPrefix
        : this.checkPrefix(proxyPrefix(input.proxyPrefix), current.kind, current.owner, id);
    this.applyChange(id, change, prefix);
    return { entry: this.getEntry(actor, id) };
  }

  /**
   * Change an entry's settings: owner, visibility, editing, folder. Only its
   * owner can. (Revealing a hidden entry is setting its visibility to
   * visible.) `null` visibility or editing means "use the folder's".
   */
  updateEntrySettings(actor: Author, id: string, input: Record<string, unknown>): EntryView {
    const current = this.getEntry(actor, id);
    if (!current.access.settings) {
      throw new PermissionError(
        current.owner === "joint" ? "Shared lore's settings are fixed." : "Only this entry's owner can change its settings.",
      );
    }
    // The owner can hand an entry over, or make it shared. Once given away,
    // only the new owner can change it back.
    const owner = input.owner === undefined ? current.owner : oneOf(input.owner, OWNERS, "owner");
    const folderId =
      input.folderId === undefined ? current.folderId : input.folderId ? this.getFolder(actor, String(input.folderId)).id : null;
    const setting = <T extends string>(value: unknown, options: T[], field: string, now: T | null): T | null =>
      value === undefined ? now : value === null ? null : oneOf(value, options, field);

    this.db
      .query(
        `UPDATE notebook_entries SET owner = $owner, folder_id = $folderId, visibility = $visibility, editing = $editing,
                proxy_prefix = $prefix, updated_at = $now WHERE id = $id`,
      )
      .run({
        id,
        owner,
        folderId,
        visibility: setting(input.visibility, VISIBILITIES, "visibility", current.visibility),
        editing: setting(input.editing, EDITINGS, "editing", current.editing),
        // Proxy prefixes are only for your characters.
        prefix: owner === "user" ? current.proxyPrefix : null,
        now: new Date().toISOString(),
      });
    // After handing it over the actor may no longer see it (if hidden).
    return this.canSeeEntry(actor, id) ? this.getEntry(actor, id) : current;
  }

  /**
   * Delete an entry. Your own entries are deleted at once. Shared lore
   * becomes a suggestion to delete it; anything else can't be deleted by
   * you (and your partner never deletes directly).
   */
  deleteEntry(actor: Author, id: string): { deleted: true } | { suggestion: Suggestion } {
    const current = this.getEntry(actor, id);
    if (current.access.delete) {
      this.db.query("DELETE FROM notebook_entries WHERE id = $id").run({ id });
      return { deleted: true };
    }
    if (current.access.edit === "suggest" || current.owner === "joint") {
      return { suggestion: this.addSuggestion(actor, id, { delete: true }) };
    }
    throw new PermissionError(
      actor === "partner" ? "Your partner can only suggest deleting things." : "This entry isn't yours to delete. You can unpin it instead.",
    );
  }

  // --------------------------------------------------------- suggestions

  /** Pending suggestions the actor can see: made by them, or waiting for them. */
  listSuggestions(actor: Author): Suggestion[] {
    const rows = this.db
      .query("SELECT * FROM notebook_suggestions WHERE status = 'pending' ORDER BY created_at")
      .all() as SuggestionRow[];
    return rows.map(toSuggestion).filter((s) => this.canSeeEntry(actor, s.entryId));
  }

  /**
   * Accept or reject a suggestion. The person who reviews it is the entry's
   * owner, or for shared lore, whoever didn't suggest it. Accepting applies
   * the change (or deletes the entry).
   */
  reviewSuggestion(actor: Author, id: string, decision: "accepted" | "rejected"): Suggestion {
    const suggestion = this.getSuggestion(actor, id);
    const entry = this.getEntry(actor, suggestion.entryId);
    const reviewer = entry.owner === "joint" ? (suggestion.author === "user" ? "partner" : "user") : entry.owner;
    if (reviewer !== actor) throw new PermissionError("This suggestion is for the other person to review.");

    this.db.transaction(() => {
      if (decision === "accepted") {
        if (suggestion.change.delete) this.db.query("DELETE FROM notebook_entries WHERE id = $id").run({ id: entry.id });
        else this.applyChange(entry.id, suggestion.change, entry.proxyPrefix);
      }
      this.resolveSuggestion(id, decision);
    })();
    return { ...suggestion, status: decision };
  }

  /** Take back a suggestion you made. */
  withdrawSuggestion(actor: Author, id: string): void {
    const suggestion = this.getSuggestion(actor, id);
    if (suggestion.author !== actor) throw new PermissionError("Only whoever made a suggestion can withdraw it.");
    this.resolveSuggestion(id, "withdrawn");
  }

  // -------------------------------------------------------------- cast

  /**
   * A channel's cast and pinned lore, as the actor sees it. Entries hidden
   * from the actor are shown only as "??? (hidden)".
   */
  castFor(actor: Author, channelId: string): CastMember[] {
    const folders = this.folderMap();
    return this.pinnedEntries(channelId).map((entry) => {
      const hidden = !canSee(actor, this.settingsOf(entry, folders));
      return {
        entryId: entry.id,
        name: hidden ? HIDDEN_NAME : entry.name,
        playedBy: playedBy(entry),
        owner: entry.owner,
        hidden,
        proxyPrefix: hidden ? null : entry.proxyPrefix,
        kind: entry.kind,
      };
    });
  }

  /** Pin an entry to a channel, at the end. Anyone who can see it can pin it. */
  pin(actor: Author, channelId: string, entryId: string): void {
    this.getEntry(actor, entryId); // must exist and be visible
    const { next } = this.db
      .query("SELECT COALESCE(MAX(position) + 1, 0) AS next FROM channel_cast WHERE channel_id = $channelId")
      .get({ channelId }) as { next: number };
    this.db
      .query("INSERT OR IGNORE INTO channel_cast (channel_id, entry_id, position) VALUES ($channelId, $entryId, $next)")
      .run({ channelId, entryId, next });
  }

  /**
   * Unpin an entry from a channel. This works even for an entry hidden
   * from you: it's your story, and you can see that something is pinned.
   */
  unpin(_actor: Author, channelId: string, entryId: string): void {
    const result = this.db
      .query("DELETE FROM channel_cast WHERE channel_id = $channelId AND entry_id = $entryId")
      .run({ channelId, entryId });
    if (result.changes === 0) throw new NotFoundError("pin");
  }

  /**
   * What your partner's prompt gets for a channel: every pinned entry they
   * can see, then any entry those link to with `[[Name]]` (one step, no
   * further), each marked if it's hidden from you. Entries hidden from your
   * partner never appear.
   */
  forPrompt(channelId: string): { pinned: PromptEntry[]; linked: PromptEntry[] } {
    const folders = this.folderMap();
    const toPrompt = (entry: NotebookEntry): PromptEntry | null => {
      const settings = this.settingsOf(entry, folders);
      if (!canSee("partner", settings)) return null;
      return { entry, hiddenFromUser: !canSee("user", settings) };
    };

    const pinned = this.pinnedEntries(channelId)
      .map(toPrompt)
      .filter((p): p is PromptEntry => p !== null);

    const seen = new Set(pinned.map((p) => p.entry.id));
    const byName = new Map(this.allEntries().map((e) => [e.name.toLowerCase(), e]));
    const linked: PromptEntry[] = [];
    for (const { entry } of pinned) {
      for (const name of linkedNames(entry)) {
        const target = byName.get(name.toLowerCase());
        if (!target || seen.has(target.id)) continue;
        seen.add(target.id);
        const prompt = toPrompt(target);
        if (prompt) linked.push(prompt);
      }
    }
    return { pinned, linked };
  }

  /**
   * Every notebook entry your partner can see, for the OOC prompt's
   * overview, each marked if it's hidden from you.
   */
  partnerOverview(): PromptEntry[] {
    const folders = this.folderMap();
    return this.allEntries()
      .filter((entry) => canSee("partner", this.settingsOf(entry, folders)))
      .map((entry) => ({ entry, hiddenFromUser: !canSee("user", this.settingsOf(entry, folders)) }));
  }

  /** Your characters (to post as in casual scenes), by name. */
  userCharacters(): NotebookEntry[] {
    return this.allEntries().filter((e) => e.kind === "character" && e.owner === "user");
  }

  // ------------------------------------------------------------ helpers

  private rawEntry(id: string): NotebookEntry | null {
    const row = this.db.query("SELECT * FROM notebook_entries WHERE id = $id").get({ id }) as EntryRow | null;
    return row ? toEntry(row) : null;
  }

  private allEntries(): NotebookEntry[] {
    return (this.db.query("SELECT * FROM notebook_entries ORDER BY name COLLATE NOCASE").all() as EntryRow[]).map(toEntry);
  }

  private pinnedEntries(channelId: string): NotebookEntry[] {
    const rows = this.db
      .query(
        `SELECT e.* FROM channel_cast c JOIN notebook_entries e ON e.id = c.entry_id
          WHERE c.channel_id = $channelId ORDER BY c.position, e.name`,
      )
      .all({ channelId }) as EntryRow[];
    return rows.map(toEntry);
  }

  private folderMap(): Map<string, NotebookFolder> {
    const rows = this.db.query("SELECT * FROM notebook_folders").all() as FolderRow[];
    return new Map(rows.map((row) => [row.id, toFolder(row)]));
  }

  private settingsOf(entry: NotebookEntry, folders = this.folderMap()): EffectiveSettings {
    return effectiveSettings(entry, entry.folderId ? (folders.get(entry.folderId) ?? null) : null);
  }

  private canSeeEntry(actor: Author, id: string): boolean {
    const entry = this.rawEntry(id);
    return entry !== null && canSee(actor, this.settingsOf(entry));
  }

  private view(actor: Author, entry: NotebookEntry, folders = this.folderMap()): EntryView {
    const settings = this.settingsOf(entry, folders);
    const pinnedIn = (
      this.db.query("SELECT channel_id FROM channel_cast WHERE entry_id = $id").all({ id: entry.id }) as {
        channel_id: string;
      }[]
    ).map((r) => r.channel_id);
    return {
      ...entry,
      settings,
      access: {
        edit: editAccess(actor, settings),
        settings: canChangeSettings(actor, entry.owner),
        delete: canDelete(actor, settings),
      },
      pinnedIn,
    };
  }

  /** Save a content change to an entry. */
  private applyChange(id: string, change: SuggestedChange, prefix: string | null): void {
    const current = this.rawEntry(id)!;
    this.db
      .query(
        `UPDATE notebook_entries SET name = $name, fields = $fields, system_prompt = $systemPrompt,
                proxy_prefix = $prefix, updated_at = $now WHERE id = $id`,
      )
      .run({
        id,
        name: change.name ?? current.name,
        fields: JSON.stringify(change.fields ?? current.fields),
        systemPrompt: change.systemPrompt ?? current.systemPrompt,
        prefix,
        now: new Date().toISOString(),
      });
  }

  /**
   * Check a proxy prefix: only your characters have one, and no two of
   * yours can share one (or a line starting with it would be ambiguous).
   */
  private checkPrefix(prefix: string | null, kind: EntryKind, owner: Owner, ownId: string | null): string | null {
    if (prefix === null) return null;
    if (kind !== "character" || owner !== "user") throw new ValidationError("Only your own characters have a proxy prefix.");
    const clash = this.userCharacters().find(
      (e) => e.id !== ownId && e.proxyPrefix?.toLowerCase() === prefix.toLowerCase(),
    );
    if (clash) throw new ValidationError(`${clash.name} already uses the prefix "${prefix}".`);
    return prefix;
  }

  private addSuggestion(actor: Author, entryId: string, change: SuggestedChange): Suggestion {
    const id = crypto.randomUUID();
    this.db
      .query(
        `INSERT INTO notebook_suggestions (id, entry_id, author, change, created_at)
         VALUES ($id, $entryId, $actor, $change, $now)`,
      )
      .run({ id, entryId, actor, change: JSON.stringify(change), now: new Date().toISOString() });
    return this.getSuggestion(actor, id);
  }

  private getSuggestion(actor: Author, id: string): Suggestion {
    const row = this.db.query("SELECT * FROM notebook_suggestions WHERE id = $id").get({ id }) as SuggestionRow | null;
    if (!row || !this.canSeeEntry(actor, row.entry_id)) throw new NotFoundError("suggestion");
    const suggestion = toSuggestion(row);
    if (suggestion.status !== "pending") throw new ValidationError("That suggestion has already been dealt with.");
    return suggestion;
  }

  private resolveSuggestion(id: string, status: Suggestion["status"]): void {
    this.db
      .query("UPDATE notebook_suggestions SET status = $status, resolved_at = $now WHERE id = $id")
      .run({ id, status, now: new Date().toISOString() });
  }
}

interface SuggestionRow {
  id: string;
  entry_id: string;
  author: Author;
  change: string;
  status: Suggestion["status"];
  created_at: string;
  resolved_at: string | null;
}

function toSuggestion(row: SuggestionRow): Suggestion {
  return {
    id: row.id,
    entryId: row.entry_id,
    author: row.author,
    change: JSON.parse(row.change) as SuggestedChange,
    status: row.status,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

/** A folder's settings, in the same shape as an entry's. */
function folderSettings(folder: NotebookFolder): EffectiveSettings {
  if (folder.owner === "joint") return { owner: "joint", visibility: "visible", editing: "suggest" };
  return { owner: folder.owner, visibility: folder.visibility, editing: folder.editing };
}
