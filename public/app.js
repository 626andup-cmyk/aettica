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
  /**
   * Server-wide settings: partnerName, partnerPrompt (who they are),
   * literaryPrompt, casualPrompt and oocPrompt (how they write in each kind
   * of channel), model, temperature, maxTokens, historyLimit, appTheme.
   */
  settings: null,
  /**
   * Every channel, in sidebar order: {id, name, kind, mode, pendingMode,
   * theme, position, cast}. `cast` is the entries pinned to it, as you see
   * them: {entryId, name, playedBy, owner, kind, hidden, proxyPrefix}.
   * `playedBy` is "user", "partner" or "both" (shared characters).
   */
  channels: [],
  /** Id of the open channel, or null if there are no channels. */
  channelId: null,
  /**
   * The notebook, as you see it: {folders, entries, suggestions, templates}.
   * Each entry carries its effective `settings`, what you may do with it
   * (`access`), and the channels it's pinned to (`pinnedIn`).
   */
  notebook: { folders: [], entries: [], suggestions: [], templates: { character: [], lore: [] } },
  /** The entry open in the entry editor, or a new one: {kind, owner} without an id. */
  editingEntry: null,
  /** The folder open in the folder dialog (null for a new one). */
  editingFolder: null,
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
  /** In casual channels: which of your characters you're posting as, by channel id. */
  postingAs: new Map(),
  /** Every theme: {id, name, description, builtIn, hasLite, swatch}. */
  themes: [],
  /**
   * Added to theme URLs (`?v=`). Bumped after you edit a theme, so the
   * browser fetches the new version.
   */
  themeVersion: 0,
  /** The theme open in the theme editor (with its css, liteCss and files). */
  editingTheme: null,
  /** Fingerprint of the app's files when this page loaded (see `checkForUpdate`). */
  appVersion: null,
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
  state.appVersion ??= data.appVersion;
  checkForUpdate(data.appVersion);
}

// ------------------------------------------------------------- updates

/*
 * An installed app can stay open in the background for days. After you
 * update Aettica and restart the server, a page that's still open would keep
 * running the old code (and miss things like new buttons). So the server
 * sends a fingerprint of the app's files (`appVersion`), and the page checks
 * it whenever it hears from the server, and whenever you come back to it.
 */

/**
 * Compare the server's app version with the one this page started with. If
 * they differ, reload, unless that would throw something away (unsent
 * text, an open dialog, a reply being written), in which case offer a
 * Reload button instead.
 */
function checkForUpdate(serverVersion) {
  if (!serverVersion || !state.appVersion || serverVersion === state.appVersion) return;

  const unsentText = els.input.value.trim() !== "" || [...state.drafts.values()].some((d) => d.trim() !== "");
  const busy = state.busy.size > 0 || state.editingId !== null || document.querySelector("dialog[open]");
  if (!unsentText && !busy) {
    location.reload();
  } else {
    $("update-banner").hidden = false;
  }
}

/** Ask the server for its app version (used when you come back to the app). */
async function checkServerVersion() {
  try {
    const data = await api("GET", "/api/state");
    checkForUpdate(data.appVersion);
  } catch {
    // Server not running right now; nothing to compare.
  }
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
  if (kind === "rp") body.mode = form.mode.value;
  try {
    let { channel } = await api("POST", "/api/channels", body);
    // Pin the character picked for your partner, if any.
    if (kind === "rp" && form.cast.value) {
      ({ channel } = await api("PUT", channelPath(`cast/${encodeURIComponent(form.cast.value)}`, channel.id), {}));
      await loadNotebook();
    }
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
  const body = { name: form.name.value, theme: form.theme.value || null };
  if (channel.kind === "rp") body.mode = form.mode.value;
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
    const data = await api("GET", "/api/state");
    serverBusy = new Set(data.busyChannels);
    checkForUpdate(data.appVersion);
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
  const channel = currentChannel();

  // `=====` (plus an optional title) on its own is a scene break, not a post.
  // (The server understands it too, but handling it here avoids showing
  // "=====" as a message for a moment.)
  const sceneTitle = channel.kind === "rp" ? content.trim().match(/^={5,}[ \t]*([^\n]*)$/) : null;
  if (sceneTitle) {
    els.input.value = "";
    state.drafts.delete(channelId);
    autoGrow();
    await addSceneBreak(sceneTitle[1].trim());
    return;
  }

  const postingAs = channel.kind === "rp" && channel.mode === "casual" ? state.postingAs.get(channelId) || null : null;
  const sentAt = new Date();
  const placeholder = {
    id: "pending",
    channelId,
    kind: "post",
    mode: channel.kind === "rp" ? channel.mode : null,
    author: "user",
    content,
    characters: postingAs ? [postingAs] : [],
    createdAt: sentAt.toISOString(),
  };
  state.messages.push(placeholder);
  els.input.value = "";
  state.drafts.delete(channelId);
  autoGrow();

  // If the request is abandoned (Stop, or lost) and the server never saved
  // your message, put your text back in the box so it isn't lost.
  const restoreIfUnsaved = (messages) => {
    // In casual mode your text may have been split into several bubbles, so
    // look for any post of yours from this send whose text is part of it.
    const saved = messages.some(
      (m) => m.author === "user" && new Date(m.createdAt) >= sentAt - 2000 && content.includes(m.content),
    );
    if (!saved && els.input.value === "") {
      els.input.value = content;
      autoGrow();
    }
  };

  await withBusyChannel(
    channelId,
    async (stillMine) => {
      try {
        const data = await api("POST", channelPath("messages", channelId), { content, postingAs });
        if (!stillMine()) return; // abandoned; the channel was already reloaded
        if (state.channelId !== channelId) return; // you've moved on; it'll load when you return
        // Posting as one of your characters adds them to the cast.
        if (data.channel) updateChannelInState(data.channel);
        state.messages = state.messages.filter((m) => m !== placeholder);
        state.messages.push(...data.userMessages);
        if (data.partnerMessages) {
          state.messages.push(...data.partnerMessages);
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
  await runTurn("turn", (data) => state.messages.push(...data.partnerMessages), partnerTurn);
}

/** Replace your partner's last reply (every bubble of it, in casual mode) with a fresh one. */
async function regenerate() {
  await runTurn(
    "regenerate",
    (data) => {
      const replaced = new Set(data.replacedIds);
      state.messages = state.messages.filter((m) => !replaced.has(m.id));
      state.messages.push(...data.partnerMessages);
    },
    regenerate,
  );
}

/**
 * Add a scene break to the open channel. If a mode change was waiting, the
 * server applies it now, and sends the updated channel back.
 */
async function addSceneBreak(title) {
  const channelId = state.channelId;
  hideError();
  try {
    const data = await api("POST", channelPath("scene-breaks", channelId), { title });
    updateChannelInState(data.channel);
    if (state.channelId !== channelId) return;
    state.messages.push(data.sceneBreak);
    renderAll();
    scrollToBottom();
  } catch (error) {
    showError(error.message, null);
  }
}

/** The "New scene" button: ask for an optional title, then add the break. */
function newScene() {
  const title = prompt("Title for the new scene (optional):", "");
  if (title !== null) addSceneBreak(title.trim());
}

async function renameSceneBreak(sceneBreak) {
  const title = prompt("Scene title:", sceneBreak.content);
  if (title === null) return;
  try {
    const data = await api("PATCH", `/api/messages/${encodeURIComponent(sceneBreak.id)}`, { content: title.trim() });
    state.messages = state.messages.map((m) => (m.id === sceneBreak.id ? data.message : m));
    renderMessages();
  } catch (error) {
    showError(error.message, null);
  }
}

/** Replace a channel in `state.channels` with a fresh copy from the server. */
function updateChannelInState(channel) {
  state.channels = state.channels.map((c) => (c.id === channel.id ? channel : c));
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
      if (stillMine() && state.channelId === channelId && data.partnerMessages) onSuccess(data);
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
  applyThemes();
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
      link.title =
        channel.kind === "ooc"
          ? "Out of character"
          : [...castNames(channel, "partner"), ...castNames(channel, "both")].join(", ") || "Roleplay";

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
  els.channelTopic.textContent = channel ? channelTopic(channel) : "";
  $("channel-settings-button").hidden = !channel;
  document.title = channel ? `#${channel.name} · Aettica` : "Aettica";
}

/**
 * The line next to the channel name, e.g.
 * "Arlo plays Ilse Marrow, ??? (hidden) · you play Kestrel · you both play Bo ·
 * Literary (casual from the next scene)".
 */
function channelTopic(channel) {
  const partnerName = state.settings.partnerName;
  if (channel.kind === "ooc") return `Out of character with ${partnerName}`;
  const parts = [];
  const theirs = castNames(channel, "partner");
  const yours = castNames(channel, "user");
  if (theirs.length) parts.push(`${partnerName} plays ${theirs.join(", ")}`);
  const shared = castNames(channel, "both");
  if (yours.length) parts.push(`you play ${yours.join(", ")}`);
  if (shared.length) parts.push(`you both play ${shared.join(", ")}`);
  let mode = MODE_NAMES[channel.mode];
  if (channel.pendingMode) mode += ` (${MODE_NAMES[channel.pendingMode].toLowerCase()} from the next scene)`;
  parts.push(mode);
  return parts.join(" · ");
}

const MODE_NAMES = { literary: "Literary", casual: "Casual" };

/** Names of the characters in a channel's cast played by `who` ("user", "partner" or "both"). */
function castNames(channel, who) {
  return (channel.cast ?? []).filter((c) => c.kind === "character" && c.playedBy === who).map((c) => c.name);
}

/**
 * Whether the open channel's current scene has no posts yet (nothing since
 * the last scene break). A mode change applies at once in that case, and at
 * the next scene break otherwise; the server decides, this is just for the
 * hint in channel settings.
 */
function currentSceneIsEmpty() {
  for (let i = state.messages.length - 1; i >= 0; i--) {
    if (state.messages[i].kind === "scene_break") return true;
    if (state.messages[i].id !== "pending") return false;
  }
  return true;
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

  // The last partner turn can be regenerated. In casual mode that's every
  // bubble of the last reply; the button goes on the last one.
  const last = state.messages.at(-1);
  const canRegenerate = last.kind === "post" && last.author === "partner";

  let previous = null;
  for (const message of state.messages) {
    const element =
      message.kind === "scene_break"
        ? renderSceneBreak(message)
        : renderMessage(message, {
            continued: continuesGroup(previous, message),
            regenerate: canRegenerate && message === last,
          });
    els.messages.append(element);
    previous = message;
  }
}

/**
 * Whether a message continues the one before it, Discord-style: same
 * author, same character(s), same mode, within a few minutes. A continued
 * message hides its avatar and name, so a burst of casual bubbles reads as
 * one block. Literary posts are always shown in full.
 */
function continuesGroup(previous, message) {
  if (!previous || previous.kind !== "post" || message.mode === "literary") return false;
  const sameVoice =
    previous.author === message.author &&
    previous.mode === message.mode &&
    previous.characters.join("|") === message.characters.join("|");
  const minutesApart = (new Date(message.createdAt) - new Date(previous.createdAt)) / 60000;
  return sameVoice && minutesApart < 7;
}

function emptyNote(text) {
  const note = document.createElement("p");
  note.className = "empty";
  note.textContent = text;
  return note;
}

/**
 * A scene break: a divider with the scene's title, and small buttons to
 * rename or remove it.
 */
function renderSceneBreak(sceneBreak) {
  const root = document.createElement("div");
  root.className = "scene-break";
  root.setAttribute("role", "separator");

  const title = document.createElement("span");
  title.className = "scene-break-title";
  title.textContent = sceneBreak.content || "New scene";
  root.append(title);

  const actions = document.createElement("span");
  actions.className = "scene-break-actions";
  actions.append(
    actionButton("Rename", () => renameSceneBreak(sceneBreak)),
    actionButton("Remove", () => deleteMessage(sceneBreak.id), state.busy.has(state.channelId)),
  );
  root.append(actions);
  return root;
}

/**
 * Who a message shows as written by.
 *
 *   - Your posts: "You", or in casual mode the character you posted as,
 *     with "You" as a small badge.
 *   - Partner posts that voice characters: the character names, with the
 *     partner's name as a badge (it's them writing the character).
 *   - Partner posts voicing no one (OOC): the partner's name.
 */
function authorOf(message) {
  const writer = message.author === "user" ? "You" : state.settings.partnerName;
  if (message.characters.length > 0) return { name: message.characters.join(" & "), badge: writer };
  return { name: writer, badge: null };
}

/**
 * Build the element for one message.
 *
 * The layout depends on the mode it was written in (`data-mode`), styled in
 * style.css:
 *
 *   - `literary`: a wide prose block with a small byline.
 *   - `casual`: a chat bubble with the character's avatar and name; a run of
 *     bubbles from the same character is grouped (`continued`).
 *   - `ooc`: like casual, for out-of-character channels.
 *
 * Text is always inserted as text, never as raw HTML, except for the tiny
 * bit of formatting in `formatText`, which escapes everything first. That
 * way a model reply containing `<script>` can't run code in your browser.
 *
 * @param options.continued   Hide the avatar and name (see `continuesGroup`).
 * @param options.regenerate  Show the Regenerate button.
 */
function renderMessage(message, { continued = false, regenerate: showRegenerate = false } = {}) {
  const { name, badge } = authorOf(message);
  const pending = message.id === "pending";
  const mode = message.mode ?? "ooc";

  const root = document.createElement("article");
  root.className = ["message", pending && "pending", continued && "continued"].filter(Boolean).join(" ");
  root.dataset.author = message.author;
  root.dataset.mode = mode;
  // Tapping a casual bubble shows its Edit/Delete buttons (see style.css).
  if (mode === "casual") root.addEventListener("click", () => root.classList.toggle("selected"));

  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = initial(name);
  avatar.setAttribute("aria-hidden", "true");
  // Each character gets their own colour for avatar and name, like
  // Tupperbox. The hue is set on the whole message; style.css uses it.
  if (message.characters.length > 0) {
    root.classList.add("has-character");
    root.style.setProperty("--avatar-hue", String(hueFor(name)));
  }

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
  if (showRegenerate) actions.classList.add("always");
  actions.append(
    actionButton("Edit", () => {
      state.editingId = message.id;
      renderMessages();
    }),
    actionButton("Delete", () => deleteMessage(message.id), busy),
  );
  if (showRegenerate) actions.append(actionButton("Regenerate", regenerate, busy));
  root.append(actions);
  return root;
}

/** A stable hue (0-359) for a name, so each character keeps their colour. */
function hueFor(name) {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  return hash % 360;
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

  const casual = channel.kind === "rp" && channel.mode === "casual";
  $("scene-button").hidden = channel.kind !== "rp";
  $("scene-button").disabled = busy;
  renderPostingAs(casual);

  if (channel.kind === "ooc") {
    els.input.placeholder = `Message ${state.settings.partnerName}…`;
  } else if (casual) {
    const example = yourCharacters().find((c) => c.proxyPrefix);
    els.input.placeholder = example
      ? `Chat in #${channel.name}… (start a line with ${example.proxyPrefix}: to post as ${example.name})`
      : `Chat in #${channel.name}…`;
  } else {
    els.input.placeholder = `Write your post in #${channel.name}…  (===== starts a new scene)`;
  }
}

/** The characters you can post as: yours and shared ones. */
function yourCharacters() {
  return state.notebook.entries.filter((e) => canHavePrefix(e.kind, e.owner));
}

/** Whether a character can have a proxy prefix: one you play (yours, or shared). */
function canHavePrefix(kind, owner) {
  return kind === "character" && (owner === "user" || owner === "joint");
}

/**
 * The "posting as" picker, shown in casual scenes: yourself, or one of your
 * characters (from the notebook). Lines starting with a character's prefix
 * override it.
 */
function renderPostingAs(visible) {
  const select = $("posting-as");
  const characters = yourCharacters();
  const row = $("posting-as-row");
  row.hidden = !visible || characters.length === 0;
  if (row.hidden) return;

  // Forget a choice whose character no longer exists.
  let current = state.postingAs.get(state.channelId) ?? "";
  if (current && !characters.some((c) => c.name === current)) current = "";

  select.replaceChildren(new Option("yourself", ""), ...characters.map((c) => new Option(c.name, c.name)));
  select.value = current;
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

// ----------------------------------------------------------------- themes

/*
 * Themes are CSS files served by the server (see src/themes.ts). Applying
 * one just means pointing a <link> at it; index.html has four, in order:
 *
 *   theme-app           the app theme                  /themes/<id>/theme.css
 *   theme-app-lite      its Lite version, if in use    /themes/<id>/theme-lite.css
 *   theme-channel       the open channel's own theme   /themes/<id>/channel.css
 *   theme-channel-lite  its Lite version, if in use    /themes/<id>/channel-lite.css
 *
 * The channel versions are rewritten by the server to only affect the
 * channel view. And while a channel theme is showing, the app theme is
 * loaded as `outside.css` instead: rewritten to affect everything *but* the
 * channel view, so the channel theme fully replaces it there.
 */

/** Keys for things remembered on this device only (in the browser's localStorage). */
const EFFECTS_KEY = "aettica.effects"; // "auto" | "full" | "lite"
const AUTO_LITE_KEY = "aettica.autoLite"; // "1" once Automatic has switched to Lite
const LAST_THEME_KEY = "aettica.lastAppTheme"; // to apply the theme before the server answers

/*
 * localStorage can be unavailable (private browsing, storage turned off),
 * so every use is wrapped: if it fails, Aettica just forgets.
 */
function readLocal(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocal(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Nothing to do: the setting just won't be remembered.
  }
}

/** This device's glass effects choice: "auto", "full" or "lite". */
function effectsMode() {
  return readLocal(EFFECTS_KEY) ?? "auto";
}

/** Whether Lite versions of themes should be loaded right now. */
function liteEffects() {
  const mode = effectsMode();
  return mode === "lite" || (mode === "auto" && readLocal(AUTO_LITE_KEY) === "1");
}

function themeInfo(id) {
  return state.themes.find((t) => t.id === id);
}

/**
 * Point a theme <link> at a stylesheet, or unload it (`href` null).
 *
 * Swapping one stylesheet for another would briefly show the page without
 * either while the new one downloads. So the new one is loaded in a second
 * <link> next to the old, and the old is removed once the new has arrived.
 * A theme can also change the layout (spacing, fonts), so after it loads,
 * the view scrolls back to the newest message.
 */
function setStylesheet(linkId, href) {
  const link = $(linkId);
  const current = link.getAttribute("href");
  if (!href) {
    link.removeAttribute("href");
    return;
  }
  if (current === href) return;
  if (!current) {
    link.addEventListener("load", scrollToBottom, { once: true });
    link.setAttribute("href", href);
    return;
  }
  const next = link.cloneNode();
  next.setAttribute("href", href);
  link.removeAttribute("id"); // the new link takes over the id straight away
  const done = () => {
    link.remove();
    scrollToBottom();
  };
  next.addEventListener("load", done, { once: true });
  next.addEventListener("error", done, { once: true });
  link.after(next);
}

/** The app theme and the open channel's theme, if it has a different one. */
function activeThemes() {
  const app = state.settings?.appTheme ?? "classic";
  const channel = currentChannel();
  return { app, channel: channel?.theme && channel.theme !== app ? channel.theme : null };
}

/** Load the stylesheets for the current app theme, channel theme and effects. */
function applyThemes() {
  const { app, channel } = activeThemes();
  const lite = liteEffects();
  const v = state.themeVersion;
  // Classic is the base stylesheet itself, so there's nothing to load for it.
  const appTheme = app === "classic" ? null : app;

  const appFile = channel ? "outside" : "theme";
  setStylesheet("theme-app", appTheme && `/themes/${appTheme}/${appFile}.css?v=${v}`);
  setStylesheet("theme-app-lite", appTheme && lite && themeInfo(appTheme)?.hasLite && `/themes/${appTheme}/${appFile}-lite.css?v=${v}`);
  setStylesheet("theme-channel", channel && `/themes/${channel}/channel.css?v=${v}`);
  setStylesheet("theme-channel-lite", channel && lite && themeInfo(channel)?.hasLite && `/themes/${channel}/channel-lite.css?v=${v}`);

  // For theme authors: the channel view says which channel theme it has.
  els.channelView.dataset.channelTheme = channel ?? "";
  writeLocal(LAST_THEME_KEY, appTheme ?? "");
}

async function loadThemes() {
  state.themes = (await api("GET", "/api/themes")).themes;
}

/*
 * Automatic glass effects: real blur can make scrolling stutter on some
 * phones. In Automatic mode, the first few times you scroll the message
 * list, the page times its frames. Once it has watched STUTTER_SAMPLES
 * frames or STUTTER_WATCH_MS of scrolling (a stuttering phone draws few
 * frames, so time matters too), it judges: if a typical frame took longer
 * than STUTTER_FRAME_MS (fewer than about 35 frames a second), it switches
 * this device to the Lite versions of themes, and says so.
 */
const STUTTER_FRAME_MS = 28;
const STUTTER_SAMPLES = 90;
const STUTTER_WATCH_MS = 2500;
const stutter = { samples: [], watchedMs: 0, sampling: false, done: false };

function watchForStutter() {
  if (stutter.done || stutter.sampling || effectsMode() !== "auto" || liteEffects()) return;
  // Only worth measuring if a theme with a Lite version is in use.
  const { app, channel } = activeThemes();
  if (!themeInfo(app)?.hasLite && !themeInfo(channel)?.hasLite) return;

  stutter.sampling = true;
  let last = performance.now();
  const stopAt = last + 1000; // sample for a second after scrolling starts
  const frame = (now) => {
    stutter.samples.push(now - last);
    stutter.watchedMs += now - last;
    last = now;
    if (now < stopAt) {
      requestAnimationFrame(frame);
    } else {
      stutter.sampling = false;
      judgeStutter();
    }
  };
  requestAnimationFrame(frame);
}

function judgeStutter() {
  // Keep collecting on later scrolls until there's enough to go on.
  if (stutter.samples.length < STUTTER_SAMPLES && stutter.watchedMs < STUTTER_WATCH_MS) return;
  stutter.done = true;
  const sorted = [...stutter.samples].sort((a, b) => a - b);
  const typicalFrame = sorted[Math.floor(sorted.length / 2)];
  if (typicalFrame > STUTTER_FRAME_MS) {
    writeLocal(AUTO_LITE_KEY, "1");
    applyThemes();
    showNotice("Scrolling was stuttering, so glass effects switched to Lite on this device. You can change this in Appearance.");
  }
}

function showNotice(text) {
  $("notice-text").textContent = text;
  $("notice").hidden = false;
}

// ------------------------------------------------------------- appearance

function openAppearance() {
  renderThemeList();
  for (const radio of document.querySelectorAll('input[name="effects"]')) radio.checked = radio.value === effectsMode();
  hideFormError($("appearance-dialog"));
  $("appearance-dialog").showModal();
}

/** The theme cards in Appearance. The app theme is the selected one. */
function renderThemeList() {
  const selected = state.settings.appTheme;
  $("theme-list").replaceChildren(
    ...state.themes.map((theme) => {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "theme-card";
      card.setAttribute("role", "radio");
      card.setAttribute("aria-checked", String(theme.id === selected));

      // The preview: a strip of the theme's colours.
      const swatch = document.createElement("span");
      swatch.className = "theme-swatch";
      for (const colour of theme.swatch.length ? theme.swatch : ["var(--input-bg)"]) {
        const part = document.createElement("span");
        part.style.background = colour;
        swatch.append(part);
      }

      const name = document.createElement("span");
      name.className = "theme-name";
      name.textContent = theme.name;
      const badge = document.createElement("span");
      badge.className = "theme-badge";
      badge.textContent = theme.builtIn ? "Built-in" : "Yours";
      name.append(" ", badge);

      const description = document.createElement("span");
      description.className = "theme-description";
      description.textContent = theme.description;

      card.append(swatch, name, description);
      card.addEventListener("click", () => chooseAppTheme(theme.id));
      return card;
    }),
  );

  // Edit and Delete are only for your own themes.
  const current = themeInfo(selected);
  $("theme-edit").hidden = !current || current.builtIn;
  $("theme-delete").hidden = !current || current.builtIn;
}

async function chooseAppTheme(id) {
  try {
    const { settings } = await api("PUT", "/api/settings", { appTheme: id });
    state.settings = settings;
    renderThemeList();
    renderAll();
  } catch (error) {
    showFormError($("appearance-dialog"), error.message);
  }
}

/** Copy the selected theme into a new theme of your own, and open it in the editor. */
async function copyTheme() {
  const source = themeInfo(state.settings.appTheme);
  const name = prompt("Name for your theme:", source ? `My ${source.name}` : "My theme");
  if (!name) return;
  try {
    const { theme } = await api("POST", "/api/themes", { name, from: source?.id });
    await loadThemes();
    await chooseAppTheme(theme.id);
    openThemeEditor(theme.id);
  } catch (error) {
    showFormError($("appearance-dialog"), error.message);
  }
}

async function deleteTheme() {
  const theme = themeInfo(state.settings.appTheme);
  if (!theme || !confirm(`Delete the theme "${theme.name}" and its images? This can't be undone.`)) return;
  try {
    const data = await api("DELETE", `/api/themes/${encodeURIComponent(theme.id)}`, {});
    // Anything that used it has gone back to the default.
    state.settings = data.settings;
    state.channels = data.channels;
    await loadThemes();
    renderThemeList();
    renderAll();
  } catch (error) {
    showFormError($("appearance-dialog"), error.message);
  }
}

function chooseEffects(mode) {
  writeLocal(EFFECTS_KEY, mode);
  if (mode === "auto") {
    // Choosing Automatic again starts the stutter check afresh.
    writeLocal(AUTO_LITE_KEY, null);
    Object.assign(stutter, { samples: [], watchedMs: 0, sampling: false, done: false });
  }
  applyThemes();
}

// ----------------------------------------------------------- theme editor

async function openThemeEditor(id) {
  try {
    const { theme } = await api("GET", `/api/themes/${encodeURIComponent(id)}`);
    state.editingTheme = theme;
    const form = $("theme-editor-form").elements;
    form.name.value = theme.name;
    form.description.value = theme.description;
    form.css.value = theme.css;
    form.liteCss.value = theme.liteCss;
    renderThemeFiles(theme.files);
    hideFormError($("theme-editor-form"));
    $("theme-editor").showModal();
  } catch (error) {
    showFormError($("appearance-dialog"), error.message);
  }
}

/** Save the editor's changes and reload the theme's stylesheets. */
async function saveTheme(close) {
  const form = $("theme-editor-form").elements;
  try {
    await api("PATCH", `/api/themes/${encodeURIComponent(state.editingTheme.id)}`, {
      name: form.name.value,
      description: form.description.value,
      css: form.css.value,
      liteCss: form.liteCss.value,
    });
    state.themeVersion++;
    await loadThemes();
    renderThemeList();
    renderAll();
    if (close) $("theme-editor").close();
  } catch (error) {
    showFormError($("theme-editor-form"), error.message);
  }
}

/** The list of images and fonts in the theme being edited. */
function renderThemeFiles(files) {
  const list = $("theme-files");
  if (files.length === 0) {
    const empty = document.createElement("li");
    empty.className = "hint";
    empty.textContent = "No files yet.";
    list.replaceChildren(empty);
    return;
  }
  list.replaceChildren(
    ...files.map((name) => {
      const item = document.createElement("li");
      const label = document.createElement("code");
      label.textContent = name;
      item.append(label, actionButton("Remove", () => removeThemeFile(name)));
      return item;
    }),
  );
}

/** Upload the chosen files into the theme being edited. */
async function uploadThemeFiles(fileList) {
  const id = state.editingTheme.id;
  for (const file of fileList) {
    try {
      const data = await readAsBase64(file);
      const { files } = await api("POST", `/api/themes/${encodeURIComponent(id)}/files`, { name: file.name, data });
      renderThemeFiles(files);
    } catch (error) {
      showFormError($("theme-editor-form"), `${file.name}: ${error.message}`);
    }
  }
  state.themeVersion++;
  applyThemes();
}

async function removeThemeFile(name) {
  if (!confirm(`Remove ${name} from this theme?`)) return;
  try {
    const { files } = await api(
      "DELETE",
      `/api/themes/${encodeURIComponent(state.editingTheme.id)}/files/${encodeURIComponent(name)}`,
      {},
    );
    renderThemeFiles(files);
  } catch (error) {
    showFormError($("theme-editor-form"), error.message);
  }
}

/** A file's contents as base64 text (the "data:...;base64," prefix removed). */
function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(new Error("Couldn't read the file."));
    reader.readAsDataURL(file);
  });
}

// ---------------------------------------------------------------- dialogs

/** The partner prompts: who they are, and how they write in each kind of channel. */
const PROMPT_SETTINGS = ["partnerPrompt", "literaryPrompt", "casualPrompt", "oocPrompt"];

/** Server-wide settings: fill the form from `state.settings` and open it. */
function openSettings() {
  const s = state.settings;
  const form = els.settingsForm.elements;
  form.partnerName.value = s.partnerName;
  for (const key of PROMPT_SETTINGS) form[key].value = s[key];
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
      ...Object.fromEntries(PROMPT_SETTINGS.map((key) => [key, form[key].value])),
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
  form.theme.replaceChildren(
    new Option("Same as the app theme", ""),
    ...state.themes.map((t) => new Option(t.name, t.id)),
  );
  form.theme.value = channel.theme ?? "";
  // Show the mode you'll get: a waiting change if there is one.
  form.mode.value = channel.pendingMode ?? channel.mode;
  updateModeNote();
  renderCastEditor();
  els.channelForm.querySelector(".rp-only").hidden = channel.kind !== "rp";
  $("channel-kind-note").textContent =
    channel.kind === "rp"
      ? "A roleplay channel: a storyline with its own cast."
      : "An out-of-character channel. Your partner talks to you as themselves.";
  hideFormError(els.channelForm);
  els.channelDialog.showModal();
}

/**
 * Under the Style choice in channel settings: say when a mode change will
 * take effect, since a scene never mixes styles.
 */
function updateModeNote() {
  const channel = currentChannel();
  const chosen = els.channelForm.elements.mode.value;
  const note = $("channel-mode-note");
  if (!channel || chosen === channel.mode) {
    note.textContent = "";
  } else if (currentSceneIsEmpty()) {
    note.textContent = `The current scene hasn't started yet, so it will be ${chosen} right away.`;
  } else {
    note.textContent = `Scenes never mix styles, so this takes effect at the next scene break.`;
  }
}

function openNewChannel() {
  els.newChannelForm.reset();
  // Your partner's characters (and shared ones), to start the cast with.
  $("new-channel-cast").replaceChildren(
    new Option("Nobody yet", ""),
    ...state.notebook.entries
      .filter((e) => e.kind === "character" && e.owner !== "user")
      .map((e) => new Option(e.name, e.id)),
  );
  hideFormError(els.newChannelForm);
  updateNewChannelKind();
  els.newChannelDialog.showModal();
}

/** Show the style and cast choices only when "Roleplay" is picked. */
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

// --------------------------------------------------------------- notebook

/*
 * The notebook holds characters and lore, yours, your partner's and shared
 * ones. The server decides what you can see and do with each entry (see
 * src/permissions.ts) and says so in `entry.access`; the app only uses that
 * to show the right buttons. Pinning an entry to a channel puts it in that
 * channel's cast.
 */

/** Fetch the notebook from the server. */
async function loadNotebook() {
  state.notebook = await api("GET", "/api/notebook");
}

/**
 * Reload the notebook and the channels (whose casts show entry names), then
 * redraw whatever's open. Called after any change to the notebook.
 */
async function refreshNotebook() {
  const [notebook, { channels }] = await Promise.all([api("GET", "/api/notebook"), api("GET", "/api/state")]);
  state.notebook = notebook;
  state.channels = channels;
  renderAll();
  if ($("notebook-dialog").open) renderNotebook();
  if (els.channelDialog.open) renderCastEditor();
}

/** An entry by id, if you can see it. */
function findEntry(id) {
  return state.notebook.entries.find((e) => e.id === id);
}

/** "Arlo's", "yours" or "shared": whose an entry is, for badges. */
function ownerLabel(owner) {
  if (owner === "user") return "yours";
  if (owner === "joint") return "shared";
  return `${state.settings.partnerName}'s`;
}

/** Short badges for an entry in lists: its kind, owner, and what's special about it. */
function entryBadges(entry) {
  const partner = state.settings.partnerName;
  const badges = [entry.kind === "lore" ? "lore" : "character", ownerLabel(entry.owner)];
  if (entry.owner === "user") {
    if (entry.settings.visibility === "hidden") badges.push(`hidden from ${partner}`);
    if (entry.settings.editing === "suggest") badges.push(`${partner} suggests`);
    if (entry.settings.editing === "locked") badges.push("locked");
    if (entry.proxyPrefix) badges.push(`${entry.proxyPrefix}:`);
  } else if (entry.owner === "joint") {
    if (entry.proxyPrefix) badges.push(`${entry.proxyPrefix}:`);
  } else if (entry.owner === "partner") {
    if (entry.access.edit === "suggest") badges.push("you suggest");
    if (entry.access.edit === "none") badges.push("read only");
  }
  return badges;
}

/** A small round avatar in a character's colour (a book mark for lore). */
function entryAvatar(name, kind) {
  const avatar = document.createElement("span");
  avatar.className = "avatar entry-avatar";
  avatar.dataset.kind = kind;
  avatar.style.setProperty("--avatar-hue", hueFor(name));
  avatar.textContent = kind === "lore" ? "§" : initial(name);
  avatar.setAttribute("aria-hidden", "true");
  return avatar;
}

function badge(text) {
  const span = document.createElement("span");
  span.className = "entry-badge";
  span.textContent = text;
  return span;
}

function openNotebook() {
  hideFormError($("notebook-dialog"));
  renderNotebook();
  $("notebook-dialog").showModal();
  // Get the latest (your partner may change it, from stage 6).
  refreshNotebook().catch((error) => showFormError($("notebook-dialog"), error.message));
}

/** Draw the notebook dialog: suggestions waiting, then entries by folder. */
function renderNotebook() {
  renderSuggestions();

  const { folders, entries } = state.notebook;
  const folderIds = new Set(folders.map((f) => f.id));
  const groups = [
    { folder: null, entries: entries.filter((e) => !e.folderId || !folderIds.has(e.folderId)) },
    ...folders.map((folder) => ({ folder, entries: entries.filter((e) => e.folderId === folder.id) })),
  ];

  const list = $("notebook-list");
  if (entries.length === 0 && folders.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty notebook-empty";
    empty.textContent = "The notebook is empty. Add a character to start a cast.";
    list.replaceChildren(empty);
    return;
  }

  list.replaceChildren(
    ...groups
      .filter((group) => group.folder || group.entries.length > 0)
      .map(({ folder, entries }) => {
        const section = document.createElement("section");
        section.className = "notebook-folder";
        if (folder) {
          const header = document.createElement("header");
          header.className = "notebook-folder-header";
          const name = document.createElement("span");
          name.className = "notebook-folder-name";
          name.textContent = folder.name;
          header.append(name);
          if (folder.owner !== "user") header.append(badge(ownerLabel(folder.owner)));
          if (folder.visibility === "hidden") header.append(badge(`hidden from ${state.settings.partnerName}`));
          if (folder.owner === "user") {
            const edit = document.createElement("button");
            edit.type = "button";
            edit.className = "link-button";
            edit.textContent = "Edit folder";
            edit.addEventListener("click", () => openFolder(folder));
            header.append(edit);
          }
          section.append(header);
        }

        const items = document.createElement("ul");
        items.className = "notebook-entries";
        for (const entry of entries) {
          const item = document.createElement("li");
          const button = document.createElement("button");
          button.type = "button";
          button.className = "notebook-entry";
          button.dataset.kind = entry.kind;
          button.dataset.owner = entry.owner;
          const name = document.createElement("span");
          name.className = "notebook-entry-name";
          name.textContent = entry.name;
          const badges = document.createElement("span");
          badges.className = "notebook-entry-badges";
          badges.append(...entryBadges(entry).map(badge));
          if (entry.pinnedIn.includes(state.channelId) && currentChannel()) {
            badges.append(badge(`in #${currentChannel().name}`));
          }
          button.append(entryAvatar(entry.name, entry.kind), name, badges);
          button.addEventListener("click", () => openEntry(entry));
          item.append(button);
          items.append(item);
        }
        if (entries.length === 0) {
          const empty = document.createElement("li");
          empty.className = "hint";
          empty.textContent = "Empty. Move entries here from their settings.";
          items.append(empty);
        }
        section.append(items);
        return section;
      }),
  );
}

/**
 * Suggested changes still waiting: yours (waiting for your partner, who
 * reviews them from stage 6) and theirs (waiting for you).
 */
function renderSuggestions() {
  const box = $("suggestion-list");
  const suggestions = state.notebook.suggestions;
  box.hidden = suggestions.length === 0;
  if (box.hidden) return;

  const partner = state.settings.partnerName;
  const title = document.createElement("h3");
  title.className = "suggestion-title";
  title.textContent = "Suggestions";
  box.replaceChildren(
    title,
    ...suggestions.map((suggestion) => {
      const entry = findEntry(suggestion.entryId);
      const row = document.createElement("div");
      row.className = "suggestion";
      row.dataset.author = suggestion.author;

      const text = document.createElement("span");
      text.className = "suggestion-text";
      const who = suggestion.author === "user" ? "You suggested" : `${partner} suggested`;
      text.textContent = `${who} ${describeChange(suggestion.change)} for ${entry?.name ?? "an entry"}.`;
      row.append(text);

      // Who reviews it: the owner, or for shared lore, whoever didn't suggest it.
      const reviewer = entry?.owner === "joint" ? (suggestion.author === "user" ? "partner" : "user") : entry?.owner;
      if (reviewer === "user") {
        row.append(
          suggestionButton("Accept", suggestion.id, "accept"),
          suggestionButton("Reject", suggestion.id, "reject"),
        );
      } else {
        const waiting = document.createElement("span");
        waiting.className = "hint";
        waiting.textContent = `Waiting for ${partner}.`;
        row.append(waiting);
      }
      if (suggestion.author === "user") row.append(suggestionButton("Withdraw", suggestion.id, "withdraw"));
      return row;
    }),
  );
}

/** "renaming it to X", "changes to its fields", ... for the suggestion list. */
function describeChange(change) {
  if (change.delete) return "deleting it";
  const parts = [];
  if (change.name !== undefined) parts.push(`renaming it to "${change.name}"`);
  if (change.fields !== undefined) parts.push("changes to its fields");
  if (change.systemPrompt !== undefined) parts.push("changes to its notes");
  return parts.join(" and ") || "a change";
}

function suggestionButton(label, id, action) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "link-button";
  button.textContent = label;
  button.addEventListener("click", async () => {
    try {
      await api("POST", `/api/notebook/suggestions/${encodeURIComponent(id)}/${action}`, {});
      await refreshNotebook();
    } catch (error) {
      showFormError($("notebook-dialog"), error.message);
    }
  });
  return button;
}

// ------------------------------------------------------ the entry editor

/**
 * Open an entry in the editor, or start a new one.
 *
 * @param entry  An entry from `state.notebook.entries`, or `{kind}` for a new one.
 * @param pinTo  For a new entry: a channel to pin it to once it's made.
 */
function openEntry(entry, pinTo = null) {
  const isNew = !entry.id;
  if (isNew) {
    entry = {
      kind: entry.kind,
      name: "",
      fields: state.notebook.templates[entry.kind].map((label) => ({ label, value: "" })),
      systemPrompt: "",
      proxyPrefix: null,
      folderId: null,
      owner: entry.owner ?? "user",
      visibility: null,
      editing: null,
      settings: { owner: "user", visibility: "visible", editing: "open" },
      access: { edit: "direct", settings: true, delete: false },
      pinnedIn: [],
    };
  }
  state.editingEntry = { ...entry, isNew, pinTo };

  const form = $("entry-form");
  const fields = form.elements;
  hideFormError(form);
  const kindName = entry.kind === "lore" ? "lore" : "character";
  $("entry-title").textContent = isNew ? `New ${kindName}` : entry.name;
  fields.name.value = entry.name;
  fields.systemPrompt.value = entry.systemPrompt;
  fields.proxyPrefix.value = entry.proxyPrefix ?? "";
  renderEntryFields(entry.fields);

  // Contents: editable unless the entry is locked to you.
  const readOnly = entry.access.edit === "none";
  for (const input of [fields.name, fields.systemPrompt, fields.proxyPrefix]) input.readOnly = readOnly;
  $("entry-add-field").hidden = readOnly;

  // Settings: only the owner can change them.
  renderEntrySettings(entry);
  $("entry-settings").disabled = !entry.access.settings;

  $("entry-access").textContent = accessNote(entry, isNew);
  const save = $("entry-save");
  save.hidden = readOnly && !entry.access.settings;
  save.textContent = isNew ? "Create" : entry.access.edit === "suggest" && !entry.access.settings ? "Suggest changes" : "Save";

  const del = $("entry-delete");
  del.hidden = isNew || !(entry.access.delete || entry.access.edit === "suggest");
  del.textContent = entry.access.delete ? "Delete" : "Suggest deleting";

  renderEntryPin();
  renderEntryLinks();
  updateEntryForm();
  $("entry-dialog").showModal();
  // Sized once the dialog is showing, when the boxes have a width.
  for (const box of $("entry-fields").querySelectorAll(".entry-field-value")) fitToText(box);
}

/** Grow a text box to show all its text, up to about 12 lines (then it scrolls). */
function fitToText(box) {
  box.style.height = "auto";
  box.style.height = `${Math.min(box.scrollHeight + 2, 300)}px`;
}

/** The line under the entry's title: whose it is, and what you can do with it. */
function accessNote(entry, isNew) {
  const partner = state.settings.partnerName;
  if (isNew) return `Pick who owns it below: you, ${partner}, or both of you (shared).`;
  if (entry.owner === "joint") {
    const play = entry.kind === "character" ? " Either of you can play them, and the proxy prefix is yours to set." : "";
    return `Shared by both of you. Changes are suggestions, for the other one to accept.${play}`;
  }
  if (entry.owner === "user") {
    return entry.kind === "character" ? "Your character: you play them." : "Your lore.";
  }
  const whose = entry.kind === "character" ? `${partner}'s character: they play them.` : `${partner}'s lore.`;
  if (entry.access.edit === "direct") return `${whose} You can edit it.`;
  if (entry.access.edit === "suggest") return `${whose} Your changes are sent to ${partner} as suggestions.`;
  return `${whose} Only ${partner} can change it.`;
}

/** The labelled fields, one row each: label, value, and a remove button. */
function renderEntryFields(fields) {
  const readOnly = state.editingEntry.access.edit === "none";
  $("entry-fields").replaceChildren(
    ...fields.map((field) => {
      const row = document.createElement("div");
      row.className = "entry-field";
      const label = document.createElement("input");
      label.className = "entry-field-label";
      label.value = field.label;
      label.placeholder = "Label";
      label.setAttribute("aria-label", "Field label");
      const value = document.createElement("textarea");
      value.className = "entry-field-value";
      value.value = field.value;
      value.rows = 1;
      value.setAttribute("aria-label", field.label || "Field value");
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "link-button entry-field-remove";
      remove.textContent = "✕";
      remove.title = "Remove this field";
      remove.setAttribute("aria-label", "Remove this field");
      remove.addEventListener("click", () => {
        row.remove();
        renderEntryLinks();
      });
      label.readOnly = value.readOnly = readOnly;
      remove.hidden = readOnly;
      row.append(label, value, remove);
      return row;
    }),
  );
}

/**
 * The fields as typed in the editor. Rows with no label are skipped, unless
 * `keepBlank` (for redrawing the editor without losing a half-typed row).
 */
function readEntryFields(keepBlank = false) {
  return [...$("entry-fields").querySelectorAll(".entry-field")]
    .map((row) => ({
      label: row.querySelector(".entry-field-label").value.trim(),
      value: row.querySelector(".entry-field-value").value,
    }))
    .filter((field) => keepBlank || field.label !== "");
}

/** Fill the settings selects for an entry. */
function renderEntrySettings(entry) {
  const partner = state.settings.partnerName;
  const fields = $("entry-form").elements;
  fields.owner.replaceChildren(
    new Option("You", "user"),
    new Option(partner, "partner"),
    new Option("Shared (both of you)", "joint"),
  );
  fields.owner.value = entry.owner;
  fields.folderId.replaceChildren(
    new Option("No folder", ""),
    ...state.notebook.folders.map((f) => new Option(f.name, f.id)),
  );
  fields.folderId.value = entry.folderId ?? "";
  fillEntrySettingChoices(entry.visibility, entry.editing);
}

/**
 * The visibility and editing choices depend on the owner (hidden from
 * whom?) and the folder (what "the folder's setting" means), so they're
 * redrawn when either changes. Keeps the current choice.
 */
function fillEntrySettingChoices(visibility, editing) {
  const fields = $("entry-form").elements;
  const owner = fields.owner.value;
  const folder = state.notebook.folders.find((f) => f.id === fields.folderId.value);
  const other = owner === "partner" ? "you" : state.settings.partnerName;

  const visibilityNames = { visible: "Visible to both", hidden: `Hidden from ${other}` };
  const editingNames = { open: "Edit it", suggest: "Suggest changes", locked: "Only read it" };
  fields.visibility.replaceChildren(
    new Option(`Folder's setting (${visibilityNames[folder?.visibility ?? "visible"].toLowerCase()})`, ""),
    new Option(visibilityNames.visible, "visible"),
    new Option(visibilityNames.hidden, "hidden"),
  );
  fields.editing.replaceChildren(
    new Option(`Folder's setting (${editingNames[folder?.editing ?? "open"].toLowerCase()})`, ""),
    new Option(editingNames.open, "open"),
    new Option(editingNames.suggest, "suggest"),
    new Option(editingNames.locked, "locked"),
  );
  fields.visibility.value = visibility ?? "";
  fields.editing.value = editing ?? "";
  $("entry-editing-label").textContent = owner === "partner" ? "You can" : `${state.settings.partnerName} can`;
}

/**
 * Keep the form consistent with the chosen owner: shared lore is always
 * visible and suggest-only, and only your characters have a proxy prefix.
 */
function updateEntryForm() {
  const entry = state.editingEntry;
  const fields = $("entry-form").elements;
  const owner = fields.owner.value;
  const fixed = owner === "joint" || (entry.isNew && owner === "partner");
  fields.visibility.disabled = fields.editing.disabled = fixed;
  $("entry-prefix-row").hidden = !canHavePrefix(entry.kind, owner);
}

/** The pin button: pin to, or unpin from, the open roleplay channel. */
function renderEntryPin() {
  const entry = state.editingEntry;
  const channel = currentChannel();
  const button = $("entry-pin");
  button.hidden = entry.isNew || !channel || channel.kind !== "rp";
  if (button.hidden) return;
  button.textContent = entry.pinnedIn.includes(channel.id) ? `Unpin from #${channel.name}` : `Pin to #${channel.name}`;
}

async function toggleEntryPin() {
  const entry = state.editingEntry;
  const channel = currentChannel();
  const pinned = entry.pinnedIn.includes(channel.id);
  try {
    await api(pinned ? "DELETE" : "PUT", channelPath(`cast/${encodeURIComponent(entry.id)}`, channel.id), {});
    await refreshNotebook();
    state.editingEntry = { ...state.editingEntry, pinnedIn: findEntry(entry.id)?.pinnedIn ?? [] };
    renderEntryPin();
  } catch (error) {
    showFormError($("entry-form"), error.message);
  }
}

/**
 * Under the text: the entries it links to with [[Name]], as buttons that
 * open them. Links to names that aren't in the notebook are listed too, so
 * a typo shows.
 */
function renderEntryLinks() {
  const text = [$("entry-form").elements.systemPrompt.value, ...readEntryFields().map((f) => f.value)].join("\n");
  const names = [...new Set([...text.matchAll(/\[\[([^\]|\n]{1,100})(?:\|[^\]\n]*)?\]\]/g)].map((m) => m[1].trim()))];
  const box = $("entry-links");
  box.hidden = names.length === 0;
  if (box.hidden) return;

  const label = document.createElement("span");
  label.className = "entry-links-label";
  label.textContent = "Links to:";
  box.replaceChildren(
    label,
    ...names.map((name) => {
      const target = state.notebook.entries.find((e) => e.name.toLowerCase() === name.toLowerCase());
      if (!target) {
        const missing = document.createElement("span");
        missing.className = "entry-link missing";
        missing.textContent = name;
        missing.title = "Nothing in the notebook has this name";
        return missing;
      }
      const link = document.createElement("button");
      link.type = "button";
      link.className = "link-button entry-link";
      link.textContent = target.name;
      link.addEventListener("click", () => {
        $("entry-dialog").close();
        openEntry(target);
      });
      return link;
    }),
  );
}

/** Save the entry editor: create, edit (or suggest), and change settings. */
async function saveEntry(event) {
  event.preventDefault();
  const entry = state.editingEntry;
  const form = $("entry-form");
  const fields = form.elements;
  const owner = fields.owner.value;
  const contents = {
    name: fields.name.value,
    fields: readEntryFields(),
    systemPrompt: fields.systemPrompt.value,
  };
  const prefix = canHavePrefix(entry.kind, owner) ? fields.proxyPrefix.value.trim() || null : null;
  // Shared lore's settings are fixed, and only an entry's owner picks them.
  const settings = {
    owner,
    folderId: fields.folderId.value || null,
    visibility: fields.visibility.disabled ? null : fields.visibility.value || null,
    editing: fields.editing.disabled ? null : fields.editing.value || null,
  };

  try {
    if (entry.isNew) {
      const { entry: created } = await api("POST", "/api/notebook/entries", {
        kind: entry.kind,
        ...contents,
        proxyPrefix: prefix,
        ...settings,
      });
      if (entry.pinTo) await api("PUT", channelPath(`cast/${encodeURIComponent(created.id)}`, entry.pinTo), {});
    } else {
      // Send only what changed, so a suggestion says exactly what you suggest.
      const changes = {};
      if (contents.name !== entry.name) changes.name = contents.name;
      if (JSON.stringify(contents.fields) !== JSON.stringify(entry.fields)) changes.fields = contents.fields;
      if (contents.systemPrompt !== entry.systemPrompt) changes.systemPrompt = contents.systemPrompt;
      if (canHavePrefix(entry.kind, entry.owner) && prefix !== entry.proxyPrefix) changes.proxyPrefix = prefix;
      if (Object.keys(changes).length > 0 && entry.access.edit !== "none") {
        await api("PATCH", `/api/notebook/entries/${encodeURIComponent(entry.id)}`, changes);
      }
      const settingsChanged =
        settings.owner !== entry.owner ||
        settings.folderId !== entry.folderId ||
        settings.visibility !== entry.visibility ||
        settings.editing !== entry.editing;
      if (settingsChanged && entry.access.settings) {
        await api("PUT", `/api/notebook/entries/${encodeURIComponent(entry.id)}/settings`, settings);
      }
    }
    $("entry-dialog").close();
    await refreshNotebook();
  } catch (error) {
    showFormError(form, error.message);
  }
}

/** Delete an entry, or suggest deleting it when it isn't yours to delete. */
async function deleteEntry() {
  const entry = state.editingEntry;
  const question = entry.access.delete
    ? `Delete ${entry.name}? It's unpinned from every channel. This can't be undone.`
    : `Suggest deleting ${entry.name}? It stays until the suggestion is accepted.`;
  if (!confirm(question)) return;
  try {
    await api("DELETE", `/api/notebook/entries/${encodeURIComponent(entry.id)}`, {});
    $("entry-dialog").close();
    await refreshNotebook();
  } catch (error) {
    showFormError($("entry-form"), error.message);
  }
}

// ------------------------------------------------------------- folders

function openFolder(folder = null) {
  state.editingFolder = folder;
  const form = $("folder-form");
  hideFormError(form);
  $("folder-title").textContent = folder ? "Edit folder" : "New folder";
  form.elements.name.value = folder?.name ?? "";
  form.elements.visibility.value = folder?.visibility ?? "visible";
  form.elements.editing.value = folder?.editing ?? "open";
  $("folder-delete").hidden = !folder;
  $("folder-dialog").showModal();
}

async function saveFolder(event) {
  event.preventDefault();
  const form = $("folder-form");
  const body = {
    name: form.elements.name.value,
    visibility: form.elements.visibility.value,
    editing: form.elements.editing.value,
  };
  try {
    const folder = state.editingFolder;
    if (folder) await api("PATCH", `/api/notebook/folders/${encodeURIComponent(folder.id)}`, body);
    else await api("POST", "/api/notebook/folders", body);
    $("folder-dialog").close();
    await refreshNotebook();
  } catch (error) {
    showFormError(form, error.message);
  }
}

async function deleteFolder() {
  const folder = state.editingFolder;
  if (!confirm(`Delete the folder "${folder.name}"? The entries in it are kept, outside any folder.`)) return;
  try {
    await api("DELETE", `/api/notebook/folders/${encodeURIComponent(folder.id)}`, {});
    $("folder-dialog").close();
    await refreshNotebook();
  } catch (error) {
    showFormError($("folder-form"), error.message);
  }
}

// ---------------------------------------------------------------- cast

/**
 * The cast in channel settings: who's pinned, with a button to unpin each,
 * and a menu to pin more from the notebook (or make a new entry).
 */
function renderCastEditor() {
  const channel = currentChannel();
  if (!channel || channel.kind !== "rp") return;
  const partner = state.settings.partnerName;

  const list = $("cast-list");
  list.replaceChildren(
    ...channel.cast.map((member) => {
      const item = document.createElement("li");
      item.className = "cast-member";
      item.dataset.playedBy = member.playedBy;
      item.dataset.kind = member.kind;
      if (member.hidden) item.classList.add("hidden-entry");

      const name = document.createElement(member.hidden ? "span" : "button");
      name.className = member.hidden ? "cast-member-name" : "link-button cast-member-name";
      name.textContent = member.name;
      if (!member.hidden) {
        name.type = "button";
        name.addEventListener("click", () => {
          const entry = findEntry(member.entryId);
          if (entry) openEntry(entry);
        });
      }

      const roles = { user: "you play", partner: `${partner} plays`, both: "you both play" };
      const role = member.kind === "lore" ? "lore" : roles[member.playedBy];
      const unpin = document.createElement("button");
      unpin.type = "button";
      unpin.className = "link-button cast-unpin";
      unpin.textContent = "Unpin";
      unpin.addEventListener("click", () => changeCast(member.entryId, false));
      item.append(entryAvatar(member.hidden ? "?" : member.name, member.kind), name, badge(role), unpin);
      return item;
    }),
  );
  if (channel.cast.length === 0) {
    const empty = document.createElement("li");
    empty.className = "hint";
    empty.textContent = `Nobody yet. Without a cast, ${partner} narrates.`;
    list.append(empty);
  }

  // Everything you can see that isn't pinned yet, characters first.
  const pinned = new Set(channel.cast.map((c) => c.entryId));
  const unpinned = state.notebook.entries.filter((e) => !pinned.has(e.id));
  const group = (label, kind) => {
    const optgroup = document.createElement("optgroup");
    optgroup.label = label;
    optgroup.append(...unpinned.filter((e) => e.kind === kind).map((e) => new Option(`${e.name} (${ownerLabel(e.owner)})`, e.id)));
    return optgroup;
  };
  const make = document.createElement("optgroup");
  make.label = "New";
  make.append(new Option("New character…", "new:character"), new Option("New lore…", "new:lore"));
  $("cast-add").replaceChildren(new Option("Add to the cast…", ""), group("Characters", "character"), group("Lore", "lore"), make);
}

/** Pin (`true`) or unpin (`false`) an entry in the open channel, straight away. */
async function changeCast(entryId, pin) {
  try {
    const { channel } = await api(pin ? "PUT" : "DELETE", channelPath(`cast/${encodeURIComponent(entryId)}`), {});
    updateChannelInState(channel);
    await loadNotebook(); // each entry lists where it's pinned
    renderAll();
    renderCastEditor();
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
$("appearance-button").addEventListener("click", openAppearance);
$("theme-copy").addEventListener("click", copyTheme);
$("theme-edit").addEventListener("click", () => openThemeEditor(state.settings.appTheme));
$("theme-delete").addEventListener("click", deleteTheme);
$("appearance-dialog").addEventListener("change", (event) => {
  if (event.target.name === "effects") chooseEffects(event.target.value);
});
$("theme-editor-form").addEventListener("submit", (event) => {
  event.preventDefault();
  saveTheme(true);
});
$("theme-apply").addEventListener("click", () => saveTheme(false));
$("theme-upload").addEventListener("change", (event) => {
  uploadThemeFiles([...event.target.files]);
  event.target.value = ""; // so choosing the same file again still counts
});
$("notice-dismiss").addEventListener("click", () => ($("notice").hidden = true));
els.messages.addEventListener("scroll", watchForStutter, { passive: true });
$("scene-button").addEventListener("click", newScene);
$("posting-as").addEventListener("change", (event) => state.postingAs.set(state.channelId, event.target.value));
els.channelForm.addEventListener("change", (event) => {
  if (event.target.name === "mode") updateModeNote();
});
$("update-reload").addEventListener("click", () => location.reload());

// Coming back to the app (switching to it, unlocking the phone) is when an
// update is most likely to have happened while it sat in the background.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") checkServerVersion();
});
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

$("cast-add").addEventListener("change", (event) => {
  const value = event.target.value;
  event.target.value = "";
  if (value.startsWith("new:")) openEntry({ kind: value.slice(4), owner: "partner" }, state.channelId);
  else if (value) changeCast(value, true);
});

$("notebook-button").addEventListener("click", openNotebook);
$("notebook-new-character").addEventListener("click", () => openEntry({ kind: "character" }));
$("notebook-new-lore").addEventListener("click", () => openEntry({ kind: "lore", owner: "joint" }));
$("notebook-new-folder").addEventListener("click", () => openFolder());
$("entry-form").addEventListener("submit", saveEntry);
$("entry-form").addEventListener("change", (event) => {
  const fields = event.currentTarget.elements;
  if (event.target === fields.owner || event.target === fields.folderId) {
    fillEntrySettingChoices(fields.visibility.value || null, fields.editing.value || null);
    updateEntryForm();
  }
});
$("entry-form").addEventListener("input", (event) => {
  if (event.target.classList.contains("entry-field-value")) fitToText(event.target);
  renderEntryLinks();
});
$("entry-add-field").addEventListener("click", () => {
  renderEntryFields([...readEntryFields(true), { label: "", value: "" }]);
  for (const box of $("entry-fields").querySelectorAll(".entry-field-value")) fitToText(box);
  $("entry-fields").querySelector(".entry-field:last-child .entry-field-label").focus();
});
$("entry-pin").addEventListener("click", toggleEntryPin);
$("entry-delete").addEventListener("click", deleteEntry);
$("folder-form").addEventListener("submit", saveFolder);
$("folder-delete").addEventListener("click", deleteFolder);

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
// Apply the last app theme straight away, so the page doesn't flash the
// default look while the server answers. (applyThemes corrects it after.)
if (readLocal(LAST_THEME_KEY)) setStylesheet("theme-app", `/themes/${readLocal(LAST_THEME_KEY)}/theme.css?v=0`);

Promise.all([loadState(), loadThemes(), loadNotebook()])
  .then(() => {
    // A turn may already be running (from another tab, or from before a
    // reload): keep an eye on it.
    if (state.busy.size > 0) startBusyWatch();
    return openChannel(channelFromAddress() ?? state.channels[0]?.id ?? null);
  })
  .catch((error) => showError(`Couldn't load Aettica: ${error.message}`, () => location.reload()));
