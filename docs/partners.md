# Partners and servers

You can have as many partners as you like. **Each partner is a different person with their own memory**, and each usually has **a server of their own**, like having a Discord server with each friend. A server can also hold several partners.

## Using them

- **The rail** on the far left has one button per server; tap one to go there. A dot means a partner there has written something you haven't seen. **+** makes a new server with a new partner.
- **A new partner**: give them a name, an avatar (an emoji) and who they are, or press **🎲 Surprise me** to invent someone. They start fresh: their own notebook, channels (#story and #ooc) and memory. They get your connection profiles and roulettes, and your preferences: models, Jev, reaching out, the heartbeat, texting and the look. They don't get the other partner's identity, prompts or anything they remember.
- **The partner menu**: tap the partner card at the bottom of the sidebar. It holds their name, avatar and colour, who they are (with Surprise me to reroll), how they write in literary, casual and OOC channels, and texting. Their avatar and colour show on their messages, the partner card and the rail.
- **Server settings**: tap the server's name at the top of the sidebar, or its button in the rail. You can rename it, see who's there, **add a partner here**, or delete it.
- **Several partners in one server**: the sidebar shows each partner's channels under their name and avatar. Each channel belongs to one partner: they're the one who writes there, and only they know what's in it. Opening another partner's channel switches to them, and the partner card, notebook and settings become theirs. From a partner's menu, **Own server** moves them out into a server of their own.
- **Deleting** a partner (their menu → Delete…, typing their name to confirm) or a server moves their files to `data/trash/`, not away for good. You can't delete your last partner.
- Phone notifications open the right partner's channel.

## Separate memory, by construction

Each partner is a complete Aettica of their own (`src/hub.ts`). They have their own database and folder, so their own:

- notebook, including their secrets, suggestions and pins;
- channels, categories, messages, comments, reactions and tool log;
- summaries and the notebook keeper;
- idea drawer, wake-ups, heartbeat and Jev log;
- reference library and custom emojis;
- settings and prompts.

Nothing is shared between partners except your own themes and the connection profiles you choose to copy when making one. So no partner can ever see another's notebook, secrets or conversations: there's no code path between them to get it wrong. When two partners share a server, only the sidebar puts them side by side, and each one's prompt only ever contains their own channels.

## How it works

The server runs a **hub** in front of one app per partner:

| Request | Goes to |
| --- | --- |
| `/p/<partner>/api/...` and `/p/<partner>/emojis/...` | That partner's app |
| `/api/hub/...` | The hub: servers and partners |
| Anything else (the web app, themes, and `/api/...` from older pages) | The first partner's app |

The page works on one partner at a time. Its requests are prefixed with that partner (`scoped` in `public/app.js`), and the address says whose channel is open: `#/p/<partner>/channel/<id>`. Switching partners (another server in the rail, another partner's channel, a notification) reloads the page as theirs. Every 15 seconds the page also asks the hub for every partner's channels and newest messages, for the dots in the rail and the other partners' sections.

### The data folder

```
data/
  hub.json          the servers and their partners
  aettica.db        your first partner (where Aettica always kept its data)
  emojis/           their custom emojis
  themes/           your own themes, shared by everyone
  partners/<id>/    each other partner: aettica.db, emojis/
  trash/            deleted partners
```

Upgrading changes nothing: the existing database becomes the first partner, in the first server. To back up, stop the server and copy the whole `data/` folder.

### The hub's API

- `GET /api/hub`: the servers. Each has its partners, and each partner comes with their name, avatar, colour, channels, categories, each channel's newest message, and where they're writing.
- `POST /api/hub/servers` with `name`, and optionally `prompt`, `avatar`, `color`, `serverName` and `copyFrom` (the partner whose profiles and preferences to copy): a new server with a new partner.
- `POST /api/hub/servers/:id/partners` (same fields): a new partner in that server.
- `PATCH /api/hub/servers/:id` with `name`, and/or `partners` (a new order).
- `PUT /api/hub/servers/order` with `ids`.
- `DELETE /api/hub/servers/:id`: the server and its partners (to the trash).
- `DELETE /api/hub/partners/:id`: one partner (to the trash).
- `POST /api/hub/partners/:id/move` with `serverId`, or nothing for a server of their own.

Each partner's app has the same API as before. Its new settings are `partnerAvatar` (an emoji, or "" for their initial) and `partnerColor` (a hue from 0 to 359, or -1 for the theme's).

## Tests

`test/hub.test.ts`:

- starting fresh, and upgrading an existing data folder;
- routing;
- a new partner with copied profiles and preferences but their own identity and a clean slate;
- a partner never seeing another's notebook, messages or prompt;
- several partners in one server, reordering them, and moving one out;
- renaming and reordering servers, kept after a restart;
- deleting to the trash (including the first partner), and the last one can't go;
- bad input.

In a real browser, on desktop and phone sizes: the rail; the partner menu (avatar and colour); a new server from Surprise me; adding a partner to a server, with both sections in the sidebar; and switching by another partner's channel and by the rail.
