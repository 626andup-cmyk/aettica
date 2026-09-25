# Theme reference

This is the list of things a theme can change. Themes arrive in stage 3.5 (see **Themes** in [DESIGN.md](../DESIGN.md)); until then, this documents how the app is built so they'll work.

A theme is CSS. Most themes only need to redefine the **variables** below. Anything variables can't express, a theme can do by targeting the **classes**.

To try a change today, edit the `:root` block at the top of `public/style.css` and reload.

## Variables

All are defined in the `:root` block of `public/style.css`.

### Type

| Variable | What it sets |
| --- | --- |
| `--font-body` | Main font |
| `--font-heading` | Server name, channel title, dialog titles |
| `--font-mono` | Prompt preview |
| `--font-size`, `--line-height` | Base text size and spacing |

### Text and accents

| Variable | What it sets |
| --- | --- |
| `--text`, `--text-muted`, `--text-strong` | Normal, secondary, and emphasised text |
| `--em-color` | `*italic*` text, i.e. RP actions |
| `--accent`, `--accent-hover`, `--accent-text` | Main highlight colour, its hover shade, text drawn on it |
| `--danger`, `--danger-text` | Delete buttons |
| `--error-bg`, `--error-text` | Error banner and form errors |
| `--user-color`, `--partner-color` | Author name colours |
| `--avatar-user-bg`, `--avatar-partner-bg`, `--avatar-text` | Avatar circles |

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
| `.message` | One message. Has `data-author="user"` or `"partner"`, and `.pending` while being sent. |
| `.avatar`, `.message-meta`, `.message-author`, `.message-badge`, `.message-time`, `.message-model`, `.message-content`, `.message-actions` | Parts of a message |
| `.composer`, `.composer-input`, `.composer-buttons`, `.status`, `.typing-dots`, `.error-banner` | The composer area |
| `.button`, `.button-primary`, `.button-danger`, `.icon-button`, `.link-button` | Buttons |
| `.dialog`, `.dialog-title`, `.dialog-buttons`, `.hint`, `.form-error` | Dialogs and their parts |

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

## Per-channel themes

The channel view has `data-channel-id` and `data-channel-kind`. Stage 3.5 will scope a channel's theme to `.channel-view[data-channel-id="..."]`, so a channel theme sets variables that only apply inside that channel. Because the sidebar is outside the channel view, it keeps the app theme.
