# Stage 6: how tools, approvals and comments work

Stage 6 lets your partner **act**, not just write. According to [DESIGN.md](../DESIGN.md), its new concepts are **tool calling** and **proposals**. It also adds message comments, and a way to attach notebook entries to a message so your partner reads them in full.

## What you can do now

- **Your partner uses tools**, when their profile can: they read and search the notebook, make and edit entries, pin characters, make channels, start scenes, comment on messages, review your suggestions, or choose not to reply at all. What they did shows under their message ("⚙ Arlo read Ilse Marrow, pinned Tamsin to #story"); tap it for the details.
- **Attach notes to a message** with the paperclip, or write `[[Name]]` in it. Attached entries are sent to your partner in full while that message is in the conversation, which is the easy way to make sure they have a character's details when you're talking about them.
- **Comment on messages**: select some text in a message and press 💬 Comment, or use a message's Comment action for the whole message. Comment on your partner's message and they reply in the thread. Your partner can comment too. Threads can be resolved.
- **The inbox** (the tray at the top of the channel list, with a count) has what's waiting for you: your partner's proposals ("Delete #sequel?") and suggested notebook changes, shown as before and after. It also lists your suggestions waiting for them.
- **Test a profile's tool calling** in its editor, and read the **tool log** of any channel (channel settings → Tool log).

## Concept 1: tool calling

A tool is a function the model can ask the app to run. The request lists the tools (name, description, and a JSON schema for the arguments), and instead of, or as well as, writing text, the model can reply with **tool calls**: a tool name and arguments as JSON. The app runs each one and sends the results back, and the model continues.

A turn is a small loop (`toolLoop` in `src/partner.ts`):

1. Ask the model, offering the tools.
2. If it called any, run each one as your partner (so every notebook permission applies, exactly as in [stage 4](stage-4.md)), log it, and send back the result.
3. Repeat until the model replies without calling anything. That text is the post.

A turn has at most six rounds; the last is offered no tools, so it has to write. Calling `do_nothing` ends the turn without a post, and the app says "Arlo chose not to reply". A regeneration that writes nothing keeps the old reply.

Actions take effect as they happen. If you stop a turn after a tool ran, the action stays done, and the log shows it.

### The tools

| Tool | What it does |
| --- | --- |
| `read_notebook_entry` | Reads an entry in full: fields, notes, owner, where it's pinned |
| `search_notebook` | Lists entries, optionally matching a word |
| `create_notebook_entry` | A new character or lore: theirs, or shared; optionally hidden from you, or pinned to this channel |
| `edit_notebook_entry` | Changes fields (merged: new ones added, empty ones removed), notes or name. A suggestion if they may only suggest. |
| `delete_notebook_entry` | Deletes their own entry; for anything else, suggests deleting it |
| `set_entry_visibility` | Hides or reveals their own entry, and sets whether you can edit it |
| `review_suggestion` | Accepts or rejects one of your suggestions |
| `pin_to_channel`, `unpin_from_channel` | Changes a channel's cast |
| `create_channel`, `rename_channel`, `move_channel` | Channels |
| `start_new_scene` | A scene break, with an optional title, before their post (roleplay only) |
| `propose_channel_deletion` | Asks you to approve deleting a channel |
| `comment_on_message`, `reply_to_comment`, `resolve_comment` | Comments |
| `do_nothing` | Doesn't reply |

Things are referred to the way the model sees them: entries by name (a unique part of it is enough), channels by `#name`, and suggestions and comment threads by the short ids shown in the prompt. A tool the model misuses doesn't fail the turn: the result explains the mistake ("There's no notebook entry called "Tamzin". Entries: …"), so the model can try again.

The prompt gets a **Tools** section with a few rules: use tools only when they help, read an entry instead of guessing, never mention tools in the writing, and in roleplay still write the post afterwards. Tools are only offered when the turn's profile has "Can use tools" on.

### What else your partner sees now

Layer 3 of the prompt gains, when there's something to show:

- **Attached notes**: entries attached to messages still in the conversation, in full (unless already there as the cast).
- **Comment threads**: open threads on this channel's messages, with their ids.
- **Waiting for your review**: your suggestions, with what they'd change.
- **What you did recently**: their last few actions here, and how their proposals went ("The user denied your proposal to delete #ooc.").

## Concept 2: proposals

Some actions need your yes first.

- **Notebook changes** go through **suggestions**, from [stage 4](stage-4.md): editing an entry you may only suggest changes to, or shared lore. Your partner now reviews yours with `review_suggestion`, on their next turn with tools.
- **Deleting a notebook entry**: each of you deletes your own entries directly. Deleting the other person's, or shared lore, is a suggestion for the other one to approve.
- **Deleting a channel** is a **proposal**, shown in your inbox as a card. Approving deletes the channel; denying keeps it, and your partner hears which you chose.

Nobody reviews their own suggestion: the reviewer is the entry's owner, or for shared lore, whoever didn't make it.

## Comments

A comment thread belongs to a message and, optionally, a quoted part of it, which is highlighted. Comments are out of character: your partner reads them in the prompt as notes, never as something the characters know.

When you comment on your partner's message, or reply in a thread they're in, your partner takes a **comment turn**: the same turn as always, but the conversation ends with your comment and a request to reply briefly, out of character, and the reply goes into the thread, never into the channel. The channel is busy while they reply, like any turn.

Your partner finds the message to comment on from a quote, the newest message containing it; formatting like `*italics*` is ignored when matching.

## Troubleshooting tool calls

Models on nanoGPT differ a lot in how well they call tools, and the app is built to show you exactly what happened.

1. **Test the profile first.** Settings → Profiles and roulettes → a profile → **Test tools**. It sends one small request asking the model to call a `check_in` tool:
   - **✓ Works**: the model used the API's tool calling. Tools should work well.
   - **~ Works, as text**: the model wrote the call into its reply instead (see below). Aettica can read it, but it's less reliable.
   - **✗ No tool call**: the model ignored the tool. Turn off "Can use tools" for that profile, so it just writes.
   - **✗ Broken arguments**: it tried, but the JSON couldn't be read.
2. **Read the tool log.** Channel settings → **Tool log** lists every call in the channel, newest first: the round, the profile, whether it came through the API or as text, the arguments exactly as the model wrote them, and what it was told back. **Errors only** narrows it down, and **Copy as text** copies it all, to paste somewhere for a closer look.
3. **Watch the server log.** Termux shows a line per call:
   `[tools] #story round 1 (native): pin_to_channel {"name":"Tamsin"} -> ok: pinned Tamsin to #story`
4. **Preview the prompt** (channel settings) to see the Tools section and everything else the model is given.

### What Aettica repairs on its own

`src/toolcalls.ts` handles the common ways models get this wrong:

- **Arguments that aren't quite JSON**: wrapped in ```` ```json ```` fences, with trailing commas, with curly quotes, or encoded twice. These are repaired. Anything else goes back to the model as an error ("The arguments aren't valid JSON: … Call it again with valid JSON arguments."), and the model usually fixes it on the next round.
- **Arguments sent as an object** instead of JSON text, which some providers do.
- **Tool calls written as text.** Some models, or providers that don't translate them, put the call in the reply in the model's own format. Three are recognised, and removed from the text so they never show up in a post:
  - `<tool_call>{"name": …, "arguments": {…}}</tool_call>` (Qwen, GLM, Hermes-style)
  - `<|tool_call_begin|>functions.name:0<|tool_call_argument_begin|>{…}<|tool_call_end|>` (Kimi)
  - `<｜tool▁call▁begin｜>function<｜tool▁sep｜>name ```json {…} ```<｜tool▁call▁end｜>` (DeepSeek)

  Their results go back as a "(Tool results)" note, since there's no API call id to answer.
- **A model that won't stop calling tools** is cut off after six rounds and made to write.

### Common problems

| You see | Likely cause | Try |
| --- | --- | --- |
| Tool calls show as raw text in a post | A format Aettica doesn't recognise | Copy the tool log and the post; the format can be added to `extractTextToolCalls` |
| "didn't call the tool" in the test | The model doesn't support tools on nanoGPT | Turn off "Can use tools" for that profile |
| Errors like "no notebook entry called …" | The model guessed a name | Usually fixes itself next round; the error lists the real names |
| The model narrates its tool use ("I'll check the notebook…") | A chatty model | Add to the profile's model notes: "Never mention tools." |
| Actions but no post | The model had nothing more to say after acting | Press Partner's turn, or use model notes to insist on a post |
| Nothing happens and the turn times out | A slow model thinking through several rounds | Raise `REQUEST_TIMEOUT_SECONDS`, or use a faster profile |

## Where things are stored

Migration 6 in `src/db.ts` adds four tables:

| Table | Holds |
| --- | --- |
| `tool_calls` | Every call: channel, turn, round, name, arguments as written, result, ok or error, summary, native or text, profile |
| `comments` | Comments, in threads. A thread's first comment holds the quote and whether it's resolved. |
| `proposals` | Proposals (deleting a channel): target, reason, pending, approved or denied |
| `message_attachments` | Which notebook entries are attached to which messages |

A tool call shares its turn id with the messages that turn wrote, which is how the app shows actions under the right message. Tool calls go when their channel does; comments and attachments go when their message does.

## API

- `GET /api/channels/:id/messages` now also returns `toolCalls` and `threads`.
- Turn responses (`/messages`, `/turn`, `/regenerate`) return `toolCalls`, `skipped`, and the channels (a turn can change them).
- `POST /api/channels/:id/messages` takes `attach`: entry ids to attach. `[[Name]]` links in the text are attached too. An entry hidden from your partner can't be attached.
- `GET /api/channels/:id/tool-log`: every call in a channel.
- `POST /api/profiles/:id/test`: the tool calling test.
- `POST /api/messages/:id/comments` with `note` and optional `quote`; `POST /api/comments/:id/replies`; `POST /api/comments/:id/resolve` (with `resolved: false` to reopen); `DELETE /api/comments/:id`. Responses include the thread and, if your partner replied, their turn.
- `GET /api/proposals`; `POST /api/proposals/:id/approve` or `/deny`.
- Suggestions in `GET /api/notebook` now say who reviews them (`reviewer`).

## Tests

- **`test/toolcalls.test.ts`** (new): repairing arguments, and each text format.
- **`test/tools.test.ts`** (new): every tool against a real store: its effect, permissions as your partner, hidden entries staying hidden, and mistakes explained.
- **`test/server.test.ts`**: the whole loop against a fake nanoGPT that returns tool calls: calls then a post, tools only for capable profiles, text-format calls, broken arguments retried, `do_nothing`, the round limit, regenerating into nothing, the tool test's verdicts, attached notes and `[[links]]`, comment replies, and approving and denying proposals.
- **`test/notebook.test.ts`**, **`test/permissions.test.ts`**: each of you deletes your own entries; deleting others' is a suggestion.

The app itself (actions under messages, the tool log, the tool test, the inbox, comments with highlights and replies, and attaching notes) was checked in a real browser against a scripted fake model that calls tools, on a phone-sized and a desktop-sized screen.

## What's next

Stage 7 adds **scene summaries and the server digest**, so long stories fit in the context and OOC knows what's happening everywhere.
