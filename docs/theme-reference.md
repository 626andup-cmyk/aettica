# Theme reference

This is everything a theme can change. How themes are stored, loaded and scoped is explained in [stage-3.5.md](stage-3.5.md).

A theme is CSS. Most themes only need to redefine the **variables** below. Anything variables can't express, a theme can do by targeting the **classes**.

## Making a theme

1. Open **Appearance** (the palette button at the bottom of the channel list).
2. Pick the theme closest to what you want and press **Copy to edit**. Copying **Classic** gives you every variable below with its default value.
3. Change values in the editor and press **Apply** to see the result behind the editor. **Save** keeps it and closes the editor.
4. To use an image or font, add it under **Images and fonts**, then refer to it by name: `--app-background: url(sky.jpg) center / cover;`. Fonts go in an `@font-face` rule, which works in channel themes too.
5. For phones, add a **Lite version**: CSS loaded on top of the theme when glass effects are Lite. Usually it turns blur off (`--sidebar-backdrop: none;` and the other `*-backdrop` variables) and makes panels more solid.

Your theme is a folder in `data/themes/`, so you can also edit it there with any text editor.

### As a channel theme

Any theme can be a channel's own theme (channel settings → Theme). Then:

- Write the theme as usual, with `:root` and all. Aettica rewrites it so it only applies inside the channel: `:root`, `html` and `body` become the channel view, and rules for things outside it (like `.sidebar`) simply match nothing.
- Every variable starts from its default, not from the app theme, so the channel looks the same whatever the app theme is.
- The channel shows the theme's `--app-background`, with its `--channel-background` tint behind the messages.
- The app theme doesn't reach into a channel with its own theme, so layout changes it makes (floating panels, shapes) stay outside.

## Variables

All are defined in the `:root` block of `public/style.css`.

### Type

| Variable | What it sets |
| --- | --- |
| `--font-body` | Main font |
| `--font-heading` | Server name, channel title, dialog titles |
| `--font-mono` | Prompt preview |
| `--font-size`, `--line-height` | Base text size and spacing |
| `--font-prose`, `--prose-size`, `--prose-line-height` | Literary posts |
| `--prose-max-width` | How wide a literary post's lines can get |

### Text and accents

| Variable | What it sets |
| --- | --- |
| `--text`, `--text-muted`, `--text-strong` | Normal, secondary, and emphasised text |
| `--em-color` | `*italic*` text, i.e. RP actions |
| `--accent`, `--accent-hover`, `--accent-text` | Main highlight colour, its hover shade, text drawn on it |
| `--danger`, `--danger-text` | Delete buttons |
| `--error-bg`, `--error-text` | Error banner and form errors |
| `--update-bg` | The "Aettica has been updated" banner |
| `--user-color`, `--partner-color` | Author name colours |
| `--avatar-user-bg`, `--avatar-partner-bg`, `--avatar-text` | Avatar circles |
| `--avatar-saturation`, `--avatar-lightness` | Character avatars. Each character's hue comes from their name (`--avatar-hue`, set by the app); these set the rest of the colour. |
| `--name-saturation`, `--name-lightness` | Character names, in the same hue as their avatar |
| `--scene-break-line`, `--scene-break-text`, `--scene-break-font` | Scene break dividers |

### Shape

| Variable | What it sets |
| --- | --- |
| `--radius-sm`, `--radius-md`, `--radius-lg` | Rounded corners: small (channel links, badges), medium (inputs, buttons), large (dialogs) |
| `--radius-avatar` | Avatar shape (`50%` is a circle) |

### Backgrounds and panels

Every `*-bg` can be a colour, gradient or image. Every `*-backdrop` is a [`backdrop-filter`](https://developer.mozilla.org/docs/Web/CSS/backdrop-filter), which is how glass effects blur what's behind a panel (for example `blur(16px) saturate(1.4)`). They default to `none`.

| Variable | What it sets |
| --- | --- |
| `--app-background` | Behind everything: the wallpaper |
| `--sidebar-width` | Sidebar width on large screens |
| `--sidebar-bg`, `--sidebar-border`, `--sidebar-shadow`, `--sidebar-backdrop` | The channel sidebar |
| `--drawer-bg` | The sidebar when it slides over the channel on a phone (defaults to `--sidebar-bg`). Glass themes usually make this more solid. |
| `--sidebar-footer-bg` | The partner card at the bottom of the sidebar |
| `--channel-link-color`, `--channel-link-hover-bg`, `--channel-link-active-bg`, `--channel-link-active-color` | Channel links |
| `--channel-background` | Behind the open channel, on top of the wallpaper |
| `--header-bg`, `--header-border`, `--header-shadow`, `--header-backdrop` | The channel header |
| `--message-hover-bg` | A message under your finger or mouse |
| `--composer-bg`, `--composer-border`, `--composer-backdrop` | The area around the text box |
| `--dialog-bg`, `--dialog-border`, `--dialog-shadow`, `--dialog-backdrop` | Dialogs |
| `--scrim` | The dark layer behind dialogs and the phone sidebar |
| `--code-bg` | Prompt preview blocks |

### Controls

| Variable | What it sets |
| --- | --- |
| `--input-bg`, `--input-border`, `--input-focus-border` | Text boxes |
| `--button-bg`, `--button-hover-bg`, `--button-text`, `--button-border`, `--button-shadow` | Ordinary buttons |
| `--button-primary-bg`, `--button-primary-hover-bg`, `--button-primary-text` | Send, Save, Create |
| `--icon-button-hover-bg` | Round icon buttons (gear, +, ☰) |

## Classes

| Class | Element |
| --- | --- |
| `.app` | Everything. Gets `.sidebar-open` when the phone drawer is open. |
| `.surface` | Any panel a glass theme might blur: sidebar, channel header, composer, dialogs |
| `.sidebar`, `.sidebar-header`, `.sidebar-footer`, `.sidebar-scrim` | The sidebar and its parts |
| `.server-name` | "Aettica" at the top of the sidebar |
| `.channel-list`, `.channel-link`, `.channel-link-name`, `.channel-icon`, `.channel-busy` | The channel list. The open channel's link has `aria-current="page"`; each link has `data-kind="rp"` or `"ooc"`. |
| `.partner-card`, `.partner-card-name`, `.partner-card-role` | Your partner at the bottom of the sidebar |
| `.channel-view` | The open channel. Has `data-channel-id` and `data-channel-kind`. |
| `.channel-header`, `.channel-title`, `.channel-topic` | The bar at the top of the channel |
| `.messages` | The scrolling message list |
| `.message` | One message. Has `data-author="user"` or `"partner"`, and `data-mode="literary"`, `"casual"` or `"ooc"`. Also `.pending` while being sent, `.continued` when grouped under the message before it, `.has-character` when it voices a character (with `--avatar-hue` set on it), and `.selected` when a casual bubble is tapped. |
| `.scene-break`, `.scene-break-title`, `.scene-break-actions` | Scene break dividers. The lines either side are `.scene-break::before` and `::after`. |
| `.avatar`, `.message-meta`, `.message-author`, `.message-badge`, `.message-time`, `.message-model`, `.message-content`, `.message-actions` | Parts of a message |
| `.composer`, `.composer-input`, `.composer-buttons`, `.status`, `.typing-dots`, `.stop-button`, `.error-banner` | The composer area |
| `.posting-as-row`, `.posting-as`, `.scene-button` | "Posting as" in casual scenes, and the ⁂ new scene button |
| `.update-banner` | "Aettica has been updated", at the top of the channel |
| `.button`, `.button-primary`, `.button-danger`, `.icon-button`, `.link-button` | Buttons |
| `.dialog`, `.dialog-title`, `.dialog-buttons`, `.hint`, `.form-error` | Dialogs and their parts |
| `.theme-list`, `.theme-card`, `.theme-swatch`, `.theme-name`, `.theme-badge`, `.theme-description` | The theme picker in Appearance. The chosen card has `aria-checked="true"`. |
| `.theme-editor`, `.code-input`, `.theme-files` | The theme editor |
| `.notebook`, `.notebook-actions`, `.notebook-list`, `.notebook-folder`, `.notebook-folder-header`, `.notebook-folder-name` | The notebook dialog and its folders |
| `.notebook-entries`, `.notebook-entry`, `.notebook-entry-name`, `.notebook-entry-badges`, `.entry-badge` | Entries in the notebook. Each `.notebook-entry` has `data-kind` (`character` or `lore`) and `data-owner` (`user`, `partner` or `joint`). |
| `.entry-avatar` | A character's or lore's round badge, in its own colour (`--avatar-hue`). Has `data-kind`. |
| `.suggestion-list`, `.suggestion-title`, `.suggestion`, `.suggestion-text` | Suggested changes waiting for review. Each `.suggestion` has `data-author`. |
| `.entry-editor`, `.entry-access`, `.entry-fields`, `.entry-field`, `.entry-field-label`, `.entry-field-value`, `.entry-field-remove`, `.add-field` | The entry editor and its fields |
| `.entry-links`, `.entry-links-label`, `.entry-link` | The entry's `[[links]]`. A link to a name that isn't in the notebook also has `.missing`. |
| `.entry-settings` | The entry's settings (owner, visibility, editing, folder) |
| `.cast-list`, `.cast-member`, `.cast-member-name`, `.cast-unpin`, `.cast-add` | The cast in channel settings. Each `.cast-member` has `data-played-by` (`user`, `partner` or `both`) and `data-kind`, and `.hidden-entry` for "??? (hidden)". |
| `.inbox-button`, `.inbox-count` | The inbox button at the top of the channel list, and its count |
| `.activity`, `.activity-summary`, `.activity-details` | A turn's actions under its messages. `.activity` gets `.has-errors` if a call failed. |
| `.tool-call`, `.tool-call-head`, `.tool-call-name`, `.tool-call-summary`, `.tool-call-raw` | One tool call, in the activity details and the tool log. Has `data-status` (`ok` or `error`) and `data-source` (`native` or `text`). |
| `.tool-log`, `.tool-log-list`, `.tool-log-actions` | The tool log dialog |
| `.profile-list`, `.profile-row`, `.profile-row-name`, `.roulette-entries`, `.roulette-entry`, `.roulette-share` | Profiles and roulettes |
| `.tool-test-row`, `.tool-test` | "Test tools" and its result, which has `data-verdict` (`native`, `text`, `none` or `broken`) |
| `.inbox`, `.inbox-list`, `.inbox-section`, `.inbox-card`, `.inbox-card-title`, `.inbox-card-text`, `.inbox-card-buttons` | The inbox |
| `.suggestion-diff`, `.diff-before`, `.diff-after` | A suggestion's before and after |
| `.comment-mark` | Highlighted text with a comment on it (`.resolved` once resolved) |
| `.message-comments` | The 💬 count under a message with comments |
| `.comment-float` | The Comment button that appears when you select text in a message |
| `.thread`, `.thread-picker`, `.thread-quote`, `.thread-comments`, `.thread-comment`, `.thread-comment-author`, `.thread-comment-note`, `.thread-status` | The comments dialog. Each `.thread-comment` has `data-author`. |
| `.attach-row`, `.attach-chip`, `.message-attachments`, `.attach-list`, `.attach-option`, `.attach-button` | Attached notes: above the text box, under messages, and the picker |
| `.theme-layers`, `.layer-1` to `.layer-4` | Empty layers for themes to draw on (see Layers below) |
| `.channel-indicator` | A pill behind the open channel's link, hidden unless a theme shows it (see Liquid glass below). Gets `.stretching`, then `.settling`, as it moves between channels. |
| `.theme-options`, `.theme-option-group`, `.theme-option`, `.theme-option-label`, `.theme-option-value` | Sliders in Appearance |
| `.check-option`, `.check-inline`, `.section-title`, `.advanced` | Checkboxes, section headings and "advanced" details in dialogs |
| `.notice-banner` | Short notices at the top of the channel, e.g. about glass effects |

## Sliders (theme options)

A theme can offer sliders in Appearance, each setting a CSS variable its CSS uses. Declare them in the theme's `theme.json`, or in the theme editor under **Sliders**:

```json
"options": [
  { "id": "bubble-transparency", "label": "Bubble transparency", "variable": "--bubble-transparency",
    "min": 0, "max": 0.95, "step": 0.05, "default": 0.55 },
  { "id": "bubble-blur", "label": "Bubble blur", "variable": "--bubble-blur",
    "min": 0, "max": 30, "step": 1, "default": 14, "unit": "px" }
]
```

- `id`: lowercase letters, digits and dashes. `variable`: the CSS variable, starting with `--`.
- `unit` (optional): `px`, `em`, `rem`, `%`, `deg`, `s` or `ms`, added after the number. Without one, the variable is a plain number, which works inside `calc()`: `rgb(0 0 0 / calc(1 - var(--bubble-transparency)))`.
- Give each variable its default in your `:root` block too, so the theme also looks right before the app applies the sliders.
- The app sets the app theme's variables on `<html>`, and a channel theme's on `.channel-view`, where they win over the theme's own values. Up to 12 sliders per theme.

**Rainy Window** is a worked example of sliders, layers (below) and parallax: its layers drift with the message list's scrolling through a scroll-driven animation (`scroll-timeline` on `.messages`, `timeline-scope` on `body`). The Liquid Glass themes and Rainy Window have sliders for their refraction (see Liquid glass below).

## Layers

For backgrounds with depth (a picture, rain, drifting fog), the page has empty elements for themes to draw on:

```html
<div class="theme-layers"><i class="layer-1"></i><i class="layer-2"></i><i class="layer-3"></i><i class="layer-4"></i></div>
```

One set is behind the whole app (a child of `<body>`), and one is in the channel view, for a channel theme. They're hidden until a theme shows them, and the channel view's only appear when the channel has its own theme. A typical start:

```css
body { position: relative; isolation: isolate; overflow: hidden; }
.theme-layers { display: block; position: absolute; inset: 0; z-index: -1; overflow: hidden; }
.theme-layers > * { position: absolute; inset: 0; }
.layer-1 { background: url(far.svg) center / cover; }
```

`isolation` keeps the layers behind the app's content but in front of the page's background. As a channel theme, `body` becomes the channel view, so the same CSS works there. Rainy Window uses all four: the city, rain falling outside, drops on the glass (each showing the city upside down, cut out with a `mask`), and drops sliding down (an animated SVG).

## Free layers for glass effects

Glass themes usually stack several layers on a panel: the blurred backdrop, a glossy highlight across the top, and a soft glow at the edges. The backdrop comes from the `*-backdrop` variables. For the other two, **elements with the `surface` class never use `::before` or `::after` in the base stylesheet**, so a theme can add them freely:

Every surface is already positioned, so these layers can use `position: absolute` without the theme touching layout. Each surface is also its own layer stack (`isolation: isolate`), so `z-index: -1` puts a layer above the panel's background but below its text and buttons:

```css
/* A glossy highlight across the top half of every glass panel. */
.surface::before {
  content: "";
  position: absolute;
  inset: 0 0 50% 0;
  background: linear-gradient(rgb(255 255 255 / 0.35), transparent);
  border-radius: inherit;
  pointer-events: none;
  z-index: -1;
}
```

## Liquid glass (real refraction)

A blur makes glass look frosted, but flat. Real glass is clear, and its thick, rounded edge works like a lens: what's behind bends as it nears the rim, and splits into a faint rainbow there. `public/glass.js` does that for a theme, in Chrome and other Chromium browsers (including on Android). **Liquid Glass**, **Liquid Glass Dark** and **Rainy Window** use it.

Turn it on in your `:root`, then mark which elements are lensed glass:

```css
:root {
  --lensing: on;
  --lens-depth: 26;        /* how far the rim bends what's behind, in px (default 24) */
  --lens-bevel: 20;        /* how wide the curved rim is at least, in px (default 18) */
  --lens-dispersion: 0.4;  /* how much the colours split at the rim, 0 to 1 (default 0.3) */
  --lens-frost: 0.5;       /* a blur behind the glass, in px (default 0: clear) */
  --lens-saturate: 1.35;   /* colour boost through the glass (default 1.2) */
}

.message, .surface, .button, .icon-button { --lens: 1; }
```

- `--lens` doesn't inherit, so only the elements you name are lensed, not everything inside them. glass.js looks at these classes: `.surface`, `.message`, `.button`, `.icon-button`, `.channel-indicator`, `.theme-card`, `.inbox-card`, `.attach-chip`, `.message-comments`, `.posting-as`, `.composer-input`, `.profile-row`, `.notebook-entry`.
- The tuning variables can be set anywhere, so a slider can drive them: `--lens-depth: var(--refraction)`.
- A deeper lens needs a wider rim, so the rim grows with the depth (as far as the element's size allows). The very edge magnifies up to about 3.3 times.
- Keep a normal `backdrop-filter` on the same elements (e.g. `blur(10px) saturate(160%)`): it's what other browsers show, and what Lite mode shows, since Lite turns lensing off.
- Glass inside other glass (a button in the composer) isn't lensed. A panel with a backdrop filter only lets the elements in it see its own fill, not the page behind, so there'd be nothing to bend. It keeps your `backdrop-filter`.
- **A lensed element gets the class `lensed`, and must not reach outside its own box**: no outer `box-shadow` (on it, or on anything inside it) while it's lensed. Chrome versions disagree about where a backdrop filter goes when an element's shadow spills over its edges (some move it by the shadow's size, some don't), so on some phones the lens would miss the right and bottom edges. Keep your floating shadows for other browsers and Lite, and drop them under `.lensed`:

```css
.message { box-shadow: var(--glass-rim), 0 14px 34px -12px rgb(0 0 0 / 0.3); }
.lensed { box-shadow: var(--glass-rim) !important; }
```
- **Don't move your theme layers with `transform`** (not even a static one): Chrome doesn't give a lens the full picture of a transformed layer, and cuts part of it off behind the rims. For parallax, animate `background-position` instead. Both Liquid Glass themes do. Rainy Window, whose layers also need masks and several backgrounds to move together, animates registered custom properties (`@property --near { syntax: "<length>"; ... }`) and uses them in each `background-position` and `mask-position`:

```css
@keyframes drift {
  from { background-position-y: calc(50% + 5vh); }
  to { background-position-y: calc(50% - 5vh); }
}
```

- **What it costs.** The lens itself is cheap: a bubble growing as your partner writes only moves the pieces of its map, and nothing is recalculated while you scroll. The browser redraws the glass every frame something behind it moves, though, and two settings multiply that work: rainbow edges (`--lens-dispersion` above 0) take three passes instead of one, and frost (`--lens-frost`) adds a blur. For the smoothest glass, set rainbow edges to 0 and keep frost at 0.5px or less (a hint of blur is free, and smooths the magnified rim).

glass.js also provides two things for liquid themes, in every browser:

- **Goo** (`filter: url(#aettica-goo)`): shapes that touch merge like drops of water. Both Liquid Glass themes use it on `.typing-dots`.
- **The channel indicator** (`.channel-indicator`, in style.css and app.js): a pill that sits behind the open channel's link and flows to the next one when you switch, stretching over both links (`.stretching`) and then settling with a little overshoot (`.settling`). It's hidden unless a theme gives it `display: block`, a background and a `transition: transform ...`.

## Hooks for theme authors

- `.channel-view` has `data-channel-id`, `data-channel-kind` (`rp` or `ooc`) and `data-channel-theme` (the channel's own theme, or empty). An app theme can use these, e.g. `.channel-view[data-channel-kind="ooc"] { ... }` to style OOC channels differently.
- Every `.surface` is positioned and isolated (see above), so `::before` and `::after` layers can use `position: absolute` and `z-index: -1` safely.
