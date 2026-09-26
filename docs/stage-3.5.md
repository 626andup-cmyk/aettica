# Stage 3.5: how themes work

Stage 3.5 adds **themes**: an app theme, per-channel themes, built-in glass themes, and a way to make your own. According to [DESIGN.md](../DESIGN.md), its new concepts are **theme files**, **CSS variables** and **scoping**.

## What you can do now

- **Pick an app theme** from **Appearance** (the palette button at the bottom of the channel list). It applies straight away. Four are built in:
  - **Classic**: the original dark, Discord-like look.
  - **Frutiger Aero**: blue sky, green hills, bubbles, glossy gel buttons.
  - **Aero Glass**: Windows 7 style tinted glass over a glowing blue swirl.
  - **Liquid Glass**: clear, bright-edged glass over vivid colour, with floating panels and capsule buttons.

  Added since: **Rainy Window** (a night city through a rainy window), and **Liquid Glass Dark** (dark glass over neon). Both Liquid Glass themes now refract what's behind them for real, like Apple's; see [Liquid glass](theme-reference.md#liquid-glass-real-refraction) in the theme reference.
- **Give a channel its own theme** in channel settings → Theme. It changes only that channel (its messages, header, composer and background), never the channel list or dialogs.
- **Make your own theme**: in Appearance, pick a theme and press **Copy to edit**. The copy opens in the theme editor, where you can change its CSS, add images and fonts, and press **Apply** to see the result. Copying Classic starts you off with every setting and its default value.
- **Choose glass effects for this device**: Automatic, Full or Lite. Lite turns off the real blur, which is the expensive part, in favour of more solid panels. Automatic starts with Full and switches to Lite on its own if scrolling stutters.

## Concept 1: theme files

A theme is a folder:

```
themes/frutiger-aero/        built-in themes, shipped with Aettica
data/themes/my-aero/         your themes, next to your database
  theme.json                 name, description, preview colours
  theme.css                  the theme itself
  theme-lite.css             optional: the Lite version
  sky.svg                    images and fonts it uses
```

`src/themes.ts` holds the `ThemeLibrary`, which lists, copies, edits and deletes themes, and serves their files at `/themes/<id>/<file>`. Built-in themes can be copied but not changed. Your copy is yours to edit, and because it lives in `data/`, it's backed up with the rest of your data.

The built-in wallpapers are SVG files: pictures described as shapes and gradients rather than pixels. They're a few kilobytes each and sharp on any screen.

### Serving theme files safely

- Only images, fonts and the theme's CSS are served, with file names checked so a request can't reach anything outside the theme's folder.
- Every theme file is sent with `X-Content-Type-Options: nosniff` and `Content-Security-Policy: script-src 'none'`, so an SVG image can never run a script, even if opened on its own.
- Relative `url(...)`s in a theme's CSS are rewritten to full paths (`url(sky.svg)` becomes `url("/themes/my-aero/sky.svg")`). Browsers can resolve relative URLs inside CSS variables against the wrong place, and the rewrite removes that trap.
- Uploaded files arrive as base64 text inside JSON, so every request that changes something is still JSON, keeping the protection from [stage 1](stage-1.md) against other websites using your server.

## Concept 2: CSS variables

Since stage 2, every colour, border, blur, radius and font in `public/style.css` has been a CSS variable (a *token*) in its `:root` block, and the rest of the stylesheet only uses those tokens. A theme is loaded after the base stylesheet, so redefining a token changes it everywhere it's used:

```css
:root {
  --accent: #1aa0e8;
  --sidebar-bg: rgb(255 255 255 / 0.6);
  --sidebar-backdrop: blur(14px) saturate(160%);
  --app-background: url(sky.svg) center / cover;
}
```

A theme can also style anything else directly: the glass themes add glossy highlights with `.surface::before`, and Liquid Glass reshapes the header into a floating capsule. [theme-reference.md](theme-reference.md) lists every token and class.

### Lite versions

Real glass (`backdrop-filter: blur(...)`) is the most expensive thing a phone can be asked to draw, and it has to be redrawn on every frame while you scroll. A theme's `theme-lite.css` is loaded **on top of** its `theme.css` in Lite mode. Usually it just turns the blur off and makes panels more solid, so text stays readable over the wallpaper.

In **Automatic** mode, the page times the frames the first few times you scroll the message list (`watchForStutter` in `public/app.js`). After about 90 frames or 2.5 seconds of scrolling, if a typical frame took longer than 28 ms (fewer than about 35 frames a second), it switches this device to Lite and says so. The choice is stored in the browser's `localStorage`, because it's about this device, not your server. Your phone and a computer can differ.

## Concept 3: scoping

A theme is written for the whole page. Used as a **channel theme**, it has to stay inside the channel. CSS has a rule for exactly that, **`@scope`**, and the server rewrites the theme when it serves it (`scopeToChannel`):

```css
@scope (.channel-view) {
  :scope { /* every token reset to its default */ }
  :scope { color: var(--text); font: ...; background: var(--app-background); }
  :scope > .messages { background: var(--channel-background); }

  /* ...the theme's own CSS, with :root, html and body turned into :scope... */
}
```

- Inside `@scope (.channel-view)`, a rule like `.message { ... }` only matches messages in the channel, and `.sidebar { ... }` matches nothing at all.
- `:scope` means the channel view itself, so `:root { --accent: ... }` becomes `:scope { --accent: ... }`: the token changes only inside the channel.
- **The reset comes first**: every token is set back to its default before the theme's own values, so a channel theme looks the same whatever the app theme is.
- **The channel becomes a window into its theme**: the theme's wallpaper fills the channel, and its `--channel-background` tint goes behind the messages.
- Rules that aren't allowed inside `@scope` (`@font-face`, `@keyframes`, `@import`) are moved outside it. They define fonts and animations but don't style anything, so that's harmless.

The rewriting works on the text of the CSS: it walks through it, skipping strings and comments, and changes only selectors, never values. So `content: "body"` or a class like `.bodyish` is left alone.

### The other half: the app theme, minus the channel

A channel theme should *replace* the app theme inside its channel, but the app theme can do more than set tokens. Liquid Glass, for example, turns the channel header into a floating capsule. So while the open channel has its own theme, the app theme is served in a second rewritten form, `outside.css` (`scopeOutsideChannel`):

```css
@scope (:root) to (.channel-view) {
  /* ...the app theme... */
}
```

This is a **"donut scope"**: it starts at the top of the page and stops at the channel view, so the app theme applies everywhere *except* the channel. Together the two files split the page cleanly: the app theme outside the channel, the channel theme inside it.

### Which files are loaded

`index.html` has four theme `<link>`s after `style.css`, filled in by `applyThemes` in `public/app.js`:

| Link | Normally | When the open channel has its own theme |
| --- | --- | --- |
| `theme-app` | `/themes/<app>/theme.css` | `/themes/<app>/outside.css` |
| `theme-app-lite` | `.../theme-lite.css` (Lite mode only) | `.../outside-lite.css` |
| `theme-channel` | nothing | `/themes/<channel>/channel.css` |
| `theme-channel-lite` | nothing | `.../channel-lite.css` (Lite mode only) |

Classic is the base stylesheet itself, so as the app theme it loads nothing. When a stylesheet changes, the new one loads alongside the old one before the old is removed, so the page doesn't flash unstyled. The last app theme is also remembered on the device and applied straight away on the next visit, before the server has answered.

## Where things are stored

| What | Where |
| --- | --- |
| Built-in themes | `themes/` in the project |
| Your themes | `data/themes/` |
| The app theme | the `appTheme` setting |
| A channel's theme | `channels.theme` (migration 3 in `src/db.ts`), `NULL` for "same as the app" |
| Glass effects | this device's browser (`localStorage`) |

Deleting a theme you made puts everything that used it back to the default: the app theme to Classic, and channels to the app theme.

## API

- `GET /api/themes`: every theme, for the picker.
- `POST /api/themes` with `name` and `from`: copy a theme into a new one of yours.
- `GET /api/themes/:id`: a theme's CSS, Lite CSS and files, for the editor.
- `PATCH /api/themes/:id` with any of `name`, `description`, `css`, `liteCss`: change one of your themes.
- `DELETE /api/themes/:id`: delete one of your themes. Returns the updated settings and channels.
- `POST /api/themes/:id/files` with `name` and base64 `data`: add an image or font (8 MB at most).
- `DELETE /api/themes/:id/files/:name`: remove one.
- `PUT /api/settings` accepts `appTheme`; `PATCH /api/channels/:id` accepts `theme` (`null` for the app theme).
- Theme files: `GET /themes/<id>/<file>`, including the generated `channel.css`, `channel-lite.css`, `outside.css` and `outside-lite.css`.

## Tests

- **`test/themes.test.ts`** (new): URL rewriting, splitting CSS into statements, both kinds of scoping (including strings and look-alike names being left alone, and fonts being hoisted), and the library: listing, copying, editing, protecting built-ins, file rules, and what's served.
- **`test/server.test.ts`**: choosing app and channel themes, copying, editing and uploading through the API, and deleting a theme that's in use.

The visual parts (each theme on a phone and a computer, channel themes inside other app themes, Lite mode, the editor, and the automatic switch to Lite) were checked in a real browser. The switch was triggered by making every frame deliberately slow.

## What's next

Stage 4 adds the **notebook**: characters and lore as entries with owners, visibility and editing permissions, pinned to channels to form the cast.
