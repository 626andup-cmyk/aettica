# Channel categories and drag-and-drop

Group your channels into **categories**, like Discord's (say, "Fantasy" and "Sci-fi"), and rearrange everything by dragging.

## Using them

- **Make a category**: **+** (new channel) → **Category** → **New category…**.
- **Put a channel in one**: pick it when you make the channel, choose it in channel settings → **Category**, or drag the channel under the category's header.
- **Fold a category up**: tap its header. A dot on a folded header means something new is inside. The channel you're in stays visible even when its category is folded.
- **Rename or delete a category**: the **⋯** next to its name. Deleting keeps its channels; they move above the categories.
- **Drag to rearrange**:
  - With a mouse, just drag a channel or a category header.
  - On a phone, press and hold for a moment first (so scrolling still works); it buzzes when it picks up.
  - A line shows where it will land. A channel lands in the category whose header is above the line, or in none if it's above all of them. Dragging a header moves the whole category.
- **↑ and ↓** in channel settings still work, and move a channel within its category.

Your partner can use categories too: `create_channel` takes a `category`, and `move_channel` can move a channel into a category (or out, with "none"). A category they name that doesn't exist yet is made. In OOC, their list of channels says which category each is in.

## How it works

- Channels are ordered together (`position`), and each has a `categoryId` (or none). The sidebar shows the channels outside any category first, then each category in its own order, with its channels in order.
- A drag sends the whole new order and the moved channel's new category in one request, applied in one transaction: never half-moved. The app shows the move straight away, and takes the server's answer when it comes. If saving fails, it reloads.
- The sidebar isn't redrawn mid-drag (by a live update, say), so the channel never disappears from under your finger.
- Dragging is done with pointer events rather than the browser's built-in drag-and-drop, which doesn't work on phones. On touch, a press has to be held for 450 ms without moving; moving sooner is a scroll. While dragging, the list doesn't scroll under your finger, but it scrolls itself near its top and bottom edges.

## Where it's stored

Migration 13 in `src/db.ts` adds `categories` (name, position, and whether it's folded up), and a `category_id` on channels. Deleting a category sets its channels' `category_id` back to none.

## API

- `POST /api/categories` with `name`.
- `PUT /api/categories/order` with `ids`: every category, in the new order.
- `PATCH /api/categories/:id` with `name` and/or `collapsed`.
- `DELETE /api/categories/:id`: its channels stay, outside any category.
- `POST /api/channels` and `PATCH /api/channels/:id` take `categoryId` (or `null`).
- `PUT /api/channels/order` takes `ids`, and optionally `categories`: `{channelId: categoryId or null}` for channels that moved between categories.
- `GET /api/state` includes `categories`.

## Tests

`test/categories.test.ts`:

- making, renaming, folding and reordering categories;
- channels going in and out, and deleting a category;
- a drag (order plus category) applied all at once, or not at all;
- your partner's tools, including making categories by name;
- the OOC prompt;
- the API.

Dragging with a mouse (a channel into a category, and a category above another) and with a finger (press, hold and drag) was checked in a real browser, as was folding. The tap on a category header no longer closes the sidebar on a phone: only opening a channel does.
