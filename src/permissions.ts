/**
 * Notebook permissions: who can see, edit and manage each entry.
 *
 * Every rule in the design's "Notebook and permissions" section lives here,
 * as small functions that take *who is asking* (`actor`: you or your
 * partner) and an entry. Nothing here touches the database, so the rules
 * are easy to read and to test, and the same rules apply to both of you:
 * your actions through the app now, and your partner's through tools in
 * stage 6.
 *
 * The three settings (see `src/types.ts`):
 *
 *   owner       user, partner, or joint (shared lore)
 *   visibility  visible, or hidden from the other person
 *   editing     open, suggest-only, or locked (for the other person)
 *
 * Visibility and editing can be left unset on an entry, in which case its
 * folder's setting applies.
 */

import type { Author, EffectiveSettings, NotebookEntry, NotebookFolder } from "./types.ts";

/**
 * The settings that actually apply to an entry.
 *
 *   - An entry's own visibility and editing win; if unset, its folder's
 *     apply; with no folder, it's visible and open.
 *   - Shared lore (`joint`) is always visible and always suggest-only,
 *     whatever is stored: that's the design's rule for lore you share.
 */
export function effectiveSettings(entry: NotebookEntry, folder: NotebookFolder | null): EffectiveSettings {
  if (entry.owner === "joint") return { owner: "joint", visibility: "visible", editing: "suggest" };
  return {
    owner: entry.owner,
    visibility: entry.visibility ?? folder?.visibility ?? "visible",
    editing: entry.editing ?? folder?.editing ?? "open",
  };
}

/** Whether someone owns the entry (shared lore belongs to both). */
export function owns(actor: Author, settings: EffectiveSettings): boolean {
  return settings.owner === actor || settings.owner === "joint";
}

/**
 * Whether someone can see an entry at all. The owner always can; the other
 * person can unless it's hidden from them.
 */
export function canSee(actor: Author, settings: EffectiveSettings): boolean {
  return owns(actor, settings) || settings.visibility === "visible";
}

/**
 * How someone may change an entry's contents (its name, fields and system
 * prompt):
 *
 *   - `"direct"`: save changes straight away.
 *   - `"suggest"`: only suggest changes, for the other person to review.
 *   - `"none"`: not at all.
 *
 * The owner edits directly, except for shared lore, which is suggest-only
 * for both of you. Anyone else follows the entry's editing setting, and
 * can't edit what they can't see.
 */
export function editAccess(actor: Author, settings: EffectiveSettings): "direct" | "suggest" | "none" {
  if (settings.owner === "joint") return "suggest";
  if (settings.owner === actor) return "direct";
  if (!canSee(actor, settings)) return "none";
  if (settings.editing === "open") return "direct";
  if (settings.editing === "suggest") return "suggest";
  return "none";
}

/**
 * Whether someone can change an entry's or folder's settings (owner,
 * visibility, editing, folder) or reveal it. Only its owner can. Shared
 * lore's settings are fixed, so nobody can.
 */
export function canChangeSettings(actor: Author, owner: NotebookEntry["owner"]): boolean {
  return owner === actor;
}

/**
 * Whether someone can delete an entry outright.
 *
 *   - Your partner never deletes anything directly: the design has no
 *     delete tool, only proposals you approve.
 *   - You can delete your own entries. Shared lore is deleted by
 *     suggestion, like any other change to it.
 */
export function canDelete(actor: Author, settings: EffectiveSettings): boolean {
  return actor === "user" && settings.owner === "user";
}

/**
 * Who voices a character: your characters are yours to play; your
 * partner's, and shared ones, are your partner's to play.
 */
export function playedBy(entry: Pick<NotebookEntry, "owner">): Author {
  return entry.owner === "user" ? "user" : "partner";
}

/** What an entry is called for someone who can't see it. */
export const HIDDEN_NAME = "??? (hidden)";
