# Emoji reactions and custom emojis

You and your partner can react to messages with emojis, like on Discord, and use **custom emojis** (your own images, as `:name:`).

## Using them

- **React**: press **React** under a message and pick an emoji, a custom one, or type any emoji. Reactions show as chips under the message, with a count. Tap a chip to add yours, or take it back. Yours have an outline in the accent colour; hover (or long-press) to see who reacted.
- **Your partner reacts too**, with a tool (on profiles that can use tools): a 😂 on your joke, a ❤️ on your news. It shows in the channel as their action ("⚙ Arlo reacted 😂 to "also I adopted a cat"").
- **They see yours**: your partner's prompt has a **Reactions** section listing reactions on the recent messages, in both directions ("The user reacted ❤️ 🔥 to your message: ..."). It's quiet feedback on what landed.
- **Custom emojis**: from the picker, **Custom emojis…**. Add a PNG, GIF (animated too), JPEG or WebP of up to 512 KB with a name like `blob_wave`. Use it as a reaction, or write `:blob_wave:` in any message to show the image. Your partner sees the name, and can use it in their messages and reactions.

## How it works

`src/reactions.ts`:

- A reaction is a message, an author (you or your partner) and an emoji. Each of you can put up to 6 different emojis on a message, once each.
- An emoji is either **one Unicode emoji** (one grapheme that's pictographic, a flag or a keycap, so `👩🏽‍💻` and `🇯🇵` count and `👍👍` doesn't), or `:name:` of a custom emoji that exists.
- Messages come with their reactions (`Message.reactions`, oldest first). Adding or removing one bumps the store's revision, so an open app notices your partner's reactions within 15 seconds.
- Deleting a message deletes its reactions. Deleting a custom emoji deletes the reactions with it.

### Your partner's tool

| Tool | Does |
| --- | --- |
| `react_to_message` | `emoji`, and optionally `quote` (a few words from the message). Without a quote, it reacts to your latest message in the channel. Mistakes are explained, with the custom emojis there are |

With tools, the prompt's Reactions section also lists the custom emojis they can use.

### Custom emoji files

Images are saved in the data folder's `emojis/` folder, and served at `/emojis/<file>` with long caching. Each upload gets a new file name, so replacing an emoji's image never shows a stale one. The type is checked from the file's first bytes, not its name, and names are 2 to 32 lowercase letters, digits or underscores. There can be up to 300.

## Where it's stored

Migration 11 in `src/db.ts`:

| Table | Holds |
| --- | --- |
| `reactions` | One row per reaction: the message, the author, the emoji, and when |
| `custom_emojis` | Each custom emoji's name and image file |

## API

- `POST /api/messages/:id/reactions` with `emoji`: add your reaction, or take it back if it's there. Returns the message's reactions.
- `GET /api/emojis`: the custom emojis (also in `GET /api/state` as `emojis`).
- `POST /api/emojis` with `name` and `data` (the image, base64): add one, or replace the image of one with that name.
- `DELETE /api/emojis/:name`: delete one.

## Tests

`test/reactions.test.ts`:

- what counts as an emoji;
- adding, toggling and limits;
- the revision, and deleting a message;
- custom emojis (adding, replacing, serving, deleting with their reactions, and the checks on names, types and sizes);
- the tool (your latest message or a quoted one, and its mistakes);
- the prompt, with and without tools;
- the API.

The chips, the picker and the custom emoji manager were checked in a real browser on a phone-sized screen.
