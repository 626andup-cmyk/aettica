/**
 * Bringing a stage 1 chat into the stage 2 database.
 *
 * Stage 1 saved everything to `data/chat.json`: one chat, its settings, and
 * one character sheet. The first time stage 2 starts, if that file exists,
 * its contents are copied into the new database:
 *
 *   - the settings become the server settings
 *   - the chat becomes the `#story` channel, with its character sheet
 *   - an empty `#ooc` channel is added
 *
 * The old file is then renamed to `chat.json.imported`. It isn't deleted, so
 * nothing is lost if anything looks wrong; once you're happy, you can delete
 * it yourself.
 */

import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "./store.ts";
import { validateSettings } from "./store.ts";

/** The stage 1 save file, as far as the import needs to know. */
interface LegacySave {
  settings?: Record<string, unknown> & { characterSheet?: unknown };
  messages?: Array<{
    id?: unknown;
    author?: unknown;
    content?: unknown;
    createdAt?: unknown;
    editedAt?: unknown;
    model?: unknown;
  }>;
}

/**
 * Import `chat.json` from `dataDir` into `store`, if there is one.
 *
 * @returns `true` if a chat was imported, `false` if there was nothing to import.
 */
export function importLegacyChat(store: Store, dataDir: string): boolean {
  const path = join(dataDir, "chat.json");
  if (!existsSync(path)) return false;

  let save: LegacySave;
  try {
    save = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `Found a stage 1 chat at ${path} but couldn't read it: ${(error as Error).message}. ` +
        "Fix or move the file, then restart the server.",
    );
  }

  const sheet = typeof save.settings?.characterSheet === "string" ? save.settings.characterSheet : "";
  const characterName = guessCharacterName(sheet);

  // Everything is imported in one transaction: all of it, or none of it.
  store.db.transaction(() => {
    // Keep only the settings stage 2 still has, and only valid values.
    // (`validateSettings` drops `characterSheet`, which moved to the channel.)
    const { characterSheet: _moved, ...rest } = save.settings ?? {};
    store.updateSettings(validateSettingsLeniently(rest));

    const story = store.createChannel({ name: "story", kind: "rp", characterName, characterSheet: sheet });
    store.createChannel({ name: "ooc", kind: "ooc" });

    for (const message of save.messages ?? []) {
      if (typeof message.content !== "string") continue;
      const author = message.author === "partner" ? "partner" : "user";
      store.addMessage({
        id: typeof message.id === "string" ? message.id : undefined,
        channelId: story.id,
        author,
        content: message.content,
        // Stage 1 was always prose.
        mode: "literary",
        // Stage 1 partner messages all voiced the one character.
        characters: author === "partner" && characterName ? [characterName] : [],
        createdAt: typeof message.createdAt === "string" ? message.createdAt : undefined,
        editedAt: typeof message.editedAt === "string" ? message.editedAt : undefined,
        model: typeof message.model === "string" ? message.model : undefined,
      });
    }
  })();

  renameSync(path, `${path}.imported`);
  console.log(`[import] Moved your stage 1 chat (${save.messages?.length ?? 0} messages) into #story.`);
  return true;
}

/**
 * Find the character's name in a sheet written like `Name: Ilse Marrow`.
 * Returns an empty string if there's no such line; you can set the name in
 * the channel settings afterwards.
 */
export function guessCharacterName(sheet: string): string {
  const match = sheet.match(/^\s*name\s*:\s*(.+?)\s*$/im);
  return match ? match[1]!.slice(0, 100) : "";
}

/** Keep each old setting that is still valid, and silently skip any that isn't. */
function validateSettingsLeniently(settings: Record<string, unknown>): ReturnType<typeof validateSettings> {
  const clean = {};
  for (const [key, value] of Object.entries(settings)) {
    try {
      Object.assign(clean, validateSettings({ [key]: value }));
    } catch {
      // An invalid old value just falls back to the default.
    }
  }
  return clean;
}
