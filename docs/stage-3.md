# Stage 3: how it works

Stage 3 adds **scene breaks** and **literary/casual modes**. According to [DESIGN.md](../DESIGN.md), its new concepts are **per-channel settings** and **rendering modes**: the same kind of data (a message) shown and written in different ways depending on where it lives.

This document covers what changed since [stage 2](stage-2.md).

## What you can do now

- **Start a new scene** in a roleplay channel: type `=====` on its own, or `===== The Storm` to give the scene a title, or press the ⁂ button. A divider appears with the title, which you can rename or remove.
- **Choose a style** for each roleplay channel (channel settings → Style, or when creating it):
  - **Literary**: your partner writes one prose post per turn. Posts are shown as wide prose blocks in a book-like font.
  - **Casual**: short in-character messages, one character per bubble, like a group chat or Tupperbox on Discord. Each character gets their own avatar colour.
- **Post as your own characters** in casual scenes. List them in Settings → Your characters, one per line as `prefix: Name` (like `k: Kestrel`). Then:
  - start a line with `k:` to post it as Kestrel, like Tupperbox's proxy tags
  - or pick who you're posting as from the "Posting as" menu above the text box
  - several tagged lines in one message become several bubbles
- **Regenerate a casual reply** as a whole: all its bubbles are replaced together.

## Scenes

### A scene break is a row

The design says scene breaks are "real objects in the data". They're stored in the `messages` table as rows with `kind = 'scene_break'`, whose `content` is the scene's title. Keeping them in the same table as messages means they stay in order with the messages around them without any extra bookkeeping: both are sorted by `seq`.

In `src/types.ts`, `Message.kind` is `"post"` or `"scene_break"`.

### What the model sees

In the prompt's history (layer 5), a scene break becomes an out-of-character line from you:

```
(OOC: Scene break. The next scene is "The Storm".)
```

If the channel *ends* on a scene break and your partner takes a turn, they're also asked to write the new scene's opening.

In stage 7, each break will also trigger a **scene summary**, and later scenes will be sent as summaries instead of raw messages. For now, the most recent messages are sent across breaks, as before.

## Modes

### Mode lives on the channel and on each message

The design has one rule for modes: **a scene never mixes styles.** So:

| Where | Column | Meaning |
| --- | --- | --- |
| `channels.mode` | `literary` / `casual` | The current scene's mode |
| `channels.pending_mode` | `literary` / `casual` / NULL | A change waiting for the next scene break |
| `messages.mode` | `literary` / `casual` / NULL | The mode the message was written in (NULL for OOC channels and scene breaks) |

When you change a channel's mode (`Store.updateChannel` in `src/store.ts`):

- if the current scene has no posts yet (a new channel, or just after a break), it applies right away
- otherwise it's saved as `pending_mode`, the header says "(casual from the next scene)", and `Store.addSceneBreak` applies it when the next break is added, in the same transaction

Each message remembers its own mode, so older scenes keep looking the way they were written after the channel switches.

### Rendering modes

A **rendering mode** means the same data drawn differently. `renderMessage` in `public/app.js` gives each message a `data-mode` attribute, and `public/style.css` lays it out:

| `data-mode` | Layout |
| --- | --- |
| `literary` | A prose block: small byline, then the text in `--font-prose`, up to `--prose-max-width` wide. No avatar. |
| `casual` | A chat bubble with avatar and name. A run of bubbles from the same character within a few minutes is **grouped** (`.continued`): only the first shows the avatar and name. Edit/Delete appear on hover or tap. |
| `ooc` | Like casual, with Edit/Delete always shown. |

Character avatars and names are coloured by a hue worked out from the character's name (`hueFor`), so each character keeps the same colour everywhere.

### Writing modes

Layer 2 of the prompt stack, empty until now, holds the current scene's style instructions (`modeInstructions` in `src/prompt.ts`):

- **Literary**: write one prose post, which may include several characters, and end where the user can respond.
- **Casual**: write one to four short messages, each on its own line starting with the character's name and a colon, like `Ilse Marrow: *leans on the doorframe* You're late.`

In casual scenes, layer 3 also names your characters, so your partner doesn't write their lines.

In the history, casual bubbles are sent in the same `Name: text` format, one per line. The model sees who said what, in the same format it's asked to write.

## Bubbles and turns

### Splitting text into bubbles

`splitBubbles` in `src/bubbles.ts` turns a block of text into bubbles. A line starting with a **known** speaker's name or prefix and a colon starts a new bubble; any other line continues the current one. Lines before the first tag belong to a default speaker.

It's used in both directions (see `src/posts.ts`):

| | Speakers | Default speaker |
| --- | --- | --- |
| Your casual post | Your characters, by prefix or name | Whoever is picked in "Posting as" (or you) |
| Your partner's casual reply | The channel's character, by full or first name | The channel's character |

Only known speakers count. `Note: the tide is out` stays as text unless someone is actually called Note, and a web address doesn't start a bubble either.

### Turns

One reply in a casual scene can be several bubbles. They're saved together with a shared `turn_id` (`Store.addTurn`), so the whole reply can be treated as one:

- **Regenerate** replaces every bubble of the last reply (`Store.lastPartnerTurn`), swapping old for new in one transaction.
- Several lines you send at once also share a turn.

Messages from before stage 3 have no turn id; each counts as a turn of its own.

## The database upgrade

Stage 3 adds migration 2 in `src/db.ts`. It uses `ALTER TABLE ... ADD COLUMN`, which adds a column to an existing table and gives every existing row the column's default value:

- `channels.mode` (default `literary`) and `channels.pending_mode`
- `messages.kind` (default `post`), `messages.mode` and `messages.turn_id`
- then it marks every message already in a roleplay channel as `literary`

Your stage 2 data upgrades automatically the first time stage 3 starts. The test `upgrades a stage 2 database, keeping its data` in `test/store.test.ts` checks exactly that.

## API changes

- `POST /api/channels/:id/messages` returns `userMessages` and `partnerMessages` (lists, since a casual post or reply can be several bubbles). It accepts an optional `postingAs` (one of your characters). If the message is `=====` in a roleplay channel, it returns `{ sceneBreak, channel }` instead, and your partner doesn't reply.
- `POST /api/channels/:id/scene-breaks` with an optional `title` adds a scene break and returns `{ sceneBreak, channel }`.
- `POST /api/channels/:id/turn` returns `partnerMessages`.
- `POST /api/channels/:id/regenerate` returns `partnerMessages` and `replacedIds`.
- `PATCH /api/channels/:id` accepts `mode`. `POST /api/channels` accepts `mode` for new roleplay channels.
- `PATCH /api/messages/:id` on a scene break renames it (an empty title is allowed).
- Settings have a new `userCharacters` list.

## Tests

- **`test/posts.test.ts`** (new): splitting bubbles, scene break commands, and turning posts and replies into messages for each mode.
- **`test/store.test.ts`**: the stage 2 → 3 upgrade, mode rules (right away versus waiting for a break), scene breaks, turns, and validation of your characters.
- **`test/prompt.test.ts`**: layer 2 for each mode, your characters in casual scenes, scene breaks and casual bubbles in the history.
- **`test/server.test.ts`**: `=====`, the scene break route, casual posting with proxy tags and "posting as", casual replies split into bubbles, and regenerating a whole casual reply.

## What's next

Stage 3.5 is **themes**: an app theme, per-channel themes, and built-in glass themes. The new classes and variables from this stage (prose, scene breaks, character colours) are listed in [theme-reference.md](theme-reference.md), ready for it.

Stage 4 then adds the **notebook**: characters and lore as entries with owners and permissions, pinned to channels to form the cast. That replaces the single character sheet per channel, and lets a scene have several characters on your partner's side.
