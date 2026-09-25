/**
 * Aettica's web app: everything that happens in the browser.
 *
 * The app is deliberately simple: no framework, no build step. It keeps a
 * copy of what's on screen in `state`, talks to the server with `fetch`, and
 * redraws with the `render...` functions whenever something changes.
 *
 * The server is always the source of truth. The browser never guesses what
 * was saved; it shows what the server sends back.
 *
 * The open channel is kept in the address bar (`#/channel/<id>`), so reloading
 * the page, or reopening the app, brings you back to the same channel.
 */

"use strict";

// ------------------------------------------------------------------ state

/** Everything the page is currently showing. */
const state = {
  /** Server-wide settings: partnerName, partnerPrompt, model, temperature, maxTokens, historyLimit. */
  settings: null,
  /** Every channel, in sidebar order: {id, name, kind, position, characterName, characterSheet}. */
  channels: [],
  /** Id of the open channel, or null if there are no channels. */
  channelId: null,
  /** Messages in the open channel: {id, channelId, author, content, characters, createdAt, editedAt?, model?}. */
  messages: [],
  /** Ids of channels where the partner is writing right now. */
  busy: new Set(),
  /** Id of the message being edited, if any. */
  editingId: null,
  /** What "Try again" does after an error, or null if retrying makes no sense. */
  retry: null,
  /** Unsent text for each channel, so switching channels doesn't lose it. */
  drafts: new Map(),
};

// Shortcut for looking up elements by id.
const $ = (id) => document.getElementById(id);

const els = {
  app: $("app"),
  channelList: $("channel-list"),
  partnerName: $("partner-name"),
  partnerAvatar: $("partner-avatar"),
  channelView: $("channel-view"),
  channelName: $("channel-name"),
  channelTitleIcon: $("channel-title-icon"),
  channelTopic: $("channel-topic"),
  messages: $("messages"),
  composer: $("composer"),
  status: $("status"),
  error: $("error"),
  errorText: $("error-text"),
  errorRetry: $("error-retry"),
  form: $("composer-form"),
  input: $("composer-input"),
  send: $("send-button"),
  turn: $("turn-button"),
  settingsDialog: $("settings-dialog"),
  settingsForm: $("settings-form"),
  channelDialog: $("channel-dialog"),
  channelForm: $("channel-form"),
  newChannelDialog: $("new-channel-dialog"),
  newChannelForm: $("new-channel-form"),
  promptDialog: $("prompt-dialog"),
  promptPreview: $("prompt-preview"),
  modelList: $("model-list"),
  loadModels: $("load-models"),
};

/** The open channel's full details, or undefined. */
function currentChannel() {
  return state.channels.find((c) => c.id === state.channelId);
}

// ------------------------------------------------------------ server API

/**
 * Call the server's API and return the parsed JSON.
 *
 * Every request that sends data is marked as JSON; the server insists on it
 * (see `checkRequestIsFromTheApp` in src/server.ts). If the server answers
 * with an error, this throws an Error carrying the server's message.
 */
async function api(method, path, body) {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Request failed (HTTP ${response.status})`);
  }
  return data;
}

/** The API path for something in the open channel, e.g. channelPath("turn"). */
function channelPath(suffix, channelId = state.channelId) {
  return `/api/channels/${encodeURIComponent(channelId)}/${suffix}`;
}

/** Fetch settings, channels and busy channels from the server. */
async function loadState() {
  const data = await api("GET", "/api/state");
  state.settings = data.settings;
  state.channels = data.channels;
  state.busy = new Set(data.busyChannels);
}

// ------------------------------------------------------------- channels

/**
 * Open a channel: load its messages and redraw everything.
 * Also used to refresh the open channel after changes.
 */
async function openChannel(channelId) {
  // Keep whatever you'd typed in the channel you're leaving.
  if (state.channelId) state.drafts.set(state.channelId, els.input.value);

  state.channelId = channelId;
  state.editingId = null;
  state.messages = [];
  hideError();

  // Put the channel in the address bar without adding a history entry for
  // every switch. (Only if it isn't there already, to avoid a loop with the
  // hashchange handler.)
  const hash = channelId ? `#/channel/${channelId}` : "";
  if (location.hash !== hash) history.replaceState(null, "", hash || location.pathname);

  if (channelId) {
    try {
      const { messages } = await api("GET", channelPath("messages", channelId));
      // Ignore the answer if you switched again while it was loading.
      if (state.channelId !== channelId) return;
      state.messages = messages;
    } catch (error) {
      showError(`Couldn't load this channel: ${error.message}`, () => openChannel(channelId));
    }
  }

  els.input.value = state.drafts.get(channelId) ?? "";
  autoGrow();
  renderAll();
  scrollToBottom();
}

/** The channel named in the address bar, if it exists. */
function channelFromAddress() {
  const match = location.hash.match(/^#\/channel\/(.+)$/);
  const id = match && decodeURIComponent(match[1]);
  return state.channels.some((c) => c.id === id) ? id : null;
}

async function createChannel(event) {
  event.preventDefault();
  const form = els.newChannelForm.elements;
  const kind = form.kind.value;
  const body = { name: form.name.value, kind };
  if (kind === "rp") {
    body.characterName = form.characterName.value;
    body.characterSheet = form.characterSheet.value;
  }
  try {
    const { channel } = await api("POST", "/api/channels", body);
    state.channels.push(channel);
    els.newChannelDialog.close();
    closeSidebar();
    openChannel(channel.id);
  } catch (error) {
    showFormError(els.newChannelForm, error.message);
  }
}

async function saveChannel(event) {
  event.preventDefault();
  const channel = currentChannel();
  const form = els.channelForm.elements;
  const body = { name: form.name.value };
  if (channel.kind === "rp") {
    body.characterName = form.characterName.value;
    body.characterSheet = form.characterSheet.value;
  }
  try {
    const { channel: updated } = await api("PATCH", `/api/channels/${encodeURIComponent(channel.id)}`, body);
    state.channels = state.channels.map((c) => (c.id === updated.id ? updated : c));
    els.channelDialog.close();
    renderAll();
  } catch (error) {
    showFormError(els.channelForm, error.message);
  }
}

/** Move the open channel one place up (-1) or down (+1) in the sidebar. */
async function moveChannel(step) {
  const ids = state.channels.map((c) => c.id);
  const from = ids.indexOf(state.channelId);
  const to = from + step;
  if (to < 0 || to >= ids.length) return;
  // Swap the two neighbours.
  [ids[from], ids[to]] = [ids[to], ids[from]];
  try {
    const { channels } = await api("PUT", "/api/channels/order", { ids });
    state.channels = channels;
    renderAll();
  } catch (error) {
    showFormError(els.channelForm, error.message);
  }
}

async function deleteChannel() {
  const channel = currentChannel();
  if (!confirm(`Delete #${channel.name} and every message in it? This can't be undone.`)) return;
  try {
    await api("DELETE", `/api/channels/${encodeURIComponent(channel.id)}`, {});
    state.channels = state.channels.filter((c) => c.id !== channel.id);
    state.drafts.delete(channel.id);
    els.channelDialog.close();
    openChannel(state.channels[0]?.id ?? null);
  } catch (error) {
    showFormError(els.channelForm, error.message);
  }
}

async function clearChannel() {
  const channel = currentChannel();
  if (!confirm(`Delete every message in #${channel.name}? This can't be undone.`)) return;
  try {
    await api("DELETE", channelPath("messages"), {});
    state.messages = [];
    els.channelDialog.close();
    renderMessages();
  } catch (error) {
    showFormError(els.channelForm, error.message);
  }
}

// ------------------------------------------------------ messages & turns

/**
 * Requests from *this* page that make the partner write, by channel id.
 * Each is `{ startedAt, onAbandon }`; see `withBusyChannel` and `checkBusy`.
 */
const pendingRequests = new Map();

/**
 * Run a request that makes the partner write in a channel: marks the channel
 * busy while it runs, and redraws afterwards.
 *
 * @param work       Does the request. It receives `stillMine()`, which turns
 *                   false if the request was abandoned (you pressed Stop, or
 *                   the page decided the request was lost). An abandoned
 *                   request's late answer must be ignored: the channel has
 *                   already been reloaded from the server.
 * @param onAbandon  Optional. Called with the reloaded messages if the
 *                   request is abandoned while you're in its channel.
 */
async function withBusyChannel(channelId, work, onAbandon) {
  const request = { startedAt: Date.now(), onAbandon };
  pendingRequests.set(channelId, request);
  state.busy.add(channelId);
  renderAll();
  if (channelId === state.channelId) scrollToBottom();
  startBusyWatch();

  const stillMine = () => pendingRequests.get(channelId) === request;
  try {
    await work(stillMine);
  } finally {
    if (stillMine()) {
      pendingRequests.delete(channelId);
      state.busy.delete(channelId);
      renderAll();
      if (channelId === state.channelId) scrollToBottom();
    }
  }
}

/**
 * Stop waiting for this page's request in a channel. Returns the request
 * (or undefined if there wasn't one), so its `onAbandon` can still be run.
 */
function abandonRequest(channelId) {
  const request = pendingRequests.get(channelId);
  pendingRequests.delete(channelId);
  state.busy.delete(channelId);
  return request;
}

/** Reload the open channel's messages, e.g. after a turn was stopped. */
async function refreshMessages(onAbandon) {
  const channelId = state.channelId;
  if (!channelId) return;
  try {
    const { messages } = await api("GET", channelPath("messages", channelId));
    if (state.channelId !== channelId) return;
    state.messages = messages;
    onAbandon?.(messages);
  } catch (error) {
    showError(`Couldn't reload this channel: ${error.message}`, () => refreshMessages());
  }
  renderAll();
  scrollToBottom();
}

/**
 * The Stop button: ask the server to stop your partner's turn in the open
 * channel, stop waiting for it here, and reload the channel so it shows
 * exactly what was saved (your message, if you'd just sent one; no reply).
 */
async function stopTurn() {
  const channelId = state.channelId;
  const request = abandonRequest(channelId);
  hideError();
  renderAll();
  try {
    await api("POST", channelPath("cancel", channelId), {});
  } catch (error) {
    showError(`Couldn't reach the server to stop the reply: ${error.message}`, null);
  }
  await refreshMessages(request?.onAbandon);
}

/*
 * Checking in with the server while anything is busy.
 *
 * A request can be lost without ever failing: on a phone, the connection
 * can quietly drop when the app goes to the background or the screen locks,
 * and the page would wait for an answer that never comes, with the channel
 * stuck on "writing…". So while any channel is busy, the page asks the
 * server every few seconds which channels are *really* busy, and:
 *
 *   - a channel the server has finished with is un-stuck and reloaded, so
 *     the reply (or your saved message) appears
 *   - a channel the server is busy with, but this page didn't know about
 *     (a turn from another tab, or from before a reload), is marked busy
 */

/** How often to check, in milliseconds. */
const BUSY_CHECK_INTERVAL = 3000;
/**
 * A request younger than this is never treated as lost: it may simply not
 * have reached the server yet.
 */
const LOST_REQUEST_GRACE = 8000;

let busyWatch = null;

function startBusyWatch() {
  if (!busyWatch) busyWatch = setInterval(checkBusy, BUSY_CHECK_INTERVAL);
}

async function checkBusy() {
  if (state.busy.size === 0) {
    clearInterval(busyWatch);
    busyWatch = null;
    return;
  }

  let serverBusy;
  try {
    serverBusy = new Set((await api("GET", "/api/state")).busyChannels);
  } catch {
    return; // server unreachable for a moment; try again next time
  }

  for (const channelId of [...state.busy]) {
    if (serverBusy.has(channelId)) continue;
    const request = pendingRequests.get(channelId);
    if (request && Date.now() - request.startedAt < LOST_REQUEST_GRACE) continue;
    // The server is done, but this page never heard back. Catch up.
    abandonRequest(channelId);
    if (channelId === state.channelId) await refreshMessages(request?.onAbandon);
  }
  for (const channelId of serverBusy) state.busy.add(channelId);
  renderAll();
}

/**
 * Send what's in the text box. The server saves it and your partner replies
 * in the same request.
 */
async function sendMessage() {
  const channelId = state.channelId;
  const content = els.input.value;
  if (!channelId || content.trim() === "" || state.busy.has(channelId)) return;

  hideError();
  // Show your post straight away, as a placeholder, while the partner
  // writes. It's swapped for the saved copy when the server answers.
  const placeholder = {
    id: "pending",
    channelId,
    author: "user",
    content,
    characters: [],
    createdAt: new Date().toISOString(),
  };
  state.messages.push(placeholder);
  els.input.value = "";
  state.drafts.delete(channelId);
  autoGrow();

  // If the request is abandoned (Stop, or lost) and the server never saved
  // your message, put your text back in the box so it isn't lost.
  const restoreIfUnsaved = (messages) => {
    const saved = messages.some((m) => m.author === "user" && m.content === content);
    if (!saved && els.input.value === "") {
      els.input.value = content;
      autoGrow();
    }
  };

  await withBusyChannel(
    channelId,
    async (stillMine) => {
      try {
        const data = await api("POST", channelPath("messages", channelId), { content });
        if (!stillMine()) return; // abandoned; the channel was already reloaded
        if (state.channelId !== channelId) return; // you've moved on; it'll load when you return
        state.messages = state.messages.filter((m) => m !== placeholder);
        state.messages.push(data.userMessage);
        if (data.partnerMessage) {
          state.messages.push(data.partnerMessage);
        } else if (data.error) {
          // Your message is saved but the reply failed. "Try again" asks the
          // partner for a turn, which answers the message you already sent.
          showError(data.error, partnerTurn);
        }
        // (If data.cancelled, the reply was stopped: your message stays, and
        // there's nothing more to show.)
      } catch (error) {
        if (!stillMine()) return;
        // Nothing was saved (e.g. the server is down), so put your text back
        // in the box; "Try again" simply sends it again.
        state.messages = state.messages.filter((m) => m !== placeholder);
        if (state.channelId === channelId) {
          els.input.value = content;
          autoGrow();
          showError(error.message, sendMessage);
        } else {
          state.drafts.set(channelId, content);
        }
      }
    },
    restoreIfUnsaved,
  );
}

/** Let your partner write without a new message from you. */
async function partnerTurn() {
  await runTurn("turn", (data) => state.messages.push(data.partnerMessage), partnerTurn);
}

/** Replace your partner's last reply with a fresh one. */
async function regenerate() {
  await runTurn(
    "regenerate",
    (data) => {
      state.messages = state.messages.filter((m) => m.id !== data.replacedId);
      state.messages.push(data.partnerMessage);
    },
    regenerate,
  );
}

/**
 * Shared wrapper for partner turns in the open channel.
 *
 * @param action     "turn" or "regenerate" (the end of the API path).
 * @param onSuccess  Updates `state.messages` with the server's answer. Not
 *                   called if the turn was stopped.
 * @param retry      What "Try again" should do if it fails.
 */
async function runTurn(action, onSuccess, retry) {
  const channelId = state.channelId;
  if (!channelId || state.busy.has(channelId)) return;
  hideError();
  await withBusyChannel(channelId, async (stillMine) => {
    try {
      const data = await api("POST", channelPath(action, channelId), {});
      if (stillMine() && state.channelId === channelId && data.partnerMessage) onSuccess(data);
    } catch (error) {
      if (stillMine() && state.channelId === channelId) showError(error.message, retry);
    }
  });
}

async function saveEdit(id, content) {
  try {
    const data = await api("PATCH", `/api/messages/${encodeURIComponent(id)}`, { content });
    state.messages = state.messages.map((m) => (m.id === id ? data.message : m));
    state.editingId = null;
    renderMessages();
  } catch (error) {
    showError(error.message, null);
  }
}

async function deleteMessage(id) {
  if (!confirm("Delete this message?")) return;
  try {
    await api("DELETE", `/api/messages/${encodeURIComponent(id)}`, {});
    state.messages = state.messages.filter((m) => m.id !== id);
    renderMessages();
  } catch (error) {
    showError(error.message, null);
  }
}

// -------------------------------------------------------------- rendering

/** Redraw everything from `state`. */
function renderAll() {
  renderSidebar();
  renderChannelHeader();
  renderMessages();
  renderComposer();
}

/** The channel list and the partner card at the bottom of the sidebar. */
function renderSidebar() {
  els.channelList.replaceChildren(
    ...state.channels.map((channel) => {
      const item = document.createElement("li");
      const link = document.createElement("a");
      link.className = "channel-link";
      link.href = `#/channel/${channel.id}`;
      link.dataset.kind = channel.kind;
      if (channel.id === state.channelId) link.setAttribute("aria-current", "page");
      link.title = channel.kind === "ooc" ? "Out of character" : channel.characterName || "Roleplay";

      const name = document.createElement("span");
      name.className = "channel-link-name";
      name.textContent = channel.name;
      link.append(channelIcon(channel.kind), name);

      if (state.busy.has(channel.id)) {
        const dot = document.createElement("span");
        dot.className = "channel-busy";
        dot.title = "Your partner is writing here";
        link.append(dot);
      }
      item.append(link);
      return item;
    }),
  );

  const partnerName = state.settings?.partnerName ?? "Partner";
  els.partnerName.textContent = partnerName;
  els.partnerAvatar.textContent = initial(partnerName);
}

/** The `#` icon for RP channels, a speech bubble for OOC. */
function channelIcon(kind) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "channel-icon");
  svg.setAttribute("width", "18");
  svg.setAttribute("height", "18");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", kind === "ooc" ? "#icon-ooc" : "#icon-hash");
  svg.append(use);
  return svg;
}

/** Channel name and "topic" (character or OOC) at the top of the channel. */
function renderChannelHeader() {
  const channel = currentChannel();
  // These attributes are what per-channel themes (stage 3.5) will hook onto.
  els.channelView.dataset.channelId = channel?.id ?? "";
  els.channelView.dataset.channelKind = channel?.kind ?? "";

  els.channelName.textContent = channel?.name ?? "";
  els.channelTitleIcon.setAttribute("href", channel?.kind === "ooc" ? "#icon-ooc" : "#icon-hash");
  els.channelTopic.textContent = !channel
    ? ""
    : channel.kind === "ooc"
      ? `Out of character with ${state.settings.partnerName}`
      : channel.characterName
        ? `${state.settings.partnerName} plays ${channel.characterName}`
        : "";
  $("channel-settings-button").hidden = !channel;
  document.title = channel ? `#${channel.name} · Aettica` : "Aettica";
}

/** Redraw the message list from `state.messages`. */
function renderMessages() {
  const channel = currentChannel();
  els.messages.replaceChildren();

  if (!channel) {
    els.messages.append(
      emptyNote("There are no channels yet. Create one with the + button at the top of the channel list."),
    );
    return;
  }

  if (state.messages.length === 0) {
    els.messages.append(
      emptyNote(
        channel.kind === "ooc"
          ? `Nothing here yet. Say hi, or press “Partner's turn” to let ${state.settings.partnerName} start the conversation.`
          : "No messages yet. Write the first post, or press “Partner's turn” to let your partner open the story.",
      ),
    );
    return;
  }

  const lastId = state.messages.at(-1).id;
  for (const message of state.messages) {
    els.messages.append(renderMessage(message, message.id === lastId));
  }
}

function emptyNote(text) {
  const note = document.createElement("p");
  note.className = "empty";
  note.textContent = text;
  return note;
}

/**
 * Who a message shows as written by.
 *
 * Your messages: "You". Partner messages that voice characters: the
 * character names, with the partner's name as a badge (it's them writing
 * the character). Partner messages voicing no one (OOC): the partner's name.
 */
function authorOf(message) {
  if (message.author === "user") return { name: "You", badge: null };
  const partnerName = state.settings.partnerName;
  if (message.characters.length > 0) return { name: message.characters.join(" & "), badge: partnerName };
  return { name: partnerName, badge: null };
}

/**
 * Build the element for one message.
 *
 * Text is always inserted as text, never as raw HTML, except for the tiny
 * bit of formatting in `formatText`, which escapes everything first. That
 * way a model reply containing `<script>` can't run code in your browser.
 */
function renderMessage(message, isLast) {
  const { name, badge } = authorOf(message);
  const pending = message.id === "pending";

  const root = document.createElement("article");
  root.className = pending ? "message pending" : "message";
  root.dataset.author = message.author;

  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = initial(name);
  avatar.setAttribute("aria-hidden", "true");

  const meta = document.createElement("div");
  meta.className = "message-meta";
  const author = document.createElement("span");
  author.className = "message-author";
  author.textContent = name;
  meta.append(author);
  if (badge) {
    const tag = document.createElement("span");
    tag.className = "message-badge";
    tag.textContent = badge;
    tag.title = `Written by ${badge}`;
    meta.append(tag);
  }
  const time = document.createElement("time");
  time.className = "message-time";
  time.dateTime = message.createdAt;
  time.textContent = formatTime(message.createdAt) + (message.editedAt ? " (edited)" : "");
  meta.append(time);
  if (message.model) {
    const model = document.createElement("span");
    model.className = "message-model";
    // Show just the part after the last "/" (e.g. "DeepSeek-V3.1-Terminus")
    // to save space on a phone; the full id appears when you hover or long-press.
    model.textContent = message.model.split("/").at(-1);
    model.title = message.model;
    meta.append(model);
  }

  root.append(avatar, meta);

  if (state.editingId === message.id) {
    root.append(renderEditor(message));
    return root;
  }

  const content = document.createElement("div");
  content.className = "message-content";
  content.innerHTML = formatText(message.content);
  root.append(content);

  // A post that's still being sent has no actions yet.
  if (pending) return root;

  const busy = state.busy.has(state.channelId);
  const actions = document.createElement("div");
  actions.className = "message-actions";
  actions.append(
    actionButton("Edit", () => {
      state.editingId = message.id;
      renderMessages();
    }),
    actionButton("Delete", () => deleteMessage(message.id), busy),
  );
  // Only the newest message can be regenerated, and only if it's the partner's.
  if (isLast && message.author === "partner") {
    actions.append(actionButton("Regenerate", regenerate, busy));
  }
  root.append(actions);
  return root;
}

/** The inline editor shown in place of a message's text while editing. */
function renderEditor(message) {
  const wrapper = document.createElement("div");
  const box = document.createElement("textarea");
  box.className = "edit-box";
  box.value = message.content;

  const actions = document.createElement("div");
  actions.className = "message-actions";
  actions.append(
    actionButton("Save", () => {
      if (box.value.trim() !== "") saveEdit(message.id, box.value);
    }),
    actionButton("Cancel", () => {
      state.editingId = null;
      renderMessages();
    }),
  );

  wrapper.append(box, actions);
  // Focus the box once it's on the page.
  queueMicrotask(() => box.focus());
  return wrapper;
}

function actionButton(label, onClick, disabled = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.disabled = disabled;
  button.addEventListener("click", onClick);
  return button;
}

/** Show or hide the composer, the "writing…" indicator, and lock buttons while busy. */
function renderComposer() {
  const channel = currentChannel();
  els.composer.hidden = !channel;
  if (!channel) return;

  const busy = state.busy.has(channel.id);
  els.status.hidden = !busy;
  $("status-text").textContent = `${state.settings.partnerName} is writing…`;
  els.send.disabled = busy;
  els.turn.disabled = busy;
  els.input.placeholder =
    channel.kind === "ooc" ? `Message ${state.settings.partnerName}…` : `Write your post in #${channel.name}…`;
}

/**
 * Turn message text into safe HTML with light RP formatting:
 * `**bold**` and `*italics*` (or `_italics_`), the usual way of writing
 * actions in roleplay. Line breaks are kept by CSS (`white-space: pre-wrap`).
 */
function formatText(text) {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/(^|\W)_(.+?)_(?=\W|$)/g, "$1<em>$2</em>");
}

function escapeHtml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** The first letter of a name, for avatars. */
function initial(name) {
  return (name.trim()[0] ?? "?").toUpperCase();
}

/** "14:05" for today, "Sep 24, 14:05" for older messages. */
function formatTime(iso) {
  const date = new Date(iso);
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (date.toDateString() === new Date().toDateString()) return time;
  return `${date.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}

function scrollToBottom() {
  els.messages.scrollTop = els.messages.scrollHeight;
}

// ------------------------------------------------------------------ errors

/**
 * Show an error above the composer. `retry` is the function "Try again"
 * should call, or null to hide that button.
 */
function showError(message, retry) {
  state.retry = retry;
  els.errorText.textContent = message;
  els.errorRetry.hidden = !retry;
  els.error.hidden = false;
}

function hideError() {
  state.retry = null;
  els.error.hidden = true;
}

/** Show an error inside a dialog's form. */
function showFormError(form, message) {
  const box = form.querySelector(".form-error");
  box.textContent = message;
  box.hidden = false;
}

function hideFormError(form) {
  form.querySelector(".form-error").hidden = true;
}

// ---------------------------------------------------------------- dialogs

/** Server-wide settings: fill the form from `state.settings` and open it. */
function openSettings() {
  const s = state.settings;
  const form = els.settingsForm.elements;
  form.partnerName.value = s.partnerName;
  form.partnerPrompt.value = s.partnerPrompt;
  form.model.value = s.model;
  form.temperature.value = s.temperature;
  form.maxTokens.value = s.maxTokens;
  form.historyLimit.value = s.historyLimit;
  hideFormError(els.settingsForm);
  els.settingsDialog.showModal();
}

async function saveSettings(event) {
  // Stop the <form method="dialog"> from closing the dialog before we know
  // the save worked.
  event.preventDefault();
  const form = els.settingsForm.elements;
  try {
    const data = await api("PUT", "/api/settings", {
      partnerName: form.partnerName.value,
      partnerPrompt: form.partnerPrompt.value,
      model: form.model.value,
      // Number boxes give text; the server wants numbers.
      temperature: Number(form.temperature.value),
      maxTokens: Number(form.maxTokens.value),
      historyLimit: Number(form.historyLimit.value),
    });
    state.settings = data.settings;
    els.settingsDialog.close();
    renderAll();
  } catch (error) {
    showFormError(els.settingsForm, error.message);
  }
}

/** Ask the server which models nanoGPT offers and offer them as suggestions. */
async function loadModels() {
  els.loadModels.disabled = true;
  els.loadModels.textContent = "Loading…";
  try {
    const { models } = await api("GET", "/api/models");
    els.modelList.replaceChildren(
      ...models.map((id) => {
        const option = document.createElement("option");
        option.value = id;
        return option;
      }),
    );
    els.loadModels.textContent = `${models.length} models`;
    // Focus the model box so the suggestions are one tap away.
    els.settingsForm.elements.model.focus();
  } catch (error) {
    showFormError(els.settingsForm, error.message);
    els.loadModels.textContent = "Load list";
  } finally {
    els.loadModels.disabled = false;
  }
}

/** Channel settings for the open channel. */
function openChannelSettings() {
  const channel = currentChannel();
  if (!channel) return;
  const form = els.channelForm.elements;
  form.name.value = channel.name;
  form.characterName.value = channel.characterName;
  form.characterSheet.value = channel.characterSheet;
  els.channelForm.querySelector(".rp-only").hidden = channel.kind !== "rp";
  $("channel-kind-note").textContent =
    channel.kind === "rp"
      ? "A roleplay channel. Your partner writes as the character below."
      : "An out-of-character channel. Your partner talks to you as themselves.";
  hideFormError(els.channelForm);
  els.channelDialog.showModal();
}

function openNewChannel() {
  els.newChannelForm.reset();
  hideFormError(els.newChannelForm);
  updateNewChannelKind();
  els.newChannelDialog.showModal();
}

/** Show the character fields only when "Roleplay" is picked. */
function updateNewChannelKind() {
  els.newChannelForm.querySelector(".rp-only").hidden = els.newChannelForm.elements.kind.value !== "rp";
}

/**
 * Show the exact prompt stack the next turn in the open channel would send.
 * Uses the *saved* settings, so save first if you want to preview a change.
 */
async function previewPrompt() {
  try {
    const { messages } = await api("GET", channelPath("prompt"));
    els.promptPreview.replaceChildren(
      ...messages.map((m) => {
        const block = document.createElement("div");
        block.className = "prompt-message";
        const role = document.createElement("div");
        role.className = "prompt-role";
        role.textContent = m.role;
        const pre = document.createElement("pre");
        pre.textContent = m.content;
        block.append(role, pre);
        return block;
      }),
    );
    els.promptDialog.showModal();
  } catch (error) {
    showFormError(els.channelForm, error.message);
  }
}

// ---------------------------------------------------------------- sidebar

/** On phones, the sidebar slides over the channel. These open and close it. */
function openSidebar() {
  els.app.classList.add("sidebar-open");
}

function closeSidebar() {
  els.app.classList.remove("sidebar-open");
}

// ---------------------------------------------------------------- composer

/** Grow the text box to fit what you've typed (CSS caps the height). */
function autoGrow() {
  els.input.style.height = "auto";
  els.input.style.height = `${els.input.scrollHeight + 2}px`;
}

// ------------------------------------------------------------ wiring it up

els.form.addEventListener("submit", (event) => {
  event.preventDefault();
  sendMessage();
});

// Enter makes a new line (you'll want paragraphs). Ctrl+Enter or Cmd+Enter sends.
els.input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    sendMessage();
  }
});
els.input.addEventListener("input", autoGrow);

els.turn.addEventListener("click", partnerTurn);
$("stop-button").addEventListener("click", stopTurn);
els.errorRetry.addEventListener("click", () => state.retry && state.retry());
$("error-dismiss").addEventListener("click", hideError);

// Clicking a channel link changes the address; this opens that channel.
window.addEventListener("hashchange", () => {
  const id = channelFromAddress();
  if (id && id !== state.channelId) openChannel(id);
  closeSidebar();
});
// Tapping the channel you're already in should still close the phone sidebar.
els.channelList.addEventListener("click", closeSidebar);

$("menu-button").addEventListener("click", openSidebar);
$("sidebar-scrim").addEventListener("click", closeSidebar);

$("settings-button").addEventListener("click", openSettings);
els.settingsForm.addEventListener("submit", saveSettings);
els.loadModels.addEventListener("click", loadModels);

$("channel-settings-button").addEventListener("click", openChannelSettings);
els.channelForm.addEventListener("submit", saveChannel);
$("channel-move-up").addEventListener("click", () => moveChannel(-1));
$("channel-move-down").addEventListener("click", () => moveChannel(1));
$("preview-prompt").addEventListener("click", previewPrompt);
$("clear-channel").addEventListener("click", clearChannel);
$("delete-channel").addEventListener("click", deleteChannel);

$("new-channel-button").addEventListener("click", openNewChannel);
els.newChannelForm.addEventListener("submit", createChannel);
els.newChannelForm.addEventListener("change", updateNewChannelKind);

// Every "Cancel" / "Close" button closes the dialog it's in.
for (const button of document.querySelectorAll("[data-close]")) {
  button.addEventListener("click", () => button.closest("dialog").close());
}

// Register the service worker, which is what makes the app installable.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch((error) => {
    console.warn("Service worker registration failed:", error);
  });
}

// Start: load the server's state, then open the channel in the address bar
// (or the first channel).
loadState()
  .then(() => {
    // A turn may already be running (from another tab, or from before a
    // reload): keep an eye on it.
    if (state.busy.size > 0) startBusyWatch();
    return openChannel(channelFromAddress() ?? state.channels[0]?.id ?? null);
  })
  .catch((error) => showError(`Couldn't load Aettica: ${error.message}`, () => location.reload()));
