# Aettica

Aettica gives you an AI **RP partner**, not a character: a writer with their own style who plays characters alongside you. The full vision is in [DESIGN.md](DESIGN.md).

**Status: stage 2 of 8.** A Discord-style server of channels with your partner, using models from [nanoGPT](https://nano-gpt.com). How it works inside: [stage 1](docs/stage-1.md) (server, API calls, prompts) and [stage 2](docs/stage-2.md) (database, channels).

## What it can do

- **Channels**: create, rename, reorder and delete them from the sidebar.
  - **Roleplay** channels are storylines. Each has its own character, with a name and a sheet, that your partner plays.
  - **Out-of-character** channels are for talking with your partner as themselves. They know which storylines exist.
- Every message records who wrote it, which character it voices, and which model generated it.
- Edit the **partner prompt** (who your partner is as a writer), the model, temperature, reply length, and how many recent messages the partner sees.
- **Partner's turn**: let your partner write without a new message from you, including opening an empty channel.
- **Stop** a reply that's taking too long. Nothing is saved, and the channel is free again.
- **Regenerate** the partner's last reply, **edit** or **delete** any message.
- **Preview prompt**: see exactly what the model receives on the next turn in a channel.
- Install it to your home screen as an app (PWA).

If you used stage 1, your chat is moved into the `#story` channel automatically the first time stage 2 starts.

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

Everything else (prompt, characters, model and so on) is changed in the app.

## Your data

Everything is saved in an SQLite database, `data/aettica.db`. To back it up, stop the server and copy that file, or copy it together with `aettica.db-wal` and `aettica.db-shm` if the server is running. The `data/` folder and `.env` are never committed to git.

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
  nanogpt.ts   Talks to nanoGPT's API
  db.ts        The database's tables, and upgrading them (migrations)
  store.ts     Reading and writing channels, messages and settings
  legacy.ts    Moving a stage 1 chat into the database
  config.ts    Reads settings from .env
  types.ts     The shapes of channels, messages and settings
public/        The web app (plain HTML, CSS and JavaScript, no build step)
defaults/      Starting partner prompt and character sheet
test/          Tests
docs/          How things work, stage by stage, and the theme reference
```

## Licence

[GNU AGPL v3](LICENSE).
