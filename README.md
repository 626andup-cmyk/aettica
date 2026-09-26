# Aettica

Aettica gives you an AI **RP partner**, not a character: a writer with their own style who plays characters alongside you. The full vision is in [DESIGN.md](DESIGN.md).

**Status: stage 7 of 8.** A Discord-style server of channels with your partner, with scenes, literary or casual styles, themes, a shared notebook of characters and lore, a mix of models, and a partner who can act through tools, using models from [nanoGPT](https://nano-gpt.com). How it works inside: [stage 1](docs/stage-1.md) (server, API calls, prompts), [stage 2](docs/stage-2.md) (database, channels), [stage 3](docs/stage-3.md) (scenes, modes), [stage 3.5](docs/stage-3.5.md) (themes), [stage 4](docs/stage-4.md) (the notebook and permissions), [stage 5](docs/stage-5.md) (connection profiles and roulettes), [stage 6](docs/stage-6.md) (tools, approvals, comments, and troubleshooting tool calls) and [stage 7](docs/stage-7.md) (summaries and the server digest).

## What it can do

- **Channels**: create, rename, reorder and delete them from the sidebar.
  - **Roleplay** channels are storylines. Each has its own cast: characters and lore pinned from the notebook.
  - **Out-of-character** channels are for talking with your partner as themselves. They know which storylines exist.
- **Notebook** (the book button): characters and lore, with labelled fields, notes for your partner, and `[[links]]` between entries.
  - Each entry is yours, your partner's, or shared. Your partner plays their characters, you play yours, and either of you can play shared ones.
  - You choose whether your partner can see each of your entries, and whether they can edit it, only suggest changes, or only read it. Folders pass these settings to the entries in them.
  - Your partner's secrets show as "??? (hidden)" in a cast: they know, you don't (yet).
- **Scenes**: type `=====` (or `===== Title`) or press ⁂ to start a new scene. Scenes are divided by a titled line.
- **Long stories**: your partner reads the newest messages in full and remembers the rest through summaries: of each scene when it ends (press **Summary** under a scene break), the story so far, and a line or two per channel that OOC reads. Read and edit them in channel settings → Memory. Summaries are written only from the messages, so nothing hidden from you is ever in them.
- **Two styles** per roleplay channel. A change of style waits for the next scene, so a scene never mixes them.
  - **Literary**: your partner writes prose posts, shown as wide blocks of text.
  - **Casual**: short in-character bubbles, one character each, like a group chat. You post as your own characters (from the notebook) with proxy tags (`k: *waves*`) or the "Posting as" menu, like Tupperbox.
- Every message records who wrote it, which character it voices, and which profile and model generated it.
- Edit the **partner prompts**: who your partner is (used everywhere), and how they write in literary scenes, in casual scenes, and out of character. Each channel only gets the one for its own kind, so OOC chat stays short even if your literary style is long. Also how many recent messages the partner sees.
- **Connection profiles and roulettes** (Settings → Profiles and roulettes): a profile is a model with its settings and its own "model notes"; a roulette picks one of several profiles at random each turn, by weight. Choose what writes roleplay and OOC, and override it per channel.
- **Your partner acts**, if their profile can use tools: they read the notebook, make and edit entries, pin characters, make channels, start scenes, comment on messages, review your suggestions, or choose not to reply. What they did shows under their message. Each profile has a **Test tools** button, and each channel a **tool log**, for when a model gets it wrong.
- **Attach notes** to a message with the paperclip, or write `[[Name]]` in it: your partner gets those entries in full.
- **Comments**: select text in a message to comment on it; your partner replies in the thread.
- **Inbox** (the tray at the top of the channel list): your partner's proposals and suggested changes, to approve or reject.
- **Partner's turn**: let your partner write without a new message from you, including opening an empty channel.
- **Stop** a reply that's taking too long. Nothing is saved, and the channel is free again.
- **Regenerate** the partner's last reply (or **Regenerate with…** a particular profile), **edit** or **delete** any message.
- **Preview prompt**: see exactly what the model receives on the next turn in a channel.
- **Themes**: pick one in Appearance (the palette button). Classic, Frutiger Aero, Aero Glass, Liquid Glass, Liquid Glass Dark and Rainy Window (a night city through a window of raindrops that slide down and drift as you scroll, with glossy liquid glass bubbles) are built in. The Liquid Glass themes and Rainy Window's bubbles are real refracting glass, like Apple's: what's behind bends and splits into rainbows at the edges of each pane (in Chrome, including on Android). Themes can offer sliders in Appearance, like Rainy Window's bubble transparency or Liquid Glass's refraction. Any channel can have its own theme, and you can copy a theme and edit its CSS and images right in the app. Glass effects can be Full, Lite (easier on the phone) or Automatic. See the [theme reference](docs/theme-reference.md).
- Install it to your home screen as an app (PWA).

If you used stage 1, your chat is moved into the `#story` channel automatically the first time stage 2 starts. Characters from before stage 4 are moved into the notebook automatically.

## Running it

You need [Bun](https://bun.sh) and a nanoGPT API key.

```sh
# 1. Get the code and install the development tools (only needed for tests and type checking)
git clone https://github.com/626andup-cmyk/aettica.git
cd aettica
bun install

# 2. Add your API key
cp .env.example .env
#    then edit .env and set NANOGPT_API_KEY=...

# 3. Start the server
bun start
```

Then open <http://127.0.0.1:3000> in your browser.

### On your phone (Termux)

The server is designed to run in [Termux](https://termux.dev) on the phone you chat from:

1. Install Bun inside Termux. If the installer from bun.sh doesn't work on your phone, run it inside a Linux environment set up with `proot-distro` instead.
2. Follow the steps above, then run `bun start` and leave Termux open.
3. Open <http://127.0.0.1:3000> in Chrome, then choose **menu → Add to Home screen** (or **Install app**). Aettica now opens like an app.

The app only works while the server is running. If it says it can't connect, start the server in Termux again.

### Settings in `.env`

| Variable | Default | What it does |
| --- | --- | --- |
| `NANOGPT_API_KEY` | none (required) | Your nanoGPT API key |
| `HOST` | `127.0.0.1` | Where the server listens. The default means only this device can connect. |
| `PORT` | `3000` | Port for the web app |
| `DATA_DIR` | `./data` | Where your data is saved |
| `NANOGPT_BASE_URL` | `https://nano-gpt.com/api/v1` | API address (only change this for testing) |
| `REQUEST_TIMEOUT_SECONDS` | `180` | How long to wait for a reply before giving up |

Everything else (prompt, model, characters and so on) is changed in the app.

## Your data

Everything is saved in the `data/` folder: your chat and settings in an SQLite database, `data/aettica.db`, and your own themes in `data/themes/`. To back up, stop the server and copy the whole `data/` folder. (While the server is running, the database's recent changes are also in `aettica.db-wal` and `aettica.db-shm`, so copy those too.) The `data/` folder and `.env` are never committed to git.

Aettica has no login. Keep `HOST` at `127.0.0.1` so that nobody else on your Wi-Fi can open your chat.

## Development

```sh
bun run dev        # start the server, restarting whenever a file changes
bun test           # run the tests (they use a fake nanoGPT, so no key or credit is needed)
bun run typecheck  # check the TypeScript types
```

Project layout:

```
src/
  server.ts    HTTP server: API routes and serving the web app
  partner.ts   The one "partner takes a turn" function
  prompt.ts    Builds the prompt stack sent to the model
  posts.ts     Turns text into messages: posts, replies, scene breaks
  tools.ts     Your partner's tools: what each does, run as your partner
  toolcalls.ts Reading tool calls, including broken or written-as-text ones
  profiles.ts  Connection profiles and roulettes
  activity.ts  The tool log, comment threads, and proposals
  summaries.ts Summaries: storing them, splitting scenes, what the prompt still needs
  summarizer.ts  Writes summaries in the background as channels change
  notebook.ts  The notebook: entries, folders, suggestions and each channel's cast
  permissions.ts  Who can see, edit and manage each notebook entry
  sheets.ts    Reads a plain-text character sheet into labelled fields
  bubbles.ts   Splits casual text into one-character bubbles
  themes.ts    Themes: storing, editing, serving and scoping them
  nanogpt.ts   Talks to nanoGPT's API
  db.ts        The database's tables, and upgrading them (migrations)
  store.ts     Reading and writing channels, messages and settings
  errors.ts    Errors the server turns into 404, 400 and 403 answers
  legacy.ts    Moving a stage 1 chat into the database
  config.ts    Reads settings from .env
  types.ts     The shapes of channels, messages and settings
public/        The web app (plain HTML, CSS and JavaScript, no build step)
themes/        Built-in themes (Classic, Frutiger Aero, Aero Glass, Liquid Glass, Liquid Glass Dark, Rainy Window)
defaults/      Starting partner prompts and character sheet
test/          Tests
docs/          How things work, stage by stage, and the theme reference
```

## Licence

[GNU AGPL v3](LICENSE).
