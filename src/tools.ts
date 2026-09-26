/**
 * Your partner's tools (stage 6): how they act, not just write.
 *
 * Each tool is a name, a description the model reads, a JSON schema for its
 * arguments, and a `run` function. The model asks for a tool; `runTool`
 * checks the arguments, runs it *as your partner* (so every notebook
 * permission applies, exactly as in src/permissions.ts), and returns:
 *
 *   - `result`: what the model is told, as JSON. Errors are results too
 *     ("No notebook entry called ..."), so the model can correct itself.
 *   - `summary`: a short line for people, shown under the message and in
 *     the tool log ("pinned Tamsin to #story").
 *
 * Things refer to each other by name, the way the model sees them: entries
 * by name, channels by `#name`, and comment threads and suggestions by the
 * short ids shown in the prompt. Your partner deletes only their own
 * notebook entries; deleting anything else is a suggestion, and deleting a
 * channel is a proposal you approve or deny.
 *
 * "Do nothing" is always an option, and usually the right one.
 */

import { NotFoundError, PermissionError, ValidationError } from "./errors.ts";
import type { EntryView } from "./notebook.ts";
import type { ToolSpec } from "./nanogpt.ts";
import type { Store } from "./store.ts";
import type { Channel, EntryField, Owner } from "./types.ts";

/** Where a tool runs: the channel of the turn, and what kind of turn. */
export interface ToolContext {
  store: Store;
  channel: Channel;
  /** `"post"` for a normal turn; `"comment"` when replying to a comment thread. */
  mode: "post" | "comment";
}

/** What running a tool produced. */
export interface ToolOutcome {
  ok: boolean;
  /** Sent back to the model. */
  result: unknown;
  /** For people. For errors, the error. */
  summary: string;
  /** `do_nothing`: end the turn without writing. */
  stop?: boolean;
}

/** A mistake in how the model used a tool, explained to it. */
class ToolError extends Error {}

interface ToolDefinition {
  name: string;
  description: string;
  /** JSON schema for the arguments object. */
  parameters: Record<string, unknown>;
  /** Whether the tool is offered in this context (default: always). */
  available?: (ctx: ToolContext) => boolean;
  run: (ctx: ToolContext, args: Record<string, unknown>) => Omit<ToolOutcome, "ok"> & { ok?: boolean };
}

// ------------------------------------------------------------------ helpers

function object(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

const str = (description: string) => ({ type: "string", description });

/** A required text argument. */
function need(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") throw new ToolError(`"${key}" is required, as text.`);
  return value.trim();
}

/** An optional text argument. */
function maybe(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new ToolError(`"${key}" must be text.`);
  return value.trim();
}

const norm = (s: string) => s.trim().toLowerCase();

/**
 * Find an entry your partner can see by name: exact (ignoring case) first,
 * then a unique partial match. Otherwise explain, listing names.
 */
function findEntry(store: Store, name: string): EntryView {
  const entries = store.notebook.listEntries("partner");
  const wanted = norm(name.replace(/^\[\[|\]\]$/g, ""));
  const exact = entries.find((e) => norm(e.name) === wanted);
  if (exact) return exact;
  const partial = entries.filter((e) => norm(e.name).includes(wanted) || wanted.includes(norm(e.name)));
  if (partial.length === 1) return partial[0]!;
  const names = (partial.length > 1 ? partial : entries).map((e) => e.name).slice(0, 40);
  throw new ToolError(
    partial.length > 1
      ? `"${name}" matches several entries: ${names.join(", ")}. Use the full name.`
      : `There's no notebook entry called "${name}". Entries: ${names.join(", ") || "(none)"}.`,
  );
}

/** Find a channel by name (`#story` or `story`); empty or "here" is the current one. */
function findChannel(ctx: ToolContext, name: string | undefined): Channel {
  if (!name || ["here", "this", "this channel", "current"].includes(norm(name))) return ctx.store.getChannel(ctx.channel.id);
  const wanted = norm(name.replace(/^#/, ""));
  const channels = ctx.store.listChannels();
  const match = channels.find((c) => norm(c.name) === wanted);
  if (match) return match;
  throw new ToolError(`There's no channel called #${wanted}. Channels: ${channels.map((c) => `#${c.name}`).join(", ")}.`);
}

/** How your partner sees an entry's owner. */
function whose(owner: Owner): string {
  return owner === "partner" ? "yours" : owner === "joint" ? "shared" : "the user's";
}

/**
 * Fields from the model: an object of label → value. Changes are merged
 * into the existing fields: a new label is added, an empty value (or null)
 * removes that field, others are left alone.
 */
function mergeFields(current: EntryField[], input: unknown): EntryField[] {
  if (Array.isArray(input)) {
    // A full list of {label, value}: taken as it is.
    return input.map((f) => ({ label: String(f?.label ?? ""), value: String(f?.value ?? "") }));
  }
  if (typeof input !== "object" || input === null) throw new ToolError('"fields" must be an object, like {"Age": "34"}.');
  const fields = current.map((f) => ({ ...f }));
  for (const [label, value] of Object.entries(input)) {
    const index = fields.findIndex((f) => norm(f.label) === norm(label));
    if (value === null || value === "") {
      if (index >= 0) fields.splice(index, 1);
    } else if (index >= 0) {
      fields[index]!.value = String(value);
    } else {
      fields.push({ label, value: String(value) });
    }
  }
  return fields;
}

/** Text with *asterisks*, underscores and spacing removed, for finding quotes. */
function plain(text: string): string {
  return text.replace(/[*_]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** "#story" */
const hash = (c: Channel) => `#${c.name}`;

// -------------------------------------------------------------------- tools

const TOOLS: ToolDefinition[] = [
  // ------------------------------------------------------------ reading
  {
    name: "read_notebook_entry",
    description:
      "Read a notebook entry (a character or lore) in full: its fields, notes and links. Use it whenever a character or place comes up that you need details on.",
    parameters: object({ name: str("The entry's name.") }, ["name"]),
    run: ({ store }, args) => {
      const entry = findEntry(store, need(args, "name"));
      const channels = new Map(store.listChannels().map((c) => [c.id, hash(c)]));
      return {
        result: {
          name: entry.name,
          kind: entry.kind,
          owner: whose(entry.owner),
          hidden_from_user: entry.owner === "partner" && entry.settings.visibility === "hidden",
          you_can: { direct: "edit it", suggest: "suggest changes", none: "only read it" }[entry.access.edit],
          fields: Object.fromEntries(entry.fields.filter((f) => f.value.trim()).map((f) => [f.label, f.value])),
          notes: entry.systemPrompt,
          pinned_in: entry.pinnedIn.map((id) => channels.get(id)).filter(Boolean),
        },
        summary: `read ${entry.name}`,
      };
    },
  },
  {
    name: "search_notebook",
    description: "List notebook entries, optionally only those whose name or text contains a word.",
    parameters: object({ query: str("Optional word to look for.") }),
    run: ({ store, channel }, args) => {
      const query = maybe(args, "query");
      const entries = store.notebook
        .listEntries("partner")
        .filter((e) => !query || plain([e.name, e.systemPrompt, ...e.fields.map((f) => f.value)].join(" ")).includes(plain(query)));
      return {
        result: entries.slice(0, 50).map((e) => ({
          name: e.name,
          kind: e.kind,
          owner: whose(e.owner),
          pinned_here: e.pinnedIn.includes(channel.id),
          about: e.fields.find((f) => f.value.trim())?.value.slice(0, 120) ?? "",
        })),
        summary: query ? `searched the notebook for "${query}"` : "looked through the notebook",
      };
    },
  },

  // ----------------------------------------------------------- writing
  {
    name: "create_notebook_entry",
    description:
      "Make a new notebook entry: a character you'll play, or lore. It's yours unless you share it. You can keep it hidden from the user as a secret.",
    parameters: object(
      {
        kind: { type: "string", enum: ["character", "lore"] },
        name: str("Its name."),
        fields: { type: "object", description: 'Labelled details, like {"Age": "34", "Appearance": "..."}.' },
        notes: str("Notes for yourself on how to write or use it."),
        shared: { type: "boolean", description: "Share it with the user (either of you can then play or edit it by suggestion)." },
        hidden_from_user: { type: "boolean", description: "Keep it secret from the user (only for entries that aren't shared)." },
        pin_here: { type: "boolean", description: "Also pin it to this channel's cast." },
      },
      ["kind", "name"],
    ),
    run: ({ store, channel }, args) => {
      const shared = args.shared === true;
      if (shared && args.hidden_from_user === true) throw new ToolError("Shared entries can't be hidden.");
      const entry = store.notebook.createEntry("partner", {
        kind: args.kind,
        name: need(args, "name"),
        owner: shared ? "joint" : "partner",
        ...(args.fields !== undefined ? { fields: mergeFields([], args.fields) } : {}),
        systemPrompt: maybe(args, "notes") ?? "",
        ...(args.hidden_from_user === true ? { visibility: "hidden" } : {}),
      });
      if (args.pin_here === true) store.notebook.pin("partner", channel.id, entry.id);
      return {
        result: { created: entry.name, pinned_here: args.pin_here === true },
        summary: `made ${entry.name} (${entry.kind}${shared ? ", shared" : ""}${args.hidden_from_user === true ? ", hidden" : ""})`,
      };
    },
  },
  {
    name: "edit_notebook_entry",
    description:
      "Change a notebook entry. Fields you give are added or updated; give a field an empty value to remove it. If you may only suggest changes (shared lore, or the user's entries), this sends the user a suggestion instead.",
    parameters: object(
      {
        name: str("The entry to change."),
        new_name: str("A new name, if renaming."),
        fields: { type: "object", description: 'Fields to add or change, like {"Age": "35"}.' },
        notes: str("New notes, replacing the old ones."),
      },
      ["name"],
    ),
    run: ({ store }, args) => {
      const entry = findEntry(store, need(args, "name"));
      const change: Record<string, unknown> = {};
      const newName = maybe(args, "new_name");
      if (newName) change.name = newName;
      if (args.fields !== undefined) change.fields = mergeFields(entry.fields, args.fields);
      if (args.notes !== undefined) change.notes = args.notes;
      if (Object.keys(change).length === 0) throw new ToolError("Nothing to change: give new_name, fields or notes.");
      const outcome = store.notebook.editEntry("partner", entry.id, {
        name: change.name,
        fields: change.fields,
        systemPrompt: change.notes,
      });
      return "suggestion" in outcome
        ? {
            result: { suggested: true, note: "The user will review your suggestion." },
            summary: `suggested a change to ${entry.name}`,
          }
        : { result: { edited: outcome.entry.name }, summary: `edited ${entry.name}` };
    },
  },
  {
    name: "delete_notebook_entry",
    description:
      "Delete a notebook entry. Your own entries are deleted at once; for the user's entries or shared lore, this sends the user a suggestion to delete it instead.",
    parameters: object({ name: str("The entry.") }, ["name"]),
    run: ({ store }, args) => {
      const entry = findEntry(store, need(args, "name"));
      const outcome = store.notebook.deleteEntry("partner", entry.id);
      return "deleted" in outcome
        ? { result: { deleted: entry.name }, summary: `deleted ${entry.name}` }
        : { result: { suggested: true, note: "The user will review it." }, summary: `suggested deleting ${entry.name}` };
    },
  },
  {
    name: "set_entry_visibility",
    description:
      "Hide one of your own entries from the user, or reveal it. You can also set whether the user may edit it, only suggest changes, or only read it.",
    parameters: object(
      {
        name: str("One of your entries."),
        visibility: { type: "string", enum: ["visible", "hidden"] },
        user_can: { type: "string", enum: ["edit", "suggest", "read"], description: "What the user may do with it." },
      },
      ["name"],
    ),
    run: ({ store }, args) => {
      const entry = findEntry(store, need(args, "name"));
      const editing = { edit: "open", suggest: "suggest", read: "locked" }[String(args.user_can ?? "")];
      if (args.user_can !== undefined && !editing) throw new ToolError('"user_can" must be edit, suggest or read.');
      store.notebook.updateEntrySettings("partner", entry.id, {
        ...(args.visibility !== undefined ? { visibility: args.visibility } : {}),
        ...(editing ? { editing } : {}),
      });
      const what = args.visibility === "visible" ? "revealed" : args.visibility === "hidden" ? "hid" : "changed who can edit";
      return { result: { done: true }, summary: `${what} ${entry.name}` };
    },
  },
  {
    name: "review_suggestion",
    description: "Accept or reject a suggestion waiting for your review, by its id.",
    parameters: object(
      { id: str("The suggestion's id."), decision: { type: "string", enum: ["accept", "reject"] } },
      ["id", "decision"],
    ),
    run: ({ store }, args) => {
      const id = norm(need(args, "id"));
      const waiting = store.notebook.waitingFor("partner").filter((s) => s.id.toLowerCase().startsWith(id));
      if (waiting.length !== 1) throw new ToolError(`No suggestion "${id}" is waiting for you.`);
      const decision = args.decision === "accept" ? "accepted" : args.decision === "reject" ? "rejected" : null;
      if (!decision) throw new ToolError('"decision" must be accept or reject.');
      const suggestion = waiting[0]!;
      const name = store.notebook.getEntry("partner", suggestion.entryId).name;
      store.notebook.reviewSuggestion("partner", suggestion.id, decision);
      return { result: { done: decision }, summary: `${decision} the user's suggestion for ${name}` };
    },
  },

  // --------------------------------------------------------------- cast
  {
    name: "pin_to_channel",
    description: "Add a notebook entry to a channel's cast (this channel unless you name another).",
    parameters: object({ name: str("The entry."), channel: str("Optional: another channel, like #story.") }, ["name"]),
    run: (ctx, args) => {
      const entry = findEntry(ctx.store, need(args, "name"));
      const channel = findChannel(ctx, maybe(args, "channel"));
      ctx.store.notebook.pin("partner", channel.id, entry.id);
      return { result: { pinned: entry.name, channel: hash(channel) }, summary: `pinned ${entry.name} to ${hash(channel)}` };
    },
  },
  {
    name: "unpin_from_channel",
    description: "Take a notebook entry out of a channel's cast (this channel unless you name another). It stays in the notebook.",
    parameters: object({ name: str("The entry."), channel: str("Optional: another channel.") }, ["name"]),
    run: (ctx, args) => {
      const entry = findEntry(ctx.store, need(args, "name"));
      const channel = findChannel(ctx, maybe(args, "channel"));
      ctx.store.notebook.unpin("partner", channel.id, entry.id);
      return { result: { unpinned: entry.name, channel: hash(channel) }, summary: `unpinned ${entry.name} from ${hash(channel)}` };
    },
  },

  // ----------------------------------------------------------- channels
  {
    name: "create_channel",
    description: "Make a new channel: a roleplay storyline, or an out-of-character chat.",
    parameters: object(
      {
        name: str("Its name, without #."),
        kind: { type: "string", enum: ["roleplay", "ooc"] },
        style: { type: "string", enum: ["literary", "casual"], description: "For roleplay: prose posts, or chat bubbles." },
        cast: { type: "array", items: { type: "string" }, description: "For roleplay: notebook entries to pin." },
      },
      ["name", "kind"],
    ),
    run: ({ store }, args) => {
      const kind = args.kind === "ooc" ? "ooc" : args.kind === "roleplay" || args.kind === "rp" ? "rp" : null;
      if (!kind) throw new ToolError('"kind" must be roleplay or ooc.');
      const cast = Array.isArray(args.cast) ? args.cast.map((n) => findEntry(store, String(n))) : [];
      const channel = store.createChannel({
        name: need(args, "name").replace(/^#/, ""),
        kind,
        ...(kind === "rp" && (args.style === "literary" || args.style === "casual") ? { mode: args.style } : {}),
      });
      for (const entry of cast) store.notebook.pin("partner", channel.id, entry.id);
      return { result: { created: hash(channel) }, summary: `made ${hash(channel)}` };
    },
  },
  {
    name: "rename_channel",
    description: "Rename a channel.",
    parameters: object({ channel: str("The channel, like #story."), new_name: str("Its new name.") }, ["channel", "new_name"]),
    run: (ctx, args) => {
      const channel = findChannel(ctx, need(args, "channel"));
      const renamed = ctx.store.updateChannel(channel.id, { name: need(args, "new_name").replace(/^#/, "") });
      return { result: { renamed: hash(renamed) }, summary: `renamed ${hash(channel)} to ${hash(renamed)}` };
    },
  },
  {
    name: "move_channel",
    description: "Move a channel up or down the channel list.",
    parameters: object(
      { channel: str("The channel."), position: { type: "integer", description: "Its new place: 1 is the top." } },
      ["channel", "position"],
    ),
    run: (ctx, args) => {
      const channel = findChannel(ctx, need(args, "channel"));
      const ids = ctx.store.listChannels().map((c) => c.id).filter((id) => id !== channel.id);
      const position = Math.min(Math.max(Math.round(Number(args.position) || 1), 1), ids.length + 1);
      ids.splice(position - 1, 0, channel.id);
      ctx.store.reorderChannels(ids);
      return { result: { moved: hash(channel), position }, summary: `moved ${hash(channel)} to place ${position}` };
    },
  },
  {
    name: "start_new_scene",
    description: "End the current scene and start a new one, with an optional title. Your post then opens the new scene.",
    parameters: object({ title: str("Optional scene title.") }),
    available: (ctx) => ctx.channel.kind === "rp" && ctx.mode === "post",
    run: ({ store, channel }, args) => {
      const title = maybe(args, "title") ?? "";
      store.addSceneBreak(channel.id, "partner", title.slice(0, 200));
      return { result: { done: true }, summary: title ? `started a new scene, "${title}"` : "started a new scene" };
    },
  },
  {
    name: "propose_channel_deletion",
    description:
      "Ask the user to approve deleting a channel and everything in it. You can't delete a channel yourself; the user sees your proposal and decides.",
    parameters: object({ channel: str("The channel, like #old-story."), reason: str("Why, in a sentence.") }, ["channel"]),
    run: (ctx, args) => {
      const channel = findChannel(ctx, need(args, "channel"));
      ctx.store.proposals.propose("delete_channel", channel.id, channel.name, maybe(args, "reason") ?? "");
      return { result: { proposed: true, note: "The user will approve or deny it." }, summary: `proposed deleting ${hash(channel)}` };
    },
  },

  // ----------------------------------------------------------- comments
  {
    name: "comment_on_message",
    description:
      "Leave an out-of-character comment on a recent message in this channel, on a phrase you quote from it: a reaction, a continuity note, or a note on your own post. The characters never see it.",
    parameters: object(
      { quote: str("A few words copied exactly from the message."), note: str("Your comment.") },
      ["quote", "note"],
    ),
    run: ({ store, channel }, args) => {
      const quote = need(args, "quote");
      const wanted = plain(quote);
      const message = store
        .getMessages(channel.id)
        .filter((m) => m.kind === "post")
        .reverse()
        .find((m) => plain(m.content).includes(wanted));
      if (!message) throw new ToolError(`No recent message in this channel contains "${quote}". Quote a few words exactly.`);
      const thread = store.comments.start("partner", message.id, need(args, "note"), quote);
      return { result: { commented: true, thread: thread.id.slice(0, 8) }, summary: `commented on "${quote.slice(0, 60)}"` };
    },
  },
  {
    name: "reply_to_comment",
    description: "Reply in a comment thread, by the thread's id.",
    parameters: object({ thread: str("The thread's id."), note: str("Your reply.") }, ["thread", "note"]),
    run: ({ store, channel }, args) => {
      const thread = threadIn(store, channel, need(args, "thread"));
      store.comments.reply("partner", thread.id, need(args, "note"));
      return { result: { replied: true }, summary: `replied to a comment on "${thread.quote.slice(0, 60)}"` };
    },
  },
  {
    name: "resolve_comment",
    description: "Mark a comment thread as resolved, by its id, once it's dealt with.",
    parameters: object({ thread: str("The thread's id.") }, ["thread"]),
    run: ({ store, channel }, args) => {
      const thread = threadIn(store, channel, need(args, "thread"));
      store.comments.resolve(thread.id);
      return { result: { resolved: true }, summary: `resolved a comment thread on "${thread.quote.slice(0, 60)}"` };
    },
  },

  // -------------------------------------------------------------- nothing
  {
    name: "do_nothing",
    description: "Don't reply this time. Choose this when there's genuinely nothing you want to say or do.",
    parameters: object({ reason: str("Optional: why, for your own record.") }),
    run: (_ctx, args) => ({
      result: { done: true },
      summary: maybe(args, "reason") ? `chose not to reply (${maybe(args, "reason")})` : "chose not to reply",
      stop: true,
    }),
  },
];

function threadIn(store: Store, channel: Channel, id: string) {
  try {
    return store.comments.findInChannel(channel.id, id);
  } catch {
    throw new ToolError(`There's no comment thread "${id}" in this channel.`);
  }
}

// -------------------------------------------------------------------- API

/** The tools offered in a context, in the API's format. */
export function toolSpecs(ctx: ToolContext): ToolSpec[] {
  return TOOLS.filter((t) => t.available?.(ctx) ?? true).map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

/** Every tool name, for tests and the docs. */
export const TOOL_NAMES = TOOLS.map((t) => t.name);

/**
 * Run one tool call. Never throws for a mistake the model made: that comes
 * back as a failed outcome whose result explains the problem, so the model
 * can try again.
 */
export function runTool(ctx: ToolContext, name: string, args: Record<string, unknown>): ToolOutcome {
  const tool = TOOLS.find((t) => t.name === name && (t.available?.(ctx) ?? true));
  if (!tool) {
    return failure(`There's no tool called "${name}". Tools: ${toolSpecs(ctx).map((t) => t.function.name).join(", ")}.`);
  }
  try {
    const outcome = tool.run(ctx, args);
    return { ok: true, ...outcome };
  } catch (error) {
    if (
      error instanceof ToolError ||
      error instanceof ValidationError ||
      error instanceof PermissionError ||
      error instanceof NotFoundError
    ) {
      return failure(error.message);
    }
    console.error(`[tools] ${name} failed`, error);
    return failure("Something went wrong running that tool.");
  }
}

function failure(message: string): ToolOutcome {
  return { ok: false, result: { error: message }, summary: message };
}
