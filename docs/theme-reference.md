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
| `.notice-banner` | Short notices at the top of the channel, e.g. about glass effects |

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

## Hooks for theme authors

- `.channel-view` has `data-channel-id`, `data-channel-kind` (`rp` or `ooc`) and `data-channel-theme` (the channel's own theme, or empty). An app theme can use these, e.g. `.channel-view[data-channel-kind="ooc"] { ... }` to style OOC channels differently.
- Every `.surface` is positioned and isolated (see above), so `::before` and `::after` layers can use `position: absolute` and `z-index: -1` safely.
