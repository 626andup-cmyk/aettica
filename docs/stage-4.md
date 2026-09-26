# Stage 4: how the notebook works

Stage 4 adds the **notebook**: characters and lore as entries, each with an owner and permissions, pinned to channels to form their cast. According to [DESIGN.md](../DESIGN.md), its new concepts are **ownership** and **access rules**.

## What you can do now

- **Open the notebook** with the book button at the bottom of the channel list. It lists every entry you can see, in folders, with badges saying whose each one is and what's special about it (hidden, locked, pinned here).
- **Make characters and lore.** A new character starts with the fields Pronouns, Age, Appearance, Personality, Background and Speech, and new lore with Summary and Details. You can rename, add and remove fields freely. Each entry also has **notes for your partner**: how to write this character or use this lore, which your partner reads but which never appear in the story.
- **Link entries** with `[[Name]]`, or `[[Name|shown text]]`, like Obsidian. The editor lists what an entry links to, and crosses out links to names that aren't in the notebook.
- **Choose who owns each entry**: you, your partner, or both of you (shared). Your partner plays their characters, you play yours, and either of you can play shared ones. Until stage 6 gives your partner their own tools, you can make entries for them, or hand one of yours over.
- **Set who else can see and change your entries**: visible or hidden from your partner, and whether they can edit, only suggest changes, or only read. Folders pass these settings down to the entries in them.
- **Build a channel's cast** in channel settings → Cast and lore: pin characters and lore from the notebook, make a new one right there, or unpin. The channel header shows who plays whom: "Arlo plays Ilse Marrow · you play Kestrel · Casual".
- **Your characters for casual scenes** are now notebook entries of yours (or shared ones), with a proxy prefix (`k` for `k: *waves*`). Posting as one pins them to the channel. The old list in Settings is gone; it was moved into the notebook for you.

## Concept 1: ownership

Every entry and folder has an **owner**: `user` (you), `partner`, or `joint` (shared lore). Ownership answers two questions:

- **Who plays a character?** Its owner: yours are yours to write, your partner's are theirs, and shared ones are either of yours (`playedBy` in `src/permissions.ts`, which answers `"user"`, `"partner"` or `"both"`). The prompt tells your partner exactly which characters are theirs, which are shared ("either of you can write for them; keep to what the user has written for them"), and never to write yours.
- **Who decides about an entry?** Only its owner changes its settings: owner, visibility, editing and folder. Shared lore's settings are fixed, so nobody can. An owner can hand an entry over to the other person or make it shared, but after that it's out of their hands.

Folders belong to whoever made them. (A shared folder could never be changed, since shared things have fixed settings, so there aren't any. Shared lore can live in anyone's folder.)

## Concept 2: access rules

Every rule lives in `src/permissions.ts` as a small function that takes **who is asking** (`actor`: `"user"` or `"partner"`) and an entry's settings. Nothing there touches the database, so the rules are easy to read and test, and the same rules will apply to your partner's tools in stage 6.

### The settings that apply

An entry can leave its visibility and editing unset (`null`), meaning "whatever my folder says". `effectiveSettings` works out what actually applies:

1. Shared lore is always visible and suggest-only, whatever is stored.
2. Otherwise the entry's own setting, then its folder's, then visible and open.

### The rules

| Rule | Function | What it says |
| --- | --- | --- |
| See | `canSee` | The owner always can. The other person can unless it's hidden from them. |
| Edit | `editAccess` | `direct`, `suggest` or `none`. The owner edits directly (except shared lore: suggest-only for both). The other person follows the editing setting, and can't edit what they can't see. |
| Settings | `canChangeSettings` | Only the owner. |
| Delete | `canDelete` | Only you, and only your own entries. Your partner never deletes directly: the design has no delete tool, only proposals. |

`src/notebook.ts` applies these to every request. Anything the rules refuse is a `PermissionError`, which the server answers with **403 Forbidden** and a message that says why ("Only this entry's owner can change its settings.").

### Hidden entries

- **An entry hidden from you doesn't exist, as far as the app shows.** It's missing from the notebook, and asking for it by id says "not found", exactly like an id that doesn't exist, so the answer gives nothing away.
- **In a channel's cast, it shows as "??? (hidden)"**, so you know someone is there. You can still unpin it: it's your story too.
- **Your partner still writes with it.** In the prompt it carries the note "Hidden from the user: this is your secret. Use it in the story, but never reveal it outright."
- **An entry you hide from your partner never reaches their prompt**, not even through a `[[link]]`. It's a true surprise, but they can't set it up.

### Suggestions

When you may only suggest a change (shared lore, or an entry whose editing is suggest-only), saving stores a **suggestion** instead: who made it and exactly what would change (a new name, new fields, new notes, or deleting it). The notebook shows pending suggestions at the top.

- The **reviewer** is the entry's owner, or for shared lore, whoever didn't make the suggestion. Accepting applies the change; rejecting leaves the entry as it was.
- Whoever made a suggestion can **withdraw** it.
- Your partner reviews your suggestions from stage 6, when they get tools. Until then, yours wait.

### Deleting

- Your own entries are deleted straight away, and unpinned from every channel.
- Your partner's entries can't be deleted by you. Unpin them instead.
- Deleting shared lore is a suggestion, like any other change to it.
- Deleting a folder keeps its entries: they move out of it.

## The cast

A channel's cast is **whoever's entry is pinned** to it. Pins are rows in the `channel_cast` table, in the order they were pinned, and they carry across scene breaks. Anyone who can see an entry can pin it.

Every channel the server sends to the app comes with its cast, as you see it (`ChannelView` in `src/server.ts`): each member's name (or "??? (hidden)"), who plays them, and whether they're a character or lore.

### Which character a message voices

- **Casual**: your partner writes `Name: text` lines. The names it can use are the characters it plays in the cast, by full or first name. A line with no name belongs to the first of them.
- **Literary**: a post voices the characters it mentions by full or first name. If it names none and your partner has only one character in the cast, it's theirs; otherwise it's narration, voicing no one.
- **Your posts** in casual scenes: the names and prefixes of your characters and shared ones work in every channel. Posting as one pins them to the channel, if they weren't already.

### Proxy prefixes

Any character you can play has one: yours, and shared ones. No two can use the same prefix. A prefix is only a shortcut for your own posts, so you set it directly even on a shared character, whose other changes are suggestions. Handing a character to your partner drops its prefix; making one of yours shared keeps it.

## The prompt

In an RP channel, layer 3 of the prompt stack is now built from the notebook (`forPrompt` in `src/notebook.ts`, `describeEntries` in `src/prompt.ts`):

```
## The cast

### Ilse Marrow (you play this character)
Age: 34
Speech: Short sentences. Nautical expressions.
Notes for you: She never raises her voice.

### Kestrel (the user plays this character)
Pronouns: she/her

## Lore

### The Drowned Bell
Summary: A bell rings under the sea before storms.

## Linked notes

### The Charted Sea
Summary: ...

## Whose characters are whose

You play Ilse Marrow. The user plays Kestrel. Never write their actions, dialogue or thoughts.
```

- Empty fields are left out.
- `[[Links]]` are written as plain text (`[[The Charted Sea|the sea]]` becomes "the sea").
- **Linked notes** are entries that pinned ones link to, one step deep: links from linked notes aren't followed, so the prompt stays small.

In an OOC channel, layer 3 lists each channel with who your partner plays there ("#story: roleplay, you play Ilse Marrow"), and every notebook entry your partner can see, by name, marking the ones that are secrets from you.

## Where things are stored

Migration 4 in `src/db.ts` adds four tables:

| Table | Holds |
| --- | --- |
| `notebook_folders` | Folders: name, owner, visibility, editing |
| `notebook_entries` | Entries: kind, name, fields (as JSON), notes, proxy prefix, folder, owner, and visibility and editing (`NULL` for the folder's) |
| `channel_cast` | Which entries are pinned to which channels. Deleting either side removes the pin. |
| `notebook_suggestions` | Suggested changes: the entry, who suggested it, the change (as JSON), and whether it's pending, accepted, rejected or withdrawn |

It's the first migration written as a **function** instead of plain SQL, because it moves data as well as changing tables:

1. Each RP channel's character becomes an entry of your partner's, pinned to that channel. Its sheet is read into fields line by line (`src/sheets.ts`): a line like `Age: 34` starts a field, other lines continue the one before, and text before the first label (or straight after `Name:`) goes in a Notes field. Identical characters in several channels become one entry pinned to each.
2. Your casual characters, which were a list in settings, become entries of yours with their proxy prefixes, pinned to every RP channel.
3. The old `character_name` and `character_sheet` columns are removed from `channels`.

Like every migration, it runs inside a transaction: it happens completely or not at all.

## API

- `GET /api/notebook`: the folders, entries and pending suggestions you can see, plus the field templates. Each entry comes with the `settings` that apply to it, what you may do with it (`access`: `edit`, `settings`, `delete`), and the channels it's pinned to (`pinnedIn`).
- `POST /api/notebook/entries` with `kind`, `name` and optionally `fields`, `systemPrompt`, `proxyPrefix`, `owner`, `folderId`, `visibility`, `editing`.
- `PATCH /api/notebook/entries/:id` with any of `name`, `fields`, `systemPrompt`, `proxyPrefix`. Returns `{entry}`, or `{suggestion}` if you may only suggest.
- `PUT /api/notebook/entries/:id/settings` with any of `owner`, `folderId`, `visibility`, `editing` (`null` for the folder's). Owner only.
- `DELETE /api/notebook/entries/:id`: returns `{deleted: true}` or `{suggestion}`.
- `POST /api/notebook/folders`, `PATCH /api/notebook/folders/:id`, `DELETE /api/notebook/folders/:id`.
- `POST /api/notebook/suggestions/:id/accept`, `.../reject`, `.../withdraw`.
- `PUT /api/channels/:id/cast/:entryId` pins an entry; `DELETE` unpins it. Both return the channel with its new cast.
- `POST /api/channels/:id/messages` now also returns the `channel`, since posting as a character can add them to the cast.
- Channels no longer have `characterName` or `characterSheet`, and settings no longer have `userCharacters`.

## Tests

- **`test/permissions.test.ts`** (new): each rule on its own: folder inheritance, shared lore's fixed settings, seeing, editing, settings and deleting, and who plays whom.
- **`test/notebook.test.ts`** (new): the notebook from both sides: hidden entries, suggest-only and locked entries, suggestions and who reviews them, deleting, folders, proxy prefixes, the cast with "??? (hidden)", what reaches the prompt (including links, one step deep, and never to what's hidden from your partner), and reading sheets into fields.
- **`test/store.test.ts`**: the example character is a pinned notebook entry, and a stage 3.5 database is upgraded: characters become entries (shared ones once), your casual characters keep their prefixes, and the old columns are gone.
- **`test/server.test.ts`**: the notebook API, permission errors (403), pinning and unpinning, and the cast reaching the prompt.
- **`test/prompt.test.ts`**: the cast, lore, linked notes and secrets in RP prompts, and the notebook in OOC.

The app itself (the notebook, the entry editor, suggestions, folders, the cast in channel settings, posting as a notebook character, and a hidden character in the cast) was checked in a real browser on a phone-sized and a desktop-sized screen, in Classic and Liquid Glass.

## What's next

Stage 5 adds **connection profiles and roulettes**: saved model settings, each with its own quirk prompt (layer 4 of the prompt stack), and weighted random picks between them.
