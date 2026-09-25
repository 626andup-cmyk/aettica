# Aettica

Aettica gives you an AI **RP partner**, not a character: a writer with their own style who plays characters alongside you. The full vision is in [DESIGN.md](DESIGN.md).

**Status: stage 1 of 8.** One chat with your partner, who plays one character, using a model from [nanoGPT](https://nano-gpt.com). See [docs/stage-1.md](docs/stage-1.md) for how it works inside.

## What stage 1 can do

- Chat with your partner in a single `#story` channel.
- Edit the **partner prompt** (who your partner is as a writer) and the **character sheet** (who they play) from the settings panel.
- Choose the model, temperature, reply length, and how many recent messages the partner sees.
- **Partner's turn**: let your partner write without a new message from you, including opening an empty story.
- **Regenerate** the partner's last reply, **edit** or **delete** any message.
- **Preview prompt**: see exactly what the model receives on the next turn.
- Install it to your home screen as an app (PWA).

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
| `DATA_DIR` | `./data` | Where your chat is saved |
| `NANOGPT_BASE_URL` | `https://nano-gpt.com/api/v1` | API address (only change this for testing) |
| `REQUEST_TIMEOUT_SECONDS` | `180` | How long to wait for a reply before giving up |

Everything else (prompt, character, model and so on) is changed in the app's settings panel.

## Your data

Your chat and settings are saved in `data/chat.json`. It's plain JSON, so you can read it, and you can back it up by copying the file. The `data/` folder and `.env` are never committed to git.

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
  store.ts     Saves the chat to data/chat.json
  config.ts    Reads settings from .env
  types.ts     The shapes of messages, settings and the save file
public/        The web app (plain HTML, CSS and JavaScript, no build step)
defaults/      Starting partner prompt and character sheet
test/          Tests
docs/          Explanations of how things work
```

## Licence

[GNU AGPL v3](LICENSE).
