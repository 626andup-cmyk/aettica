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
  /** Connection profiles: {id, name, model, temperature, maxTokens, topP, reasoningEffort, supportsTools, quirkPrompt, extraParams}. */
  profiles: [],
  /** Roulettes: {id, name, entries: [{profileId, weight}]}. */
  roulettes: [],
  /** The profile or roulette open in its editor (null for a new one). */
  editingProfile: null,
  editingRoulette: null,
  /** The open channel's tool calls (your partner's actions), oldest first. */
  toolCalls: [],
  /** The open channel's comment threads: {id, messageId, quote, resolved, comments}. */
  threads: [],
  /** The open channel's summaries (stage 7): {scenes, story, current, digest, running, error}. */
  summaries: null,
  /** Scene breaks whose scene summary is showing. */
  openSummaries: new Set(),
  /** The scene break whose summary is being edited, if any. */
  editingSummary: null,
  /** Your partner's proposals waiting for you (e.g. deleting a channel). */
  proposals: [],
  /** The full tool log of the open channel, while the tool log is open. */
  toolLog: [],
  /** Turn ids whose action details are expanded under their messages. */
  openActivity: new Set(),
  /** Notebook entries attached to the message you're writing, by channel id: a Set of entry ids. */
  attachments: new Map(),
  /** The comment thread open in the thread dialog, or a new comment: {messageId, quote}. */
  thread: null,
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
  channelIndicator: Object.assign(document.createElement("li"), {
    className: "channel-indicator",
    ariaHidden: "true",
  }),
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
  state.profiles = data.profiles;
  state.roulettes = data.roulettes;
  state.proposals = data.proposals;
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
  state.toolCalls = [];
  state.threads = [];
  state.summaries = null;
  state.openSummaries.clear();
  hideError();

  // Put the channel in the address bar without adding a history entry for
  // every switch. (Only if it isn't there already, to avoid a loop with the
  // hashchange handler.)
  const hash = channelId ? `#/channel/${channelId}` : "";
  if (location.hash !== hash) history.replaceState(null, "", hash || location.pathname);

  if (channelId) {
    try {
      const { messages, toolCalls, threads, summaries } = await api("GET", channelPath("messages", channelId));
      // Ignore the answer if you switched again while it was loading.
      if (state.channelId !== channelId) return;
      state.messages = messages;
      state.toolCalls = toolCalls;
      state.threads = threads;
      state.summaries = summaries;
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
  const body = { name: form.name.value, theme: form.theme.value || null, assignment: form.assignment.value || null };
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
  // Notes attached with the paperclip go with this message, then are cleared.
  const attach = [...(state.attachments.get(channelId) ?? [])];
  state.attachments.delete(channelId);
  const sentAt = new Date();
  const placeholder = {
    id: "pending",
    channelId,
    kind: "post",
    mode: channel.kind === "rp" ? channel.mode : null,
    author: "user",
    content,
    characters: postingAs ? [postingAs] : [],
    attachments: attach,
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
        const data = await api("POST", channelPath("messages", channelId), { content, postingAs, attach });
        if (!stillMine()) return; // abandoned; the channel was already reloaded
        if (state.channelId !== channelId) return; // you've moved on; it'll load when you return
        // Posting as one of your characters adds them to the cast.
        if (data.channel) updateChannelInState(data.channel);
        state.messages = state.messages.filter((m) => m !== placeholder);
        state.messages.push(...data.userMessages);
        if (data.partnerMessages) {
          acceptTurn(data);
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
        state.attachments.set(channelId, new Set(attach));
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
  await runTurn("turn", acceptTurn, partnerTurn);
}

/**
 * Replace your partner's last reply (every bubble of it, in casual mode) with
 * a fresh one.
 *
 * @param profileId  Write with this profile. Without one, the channel's
 *                   profile or roulette picks again.
 */
async function regenerate(profileId) {
  await runTurn(
    "regenerate",
    (data) => {
      const replaced = new Set(data.replacedIds);
      state.messages = state.messages.filter((m) => !replaced.has(m.id));
      acceptTurn(data);
    },
    () => regenerate(profileId),
    profileId ? { profileId } : {},
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

/**
 * Take in a partner turn's result: its messages, the tools it called, and
 * any change those made to the channels. If it acted, the notebook and
 * inbox may have changed too, so they're reloaded.
 */
function acceptTurn(data) {
  state.messages.push(...data.partnerMessages);
  state.toolCalls.push(...(data.toolCalls ?? []));
  if (data.channels) state.channels = data.channels;
  const skippedNotice = `${state.settings.partnerName} chose not to reply this time.`;
  if (data.skipped && data.partnerMessages.length === 0) {
    showNotice(skippedNotice);
  } else if ($("notice-text").textContent === skippedNotice) {
    $("notice").hidden = true;
  }
  if (data.toolCalls?.length) {
    refreshNotebook().catch(() => {});
    // Your partner may have commented on messages.
    if (data.toolCalls.some((c) => c.name.includes("comment"))) refreshThreads().catch(() => {});
  }
}

/** Reload the open channel's comment threads. */
async function refreshThreads() {
  const channelId = state.channelId;
  const { threads } = await api("GET", channelPath("messages", channelId));
  if (state.channelId !== channelId) return;
  state.threads = threads;
  renderMessages();
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
 * @param body       Sent with the request (e.g. the profile to regenerate with).
 */
async function runTurn(action, onSuccess, retry, body = {}) {
  const channelId = state.channelId;
  if (!channelId || state.busy.has(channelId)) return;
  hideError();
  await withBusyChannel(channelId, async (stillMine) => {
    try {
      const data = await api("POST", channelPath(action, channelId), body);
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
  renderInboxBadge();
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

  // The indicator goes back in after the links, and moves to the open one.
  els.channelList.append(els.channelIndicator);
  moveChannelIndicator();

  const partnerName = state.settings?.partnerName ?? "Partner";
  els.partnerName.textContent = partnerName;
  els.partnerAvatar.textContent = initial(partnerName);
}

/**
 * Move the channel indicator (a pill a theme can show behind the open
 * channel's link) to the open channel. When it moves, it first stretches
 * to cover both links, then snaps into place with a little overshoot, like
 * a drop of liquid flowing from one to the other. Only transforms change,
 * so it stays smooth, and a liquid glass lens on it doesn't need remaking.
 */
function moveChannelIndicator() {
  const indicator = els.channelIndicator;
  const link = els.channelList.querySelector('.channel-link[aria-current="page"]');
  if (!link || getComputedStyle(indicator).display === "none") {
    delete indicator.dataset.top;
    return;
  }
  // Relative to the channel list, which is positioned.
  const top = link.offsetTop;
  const place = (y, stretch) => (indicator.style.transform = `translateY(${y}px) scaleY(${stretch})`);
  indicator.style.left = `${link.offsetLeft}px`;
  indicator.style.width = `${link.offsetWidth}px`;
  indicator.style.height = `${link.offsetHeight}px`;

  const from = Number(indicator.dataset.top);
  indicator.dataset.top = String(top);
  clearTimeout(moveChannelIndicator.timer);
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!Number.isFinite(from) || from === top || reduced) {
    indicator.classList.remove("stretching", "settling");
    place(top, 1);
    return;
  }
  // Stretch over both links...
  const span = Math.abs(top - from) + link.offsetHeight;
  indicator.classList.remove("settling");
  indicator.classList.add("stretching");
  place(Math.min(from, top), span / link.offsetHeight);
  // ...then gather at the new one.
  moveChannelIndicator.timer = setTimeout(() => {
    indicator.classList.replace("stretching", "settling");
    place(top, 1);
  }, 170);
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

  // Tool calls grouped by turn. Turns that wrote messages show their actions
  // under them; turns that only acted are shown on their own, in time order.
  const turns = toolCallsByTurn();
  const turnsWithMessages = new Set(state.messages.map((m) => m.turnId).filter(Boolean));
  const loose = [...turns].filter(([turnId]) => !turnsWithMessages.has(turnId));

  if (state.messages.length === 0 && loose.length === 0) {
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
  const canRegenerate = last?.kind === "post" && last.author === "partner";

  let previous = null;
  state.messages.forEach((message, index) => {
    // Actions from turns that wrote nothing, before this message.
    while (loose.length && loose[0][1][0].createdAt <= message.createdAt) {
      const [turnId, calls] = loose.shift();
      els.messages.append(renderActivity(turnId, calls));
      previous = null;
    }
    const element =
      message.kind === "scene_break"
        ? renderSceneBreak(message)
        : renderMessage(message, {
            continued: continuesGroup(previous, message),
            regenerate: canRegenerate && message === last,
          });
    els.messages.append(element);
    previous = message;
    // After a turn's last message, the actions it took.
    const next = state.messages[index + 1];
    if (message.turnId && turns.has(message.turnId) && next?.turnId !== message.turnId) {
      els.messages.append(renderActivity(message.turnId, turns.get(message.turnId)));
    }
  });
  for (const [turnId, calls] of loose) els.messages.append(renderActivity(turnId, calls));
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
 * rename or remove it, and to show the summary of the scene it ended.
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
  const summaryButton = actionButton("Summary", () => toggleSceneSummary(sceneBreak.id));
  summaryButton.title = "What happened in the scene that ended here";
  summaryButton.setAttribute("aria-expanded", String(state.openSummaries.has(sceneBreak.id)));
  actions.append(
    summaryButton,
    actionButton("Rename", () => renameSceneBreak(sceneBreak)),
    actionButton("Remove", () => deleteMessage(sceneBreak.id), state.busy.has(state.channelId)),
  );
  root.append(actions);
  if (state.openSummaries.has(sceneBreak.id)) root.append(renderSceneSummary(sceneBreak));
  return root;
}

// ------------------------------------------------------------- summaries

/*
 * Summaries (stage 7) are written by the server in the background, a few
 * seconds after a channel changes (see src/summarizer.ts). The app shows
 * them where they belong: each scene's under the scene break that ended
 * it, and the story so far, earlier in the scene and the digest in channel
 * settings → Memory. You can edit them, and ask for them to be rewritten.
 */

/** Show or hide a scene's summary under its scene break (fetching the latest). */
async function toggleSceneSummary(breakId) {
  if (state.openSummaries.has(breakId)) {
    state.openSummaries.delete(breakId);
    renderMessages();
    return;
  }
  state.openSummaries.add(breakId);
  renderMessages();
  await refreshSummaries();
}

/** Fetch the open channel's summaries, and redraw what shows them. */
async function refreshSummaries() {
  const channelId = state.channelId;
  try {
    const { summaries } = await api("GET", channelPath("summaries", channelId));
    if (state.channelId !== channelId) return;
    state.summaries = summaries;
    renderMessages();
    if (els.channelDialog.open) renderMemory();
  } catch (error) {
    showError(`Couldn't load the summaries: ${error.message}`);
  }
}

/** The panel under a scene break: its scene's summary, to read, edit or rewrite. */
function renderSceneSummary(sceneBreak) {
  const panel = document.createElement("div");
  panel.className = "scene-summary";
  const summary = state.summaries?.scenes?.[sceneBreak.id];

  if (state.editingSummary === sceneBreak.id) {
    const box = document.createElement("textarea");
    box.className = "scene-summary-edit";
    box.rows = 6;
    box.value = summary?.content ?? "";
    box.setAttribute("aria-label", "Scene summary");
    const buttons = document.createElement("div");
    buttons.className = "scene-summary-actions";
    buttons.append(
      actionButton("Cancel", () => {
        state.editingSummary = null;
        renderMessages();
      }),
      actionButton("Save", () => saveSceneSummary(sceneBreak.id, box.value)),
    );
    panel.append(box, buttons);
    queueMicrotask(() => box.focus());
    return panel;
  }

  const text = document.createElement("p");
  text.className = "scene-summary-text";
  if (summary) {
    text.textContent = summary.content;
  } else {
    text.classList.add("empty");
    text.textContent = !state.settings.summaries
      ? "Summaries are off (Settings → Memory)."
      : state.summaries?.running
        ? "Being written…"
        : "Not summarized yet. It's written a few seconds after a scene ends.";
  }
  const note = document.createElement("span");
  note.className = "scene-summary-note";
  note.textContent = summary?.edited ? "Your words" : summary?.stale ? "Out of date: being rewritten" : "";

  const buttons = document.createElement("div");
  buttons.className = "scene-summary-actions";
  buttons.append(
    note,
    actionButton("Edit", () => {
      state.editingSummary = sceneBreak.id;
      renderMessages();
    }),
    actionButton("Rewrite", () => regenerateSceneSummary(sceneBreak.id), !state.settings.summaries),
  );
  panel.append(text, buttons);
  return panel;
}

async function saveSceneSummary(breakId, content) {
  try {
    const { summaries } = await api("PUT", channelPath("summaries"), { kind: "scene", sceneId: breakId, content });
    state.summaries = summaries;
    state.editingSummary = null;
    renderMessages();
  } catch (error) {
    showError(`Couldn't save the summary: ${error.message}`);
  }
}

/** Have a scene's summary written again (waits for it). */
async function regenerateSceneSummary(breakId) {
  if (state.summaries) state.summaries.running = true;
  delete state.summaries?.scenes?.[breakId];
  renderMessages();
  try {
    const { summaries } = await api("POST", channelPath(`summaries/scenes/${encodeURIComponent(breakId)}/regenerate`), {});
    state.summaries = summaries;
    if (summaries.error) showError(`Couldn't write the summary: ${summaries.error}`);
  } catch (error) {
    showError(`Couldn't write the summary: ${error.message}`);
  }
  renderMessages();
}

/** Channel settings → Memory: the story so far, earlier in the scene, the digest. */
function renderMemory() {
  const channel = currentChannel();
  const summaries = state.summaries;
  if (!channel) return;
  const rp = channel.kind === "rp";
  for (const element of $("channel-memory").querySelectorAll(".rp-only")) element.hidden = !rp;
  $("memory-note").textContent = state.settings.summaries
    ? `Your partner reads the newest ${state.settings.historyLimit} messages in full, and remembers the rest through these summaries. They're written only from the messages, so nothing hidden from you is ever in them.`
    : "Summaries are off (Settings → Memory), so your partner only reads the newest messages.";
  const story = $("memory-story");
  // Don't overwrite what you're typing.
  if (document.activeElement !== story) story.value = summaries?.story?.content ?? "";
  $("memory-earlier-label").textContent = rp ? "Earlier in this scene" : "Earlier in this conversation";
  $("memory-earlier").textContent =
    summaries?.current?.content ||
    (rp ? "Nothing yet: this scene is still short enough to be read in full." : "Nothing yet: this conversation is still short enough to be read in full.");
  $("memory-digest").textContent = summaries?.digest?.content || "Not written yet.";
  $("memory-status").textContent = summaries?.running
    ? "Writing summaries…"
    : summaries?.error
      ? `The last attempt failed: ${summaries.error}`
      : "";
  for (const id of ["memory-update", "memory-rebuild"]) $(id).disabled = !state.settings.summaries || summaries?.running;
}

async function saveStory() {
  try {
    const { summaries } = await api("PUT", channelPath("summaries"), { kind: "story", content: $("memory-story").value });
    state.summaries = summaries;
    renderMemory();
    $("memory-status").textContent = "Saved.";
  } catch (error) {
    showFormError(els.channelForm, error.message);
  }
}

/** "Update now" and "Rebuild all": write summaries, and wait for them. */
async function updateSummaries(rebuild) {
  if (rebuild && !confirm("Rewrite every summary in this channel from its messages? Your own edits to them will be replaced.")) {
    return;
  }
  if (state.summaries) state.summaries.running = true;
  renderMemory();
  try {
    const { summaries } = await api("POST", channelPath(rebuild ? "summaries/rebuild" : "summaries/update"), {});
    state.summaries = summaries;
  } catch (error) {
    showFormError(els.channelForm, error.message);
  }
  renderMemory();
  renderMessages();
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
  root.dataset.messageId = message.id;
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
    // The profile's name if it has one, otherwise just the part of the model
    // id after the last "/" (e.g. "DeepSeek-V3.1-Terminus"), to save space on
    // a phone. The full model id appears when you hover or long-press.
    model.textContent = message.profile ?? message.model.split("/").at(-1);
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
  const threads = threadsOn(message.id);
  highlightThreads(content, threads);
  root.append(content);
  if (message.attachments?.length) root.append(renderAttachments(message));

  // A post that's still being sent has no actions yet.
  if (pending) return root;

  // Comments on this message: a chip that opens them (open ones counted).
  if (threads.length) {
    const open = threads.filter((t) => !t.resolved).length;
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "message-comments";
    chip.textContent = open ? `💬 ${open}` : "💬 ✓";
    chip.title = open ? `${open} open comment thread${open === 1 ? "" : "s"}` : "Resolved comments";
    chip.addEventListener("click", () => openThread((threads.find((t) => !t.resolved) ?? threads[0]).id));
    root.append(chip);
  }

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
    actionButton("Comment", () => newComment(message.id)),
  );
  if (showRegenerate) {
    actions.append(actionButton("Regenerate", () => regenerate(), busy));
    if (state.profiles.length > 1) actions.append(actionButton("Regenerate with…", openRegenerateWith, busy));
  }
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
  renderAttachRow();
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
    link.addEventListener(
      "load",
      () => {
        scrollToBottom();
        themeLoaded();
      },
      { once: true },
    );
    link.setAttribute("href", href);
    return;
  }
  const next = link.cloneNode();
  next.setAttribute("href", href);
  link.removeAttribute("id"); // the new link takes over the id straight away
  const done = () => {
    link.remove();
    scrollToBottom();
    themeLoaded();
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
  applyThemeOptions();
  updateGlass();
}

/**
 * Once a theme's stylesheet has loaded: things that depend on how the theme
 * looks. (The channel indicator is hidden until a theme shows it, and its
 * size comes from the theme's channel links.)
 */
function themeLoaded() {
  updateGlass();
  moveChannelIndicator();
}

/**
 * Real liquid glass (public/glass.js): on when a theme asks for it (with
 * `--lensing: on` in its :root), and glass effects aren't Lite. The theme
 * then marks which elements are glass with `--lens: 1`. Checked again
 * whenever a theme's stylesheet finishes loading.
 */
function updateGlass() {
  const wants = (element) => getComputedStyle(element).getPropertyValue("--lensing").trim() === "on";
  Glass.setEnabled(!liteEffects() && (wants(document.documentElement) || wants(els.channelView)));
  Glass.refresh();
}

/*
 * Theme options: sliders a theme declares in its theme.json, each setting a
 * CSS variable (like --bubble-transparency). The values are set straight on
 * the page: the app theme's on <html>, and a channel theme's on the channel
 * view, where they win over the theme's own defaults.
 */

/** The variables set by the last call, so they can be cleared. */
const appliedOptions = { root: [], channel: [] };

/** A theme's option values: yours where you've moved a slider, the theme's default elsewhere. */
function themeOptionValues(themeId) {
  const saved = state.settings?.themeOptions?.[themeId] ?? {};
  return (themeInfo(themeId)?.options ?? []).map((option) => {
    const raw = saved[option.id];
    const value = typeof raw === "number" ? Math.min(option.max, Math.max(option.min, raw)) : option.default;
    return { option, value };
  });
}

function applyThemeOptions() {
  const { app, channel } = activeThemes();
  const set = (element, key, themeId) => {
    for (const variable of appliedOptions[key]) element.style.removeProperty(variable);
    appliedOptions[key] = [];
    if (!themeId) return;
    for (const { option, value } of themeOptionValues(themeId)) {
      element.style.setProperty(option.variable, `${value}${option.unit}`);
      appliedOptions[key].push(option.variable);
    }
  };
  set(document.documentElement, "root", app);
  set(els.channelView, "channel", channel);
  // Sliders can change the glass's settings: remake its lenses.
  Glass.refresh();
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
  renderThemeOptions();
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
    renderThemeOptions();
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

/**
 * The sliders in Appearance: the app theme's, and the open channel's theme's
 * if it has its own. Moving one applies at once; letting go saves it.
 */
function renderThemeOptions() {
  const { app, channel } = activeThemes();
  const groups = [];
  const add = (themeId, title) => {
    const values = themeOptionValues(themeId);
    if (values.length === 0 || groups.some((g) => g.themeId === themeId)) return;
    groups.push({ themeId, title, values });
  };
  add(app, themeInfo(app)?.name ?? "App theme");
  if (channel) add(channel, `#${currentChannel()?.name}: ${themeInfo(channel)?.name ?? channel}`);

  const box = $("theme-options");
  box.hidden = groups.length === 0;
  box.replaceChildren(
    ...groups.map(({ themeId, title, values }) => {
      const section = document.createElement("fieldset");
      section.className = "theme-option-group";
      const legend = document.createElement("legend");
      legend.textContent = title;
      section.append(legend);
      for (const { option, value } of values) {
        const row = document.createElement("label");
        row.className = "theme-option";
        const name = document.createElement("span");
        name.className = "theme-option-label";
        name.textContent = option.label;
        const slider = document.createElement("input");
        slider.type = "range";
        slider.min = option.min;
        slider.max = option.max;
        slider.step = option.step;
        slider.value = value;
        const shown = document.createElement("output");
        shown.className = "theme-option-value";
        const show = (v) => (shown.textContent = formatOption(option, v));
        show(value);
        slider.addEventListener("input", () => {
          setThemeOption(themeId, option.id, Number(slider.value));
          show(Number(slider.value));
        });
        slider.addEventListener("change", saveThemeOptions);
        row.append(name, slider, shown);
        section.append(row);
      }
      const reset = document.createElement("button");
      reset.type = "button";
      reset.className = "link-button";
      reset.textContent = "Reset to the theme's defaults";
      reset.addEventListener("click", () => {
        delete state.settings.themeOptions[themeId];
        applyThemeOptions();
        renderThemeOptions();
        saveThemeOptions();
      });
      section.append(reset);
      return section;
    }),
  );
}

/** "55%" for fractions of 1, "14px", or the plain number. */
function formatOption(option, value) {
  if (!option.unit && option.min >= 0 && option.max <= 1) return `${Math.round(value * 100)}%`;
  return `${Math.round(value * 100) / 100}${option.unit}`;
}

/** Change one slider's value locally, and show it straight away. */
function setThemeOption(themeId, optionId, value) {
  const all = (state.settings.themeOptions ??= {});
  all[themeId] = { ...all[themeId], [optionId]: value };
  applyThemeOptions();
}

async function saveThemeOptions() {
  try {
    const { settings } = await api("PUT", "/api/settings", { themeOptions: state.settings.themeOptions ?? {} });
    state.settings = settings;
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
    form.options.value = theme.options.length ? JSON.stringify(theme.options, null, 2) : "";
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
    let options;
    try {
      options = form.options.value.trim() ? JSON.parse(form.options.value) : [];
    } catch {
      throw new Error("The sliders must be valid JSON: a list like [{\"id\": ...}].");
    }
    await api("PATCH", `/api/themes/${encodeURIComponent(state.editingTheme.id)}`, {
      name: form.name.value,
      description: form.description.value,
      css: form.css.value,
      liteCss: form.liteCss.value,
      options,
    });
    state.themeVersion++;
    await loadThemes();
    renderThemeList();
    renderThemeOptions();
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
  fillAssignmentSelect(form.rpAssignment, s.rpAssignment);
  fillAssignmentSelect(form.oocAssignment, s.oocAssignment);
  form.historyLimit.value = s.historyLimit;
  form.summaries.checked = s.summaries;
  form.summaryEvery.value = s.summaryEvery;
  fillAssignmentSelect(form.summaryAssignment, s.summaryAssignment, "Same as roleplay");
  updateSummariesOnly();
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
      rpAssignment: form.rpAssignment.value,
      oocAssignment: form.oocAssignment.value,
      // Number boxes give text; the server wants numbers.
      historyLimit: Number(form.historyLimit.value),
      summaries: form.summaries.checked,
      summaryEvery: Number(form.summaryEvery.value),
      summaryAssignment: form.summaryAssignment.value,
    });
    state.settings = data.settings;
    els.settingsDialog.close();
    renderAll();
  } catch (error) {
    showFormError(els.settingsForm, error.message);
  }
}

/** Show the summary settings only while summaries are on. */
function updateSummariesOnly() {
  const on = els.settingsForm.elements.summaries.checked;
  for (const element of els.settingsForm.querySelectorAll(".summaries-only")) element.hidden = !on;
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
  const serverWide = channel.kind === "ooc" ? state.settings.oocAssignment : state.settings.rpAssignment;
  fillAssignmentSelect(form.assignment, channel.assignment, `Same as the server (${assignmentName(serverWide)})`);
  // Show the mode you'll get: a waiting change if there is one.
  form.mode.value = channel.pendingMode ?? channel.mode;
  updateModeNote();
  renderCastEditor();
  els.channelForm.querySelector(".rp-only").hidden = channel.kind !== "rp";
  renderMemory();
  // The summaries may have changed since the channel was opened.
  if ($("channel-memory").open) refreshSummaries();
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
  const [notebook, { channels, proposals }] = await Promise.all([api("GET", "/api/notebook"), api("GET", "/api/state")]);
  state.notebook = notebook;
  state.channels = channels;
  state.proposals = proposals;
  renderAll();
  if ($("notebook-dialog").open) renderNotebook();
  if (els.channelDialog.open) renderCastEditor();
  if ($("inbox-dialog").open) renderInbox();
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
 * Suggested changes still waiting are in the inbox; the notebook just says
 * how many, with a button to open it.
 */
function renderSuggestions() {
  const box = $("suggestion-list");
  const count = state.notebook.suggestions.length;
  box.hidden = count === 0;
  if (box.hidden) return;
  const text = document.createElement("span");
  text.className = "suggestion-text";
  text.textContent = `${count} suggested change${count === 1 ? " is" : "s are"} waiting.`;
  const open = document.createElement("button");
  open.type = "button";
  open.className = "link-button inline-link";
  open.textContent = "Open the inbox";
  open.addEventListener("click", openInbox);
  box.replaceChildren(text, open);
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
  // Your own entries are deleted; deleting anything else is a suggestion.
  del.hidden = isNew;
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

// ------------------------------------------------- profiles and roulettes

/*
 * Stage 5: connection profiles (a model and its settings) and roulettes (a
 * weighted set of profiles). The server keeps them; the app lists, edits
 * and assigns them. An assignment is written "profile:<id>" or
 * "roulette:<id>"; "" means the first profile.
 */

/** Reload profiles and roulettes, and redraw whatever shows them. */
async function refreshProfiles() {
  const { profiles, roulettes } = await api("GET", "/api/profiles");
  state.profiles = profiles;
  state.roulettes = roulettes;
  if ($("models-dialog").open) renderModels();
  // Settings may be open underneath: keep its choices current.
  if (els.settingsDialog.open) {
    const form = els.settingsForm.elements;
    fillAssignmentSelect(form.rpAssignment, form.rpAssignment.value);
    fillAssignmentSelect(form.oocAssignment, form.oocAssignment.value);
    fillAssignmentSelect(form.summaryAssignment, form.summaryAssignment.value, "Same as roleplay");
  }
}

/**
 * Fill a select with every profile and roulette.
 *
 * @param emptyLabel  If given, a first option with value "" and this label
 *                    (e.g. "Same as the server").
 */
function fillAssignmentSelect(select, value, emptyLabel) {
  const profiles = document.createElement("optgroup");
  profiles.label = "Profiles";
  profiles.append(...state.profiles.map((p) => new Option(p.name, `profile:${p.id}`)));
  const roulettes = document.createElement("optgroup");
  roulettes.label = "Roulettes";
  roulettes.append(...state.roulettes.map((r) => new Option(`🎲 ${r.name}`, `roulette:${r.id}`)));
  select.replaceChildren(
    ...(emptyLabel ? [new Option(emptyLabel, "")] : []),
    profiles,
    ...(state.roulettes.length ? [roulettes] : []),
  );
  // "" (no assignment) means the first profile, where there's no "" option.
  select.value = value || (emptyLabel ? "" : `profile:${state.profiles[0]?.id}`);
  if (select.selectedIndex < 0) select.selectedIndex = 0;
}

/** A readable name for an assignment, e.g. "DeepSeek" or "🎲 Variety". */
function assignmentName(value) {
  const [kind, id] = (value || "").split(":");
  if (kind === "roulette") return `🎲 ${state.roulettes.find((r) => r.id === id)?.name ?? "?"}`;
  return (state.profiles.find((p) => p.id === id) ?? state.profiles[0])?.name ?? "?";
}

function openModels() {
  hideFormError($("models-dialog"));
  renderModels();
  $("models-dialog").showModal();
}

/** Draw the lists of profiles and roulettes. */
function renderModels() {
  const inUse = (value) => {
    const jobs = [];
    if (state.settings.rpAssignment === value) jobs.push("roleplay");
    if (state.settings.oocAssignment === value) jobs.push("OOC");
    const channels = state.channels.filter((c) => c.assignment === value).map((c) => `#${c.name}`);
    return [...jobs, ...channels];
  };

  $("profile-list").replaceChildren(
    ...state.profiles.map((profile, index) => {
      const uses = inUse(`profile:${profile.id}`);
      if (index === 0 && !state.settings.rpAssignment) uses.unshift("roleplay");
      if (index === 0 && !state.settings.oocAssignment) uses.unshift("OOC");
      return profileRow(
        profile.name,
        [profile.model.split("/").at(-1), profile.supportsTools ? "tools" : "no tools", ...uses.map((u) => `used by ${u}`)],
        () => openProfile(profile),
      );
    }),
  );

  const byId = new Map(state.profiles.map((p) => [p.id, p]));
  $("roulette-list").replaceChildren(
    ...state.roulettes.map((roulette) => {
      const total = roulette.entries.reduce((sum, e) => sum + e.weight, 0);
      const shares = roulette.entries.map(
        (e) => `${Math.round((e.weight / total) * 100)}% ${byId.get(e.profileId)?.name ?? "?"}`,
      );
      return profileRow(
        `🎲 ${roulette.name}`,
        [...(shares.length ? shares : ["empty"]), ...inUse(`roulette:${roulette.id}`).map((u) => `used by ${u}`)],
        () => openRoulette(roulette),
      );
    }),
  );
}

/** One row in the profile or roulette list: a name, badges, and the whole row opens it. */
function profileRow(name, badges, onOpen) {
  const item = document.createElement("li");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "profile-row";
  const title = document.createElement("span");
  title.className = "profile-row-name";
  title.textContent = name;
  const tags = document.createElement("span");
  tags.className = "notebook-entry-badges";
  tags.append(...badges.map(badge));
  button.append(title, tags);
  button.addEventListener("click", onOpen);
  item.append(button);
  return item;
}

// --------------------------------------------------------- profile editor

/** Open a profile in the editor, or start a new one (`null`). */
function openProfile(profile) {
  state.editingProfile = profile;
  const form = $("profile-form");
  const f = form.elements;
  hideFormError(form);
  $("profile-title").textContent = profile ? profile.name : "New profile";
  const base = profile ?? state.profiles[0] ?? {};
  f.name.value = profile?.name ?? "";
  f.model.value = profile?.model ?? base.model ?? "";
  f.temperature.value = profile?.temperature ?? 0.9;
  f.maxTokens.value = profile?.maxTokens ?? 1024;
  f.topP.value = profile?.topP ?? "";
  f.reasoningEffort.value = profile?.reasoningEffort ?? "";
  f.supportsTools.checked = profile?.supportsTools ?? true;
  f.quirkPrompt.value = profile?.quirkPrompt ?? "";
  f.extraParams.value = profile?.extraParams ?? "";
  form.querySelector(".advanced").open = Boolean(profile?.extraParams);
  $("profile-delete").hidden = !profile;
  renderToolTest(profile);
  $("profile-dialog").showModal();
}

async function saveProfile(event) {
  event.preventDefault();
  const form = $("profile-form");
  const f = form.elements;
  const body = {
    name: f.name.value,
    model: f.model.value,
    // Number boxes give text; the server wants numbers.
    temperature: Number(f.temperature.value),
    maxTokens: Number(f.maxTokens.value),
    topP: f.topP.value === "" ? null : Number(f.topP.value),
    reasoningEffort: f.reasoningEffort.value || null,
    supportsTools: f.supportsTools.checked,
    quirkPrompt: f.quirkPrompt.value,
    extraParams: f.extraParams.value,
  };
  try {
    const profile = state.editingProfile;
    if (profile) await api("PATCH", `/api/profiles/${encodeURIComponent(profile.id)}`, body);
    else await api("POST", "/api/profiles", body);
    $("profile-dialog").close();
    await refreshProfiles();
  } catch (error) {
    showFormError(form, error.message);
  }
}

async function deleteProfile() {
  const profile = state.editingProfile;
  if (!confirm(`Delete the profile "${profile.name}"? Anything using it goes back to the default.`)) return;
  try {
    const { settings, channels } = await api("DELETE", `/api/profiles/${encodeURIComponent(profile.id)}`, {});
    state.settings = settings;
    state.channels = channels;
    $("profile-dialog").close();
    await refreshProfiles();
  } catch (error) {
    showFormError($("profile-form"), error.message);
  }
}

/** Ask the server which models nanoGPT offers and offer them as suggestions. */
async function loadModels() {
  els.loadModels.disabled = true;
  els.loadModels.textContent = "Loading…";
  try {
    const { models } = await api("GET", "/api/models");
    els.modelList.replaceChildren(...models.map((id) => new Option(id, id)));
    els.loadModels.textContent = `${models.length} models`;
    // Focus the model box so the suggestions are one tap away.
    $("profile-form").elements.model.focus();
  } catch (error) {
    showFormError($("profile-form"), error.message);
    els.loadModels.textContent = "Load list";
  } finally {
    els.loadModels.disabled = false;
  }
}

// -------------------------------------------------------- roulette editor

function openRoulette(roulette) {
  state.editingRoulette = roulette;
  const form = $("roulette-form");
  hideFormError(form);
  $("roulette-title").textContent = roulette ? `🎲 ${roulette.name}` : "New roulette";
  form.elements.name.value = roulette?.name ?? "";
  const entries = roulette?.entries ?? state.profiles.slice(0, 2).map((p) => ({ profileId: p.id, weight: 1 }));
  $("roulette-entries").replaceChildren(...entries.map(rouletteEntryRow));
  updateRouletteShares();
  $("roulette-delete").hidden = !roulette;
  $("roulette-dialog").showModal();
}

/** One row of the roulette editor: a profile, its weight, its share, and a remove button. */
function rouletteEntryRow(entry) {
  const row = document.createElement("div");
  row.className = "roulette-entry";
  const select = document.createElement("select");
  select.className = "roulette-profile";
  select.setAttribute("aria-label", "Profile");
  select.append(...state.profiles.map((p) => new Option(p.name, p.id)));
  select.value = entry.profileId;
  const weight = document.createElement("input");
  weight.className = "roulette-weight";
  weight.type = "number";
  weight.min = "0.01";
  weight.step = "any";
  weight.value = entry.weight;
  weight.setAttribute("aria-label", "Weight");
  const share = document.createElement("span");
  share.className = "roulette-share";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "link-button";
  remove.textContent = "✕";
  remove.setAttribute("aria-label", "Remove");
  remove.addEventListener("click", () => {
    row.remove();
    updateRouletteShares();
  });
  row.append(select, weight, share, remove);
  return row;
}

/** Show each row's chance, e.g. "40%". */
function updateRouletteShares() {
  const rows = [...$("roulette-entries").querySelectorAll(".roulette-entry")];
  const weights = rows.map((row) => Math.max(0, Number(row.querySelector(".roulette-weight").value) || 0));
  const total = weights.reduce((a, b) => a + b, 0);
  rows.forEach((row, i) => {
    row.querySelector(".roulette-share").textContent = total ? `${Math.round((weights[i] / total) * 100)}%` : "";
  });
}

async function saveRoulette(event) {
  event.preventDefault();
  const form = $("roulette-form");
  const entries = [...$("roulette-entries").querySelectorAll(".roulette-entry")].map((row) => ({
    profileId: row.querySelector(".roulette-profile").value,
    weight: Number(row.querySelector(".roulette-weight").value),
  }));
  try {
    const roulette = state.editingRoulette;
    const body = { name: form.elements.name.value, entries };
    if (roulette) await api("PATCH", `/api/roulettes/${encodeURIComponent(roulette.id)}`, body);
    else await api("POST", "/api/roulettes", body);
    $("roulette-dialog").close();
    await refreshProfiles();
  } catch (error) {
    showFormError(form, error.message);
  }
}

async function deleteRoulette() {
  const roulette = state.editingRoulette;
  if (!confirm(`Delete the roulette "${roulette.name}"? Anything using it goes back to the default.`)) return;
  try {
    const { settings, channels } = await api("DELETE", `/api/roulettes/${encodeURIComponent(roulette.id)}`, {});
    state.settings = settings;
    state.channels = channels;
    $("roulette-dialog").close();
    await refreshProfiles();
  } catch (error) {
    showFormError($("roulette-form"), error.message);
  }
}

// ---------------------------------------------------- regenerate with...

/** "Regenerate with...": choose a profile, or let the channel's pick again. */
function openRegenerateWith() {
  const select = $("regenerate-profile");
  select.replaceChildren(
    new Option(`Pick again (${assignmentName(channelAssignment(currentChannel()))})`, ""),
    ...state.profiles.map((p) => new Option(p.name, p.id)),
  );
  $("regenerate-dialog").showModal();
}

/** The assignment that writes in a channel: its own, or the server-wide one for its kind. */
function channelAssignment(channel) {
  if (channel.assignment) return channel.assignment;
  return channel.kind === "ooc" ? state.settings.oocAssignment : state.settings.rpAssignment;
}

// ------------------------------------------------ your partner's actions

/*
 * Stage 6: your partner acts through tools. Each turn's tool calls are
 * shown under the messages it wrote, as one line ("Arlo read Ilse Marrow,
 * pinned Tamsin to #story") that opens into the details: every call, its
 * arguments exactly as the model wrote them, and what it was told back.
 * A turn that only acted, and wrote nothing, shows the line on its own.
 */

/** The open channel's tool calls, grouped by turn: Map of turnId → calls. */
function toolCallsByTurn() {
  const turns = new Map();
  for (const call of state.toolCalls) {
    if (!turns.has(call.turnId)) turns.set(call.turnId, []);
    turns.get(call.turnId).push(call);
  }
  return turns;
}

/** One turn's actions: a summary line that opens into the details. */
function renderActivity(turnId, calls) {
  const root = document.createElement("div");
  root.className = "activity";
  const errors = calls.filter((c) => c.status === "error").length;
  if (errors) root.classList.add("has-errors");

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "activity-summary";
  const open = state.openActivity.has(turnId);
  toggle.setAttribute("aria-expanded", String(open));
  // Only the actions that did something, once each ("read X" twice is noise).
  const done = [...new Set(calls.filter((c) => c.status === "ok").map((c) => c.summary))];
  const text = done.length ? `${state.settings.partnerName} ${done.join(", ")}` : `${state.settings.partnerName} tried to act`;
  toggle.textContent = `⚙ ${text}${errors ? ` · ${errors} error${errors === 1 ? "" : "s"}` : ""}`;
  toggle.addEventListener("click", () => {
    if (state.openActivity.has(turnId)) state.openActivity.delete(turnId);
    else state.openActivity.add(turnId);
    renderMessages();
  });
  root.append(toggle);

  if (open) {
    const list = document.createElement("ol");
    list.className = "activity-details";
    list.append(...calls.map(renderToolCall));
    root.append(list);
  }
  return root;
}

/** One tool call, in full: for the activity details and the tool log. */
function renderToolCall(call) {
  const item = document.createElement("li");
  item.className = "tool-call";
  item.dataset.status = call.status;
  item.dataset.source = call.source;

  const head = document.createElement("div");
  head.className = "tool-call-head";
  const name = document.createElement("code");
  name.className = "tool-call-name";
  name.textContent = call.name;
  head.append(name, badge(call.status === "ok" ? "ok" : "error"));
  if (call.source === "text") head.append(badge("written as text"));
  head.append(badge(`round ${call.round + 1}`));
  if (call.profile) head.append(badge(call.profile));
  const time = document.createElement("time");
  time.className = "message-time";
  time.dateTime = call.createdAt;
  time.textContent = formatTime(call.createdAt);
  head.append(time);

  const summary = document.createElement("p");
  summary.className = "tool-call-summary";
  summary.textContent = call.summary;

  const details = document.createElement("details");
  details.className = "tool-call-raw";
  const label = document.createElement("summary");
  label.textContent = "Arguments and result";
  const args = document.createElement("pre");
  args.textContent = prettyJson(call.arguments);
  const result = document.createElement("pre");
  result.textContent = prettyJson(call.result);
  details.append(label, args, result);

  item.append(head, summary, details);
  return item;
}

/** JSON text, indented if it parses, as-is if it doesn't (broken arguments stay visible). */
function prettyJson(text) {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text || "(empty)";
  }
}

// ---------------------------------------------------------------- tool log

async function openToolLog() {
  $("tool-log-copy").textContent = "Copy as text";
  try {
    const { toolCalls } = await api("GET", channelPath("tool-log"));
    state.toolLog = toolCalls;
    renderToolLog();
    $("tool-log-dialog").showModal();
  } catch (error) {
    showFormError(els.channelForm, error.message);
  }
}

function renderToolLog() {
  const errorsOnly = $("tool-log-errors").checked;
  const calls = [...state.toolLog].reverse().filter((c) => !errorsOnly || c.status === "error");
  const list = $("tool-log-list");
  if (calls.length === 0) {
    const empty = document.createElement("li");
    empty.className = "hint";
    empty.textContent = errorsOnly ? "No errors." : `${state.settings.partnerName} hasn't used any tools here yet.`;
    list.replaceChildren(empty);
    return;
  }
  list.replaceChildren(...calls.map(renderToolCall));
}

/** Copy the tool log as plain text, e.g. to share when something goes wrong. */
async function copyToolLog() {
  const text = state.toolLog
    .map((c) =>
      [
        `${c.createdAt}  ${c.profile ?? ""}  round ${c.round + 1}  ${c.source}  ${c.status}`,
        `${c.name} ${c.arguments}`,
        `-> ${c.result}`,
      ].join("\n"),
    )
    .join("\n\n");
  try {
    await navigator.clipboard.writeText(text);
    $("tool-log-copy").textContent = "Copied";
  } catch {
    showFormError($("tool-log-dialog"), "Couldn't copy: your browser didn't allow it.");
  }
}

// ------------------------------------------------------------- tool test

/** Under "Test tools" in the profile editor: the last result, or a hint. */
function renderToolTest(profile, result) {
  const box = $("profile-test-result");
  $("profile-test").disabled = !profile;
  box.dataset.verdict = result?.verdict ?? "";
  if (!profile) {
    box.textContent = "Save the profile first, then test it.";
  } else if (!result) {
    box.textContent = "Checks whether this model can call tools, with one small request.";
  } else {
    const labels = { native: "✓ Works", text: "~ Works, as text", none: "✗ No tool call", broken: "✗ Broken arguments" };
    box.textContent = `${labels[result.verdict]} (${result.seconds}s). ${result.detail}`;
  }
}

async function testProfileTools() {
  const profile = state.editingProfile;
  const button = $("profile-test");
  button.disabled = true;
  button.textContent = "Testing…";
  try {
    const { test } = await api("POST", `/api/profiles/${encodeURIComponent(profile.id)}/test`, {});
    renderToolTest(profile, test);
  } catch (error) {
    showFormError($("profile-form"), error.message);
  } finally {
    button.disabled = false;
    button.textContent = "Test tools";
  }
}

// ------------------------------------------------------------------ inbox

/*
 * The inbox gathers what's waiting on someone: your partner's proposals
 * (deleting a channel) and suggestions (notebook changes) for you to
 * approve, and your suggestions waiting for your partner, who reviews them
 * with their tools on their next turn.
 */

/** Suggestions waiting for you, and proposals: what the badge counts. */
function inboxCount() {
  return state.proposals.length + state.notebook.suggestions.filter((s) => s.reviewer === "user").length;
}

function renderInboxBadge() {
  const count = inboxCount();
  const badge = $("inbox-count");
  badge.hidden = count === 0;
  badge.textContent = String(count);
  $("inbox-button").title = count ? `Inbox: ${count} waiting for you` : "Inbox";
}

function openInbox() {
  hideFormError($("inbox-dialog"));
  renderInbox();
  $("inbox-dialog").showModal();
  refreshNotebook().catch((error) => showFormError($("inbox-dialog"), error.message));
}

function renderInbox() {
  const partner = state.settings.partnerName;
  const forYou = state.notebook.suggestions.filter((s) => s.reviewer === "user");
  const yours = state.notebook.suggestions.filter((s) => s.author === "user" && s.reviewer !== "user");
  const sections = [];

  if (state.proposals.length) {
    sections.push(
      inboxSection(
        `${partner} asks`,
        state.proposals.map((proposal) => {
          const card = inboxCard(`Delete #${proposal.targetName}?`, proposal.reason ? `“${proposal.reason}”` : "");
          card.append(
            cardButtons([
              ["Delete it", () => resolveProposal(proposal.id, "approve"), "button-danger"],
              ["Keep it", () => resolveProposal(proposal.id, "deny")],
            ]),
          );
          return card;
        }),
      ),
    );
  }
  if (forYou.length) {
    sections.push(
      inboxSection(
        "Suggestions for you",
        forYou.map((s) => {
          const card = suggestionCard(s);
          card.append(
            cardButtons([
              ["Accept", () => reviewSuggestion(s.id, "accept"), "button-primary"],
              ["Reject", () => reviewSuggestion(s.id, "reject")],
            ]),
          );
          return card;
        }),
      ),
    );
  }
  if (yours.length) {
    sections.push(
      inboxSection(
        `Waiting for ${partner}`,
        yours.map((s) => {
          const card = suggestionCard(s);
          const note = document.createElement("p");
          note.className = "hint";
          note.textContent = `${partner} reviews these on their next turn with tools.`;
          card.append(note, cardButtons([["Withdraw", () => reviewSuggestion(s.id, "withdraw")]]));
          return card;
        }),
      ),
    );
  }
  if (sections.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "Nothing waiting.";
    sections.push(empty);
  }
  $("inbox-list").replaceChildren(...sections);
}

function inboxSection(title, cards) {
  const section = document.createElement("section");
  section.className = "inbox-section";
  const heading = document.createElement("h3");
  heading.className = "section-title";
  heading.textContent = title;
  section.append(heading, ...cards);
  return section;
}

function inboxCard(title, text) {
  const card = document.createElement("div");
  card.className = "inbox-card";
  const heading = document.createElement("p");
  heading.className = "inbox-card-title";
  heading.textContent = title;
  card.append(heading);
  if (text) {
    const body = document.createElement("p");
    body.className = "inbox-card-text";
    body.textContent = text;
    card.append(body);
  }
  return card;
}

/** Buttons for a card: [label, onClick, extra class]. */
function cardButtons(buttons) {
  const row = document.createElement("div");
  row.className = "dialog-buttons inbox-card-buttons";
  for (const [label, onClick, extra] of buttons) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `button ${extra ?? ""}`.trim();
    button.textContent = label;
    button.addEventListener("click", onClick);
    row.append(button);
  }
  return row;
}

/**
 * A suggestion as a before/after comparison: each changed part of the entry,
 * old struck through, new below it.
 */
function suggestionCard(suggestion) {
  const entry = findEntry(suggestion.entryId);
  const who = suggestion.author === "user" ? "You" : state.settings.partnerName;
  const name = entry?.name ?? "an entry";
  const change = suggestion.change;
  const card = inboxCard(change.delete ? `${who}: delete ${name}?` : `${who}: change ${name}`, "");
  if (change.delete || !entry) return card;

  const diff = document.createElement("dl");
  diff.className = "suggestion-diff";
  const row = (label, before, after) => {
    const term = document.createElement("dt");
    term.textContent = label;
    const old = document.createElement("dd");
    old.className = "diff-before";
    old.textContent = before || "(empty)";
    const next = document.createElement("dd");
    next.className = "diff-after";
    next.textContent = after || "(removed)";
    diff.append(term, old, next);
  };
  if (change.name !== undefined && change.name !== entry.name) row("Name", entry.name, change.name);
  if (change.fields !== undefined) {
    const before = new Map(entry.fields.map((f) => [f.label, f.value]));
    const after = new Map(change.fields.map((f) => [f.label, f.value]));
    for (const label of new Set([...before.keys(), ...after.keys()])) {
      if ((before.get(label) ?? "") !== (after.get(label) ?? "")) row(label, before.get(label), after.get(label));
    }
  }
  if (change.systemPrompt !== undefined && change.systemPrompt !== entry.systemPrompt) {
    row("Notes", entry.systemPrompt, change.systemPrompt);
  }
  card.append(diff);
  return card;
}

async function reviewSuggestion(id, action) {
  try {
    await api("POST", `/api/notebook/suggestions/${encodeURIComponent(id)}/${action}`, {});
    await refreshNotebook();
  } catch (error) {
    showFormError($("inbox-dialog"), error.message);
  }
}

async function resolveProposal(id, action) {
  if (action === "approve" && !confirm("Delete this channel and every message in it? This can't be undone.")) return;
  try {
    const { proposals, channels } = await api("POST", `/api/proposals/${encodeURIComponent(id)}/${action}`, {});
    state.proposals = proposals;
    state.channels = channels;
    if (!channels.some((c) => c.id === state.channelId)) await openChannel(channels[0]?.id ?? null);
    renderAll();
    renderInbox();
  } catch (error) {
    showFormError($("inbox-dialog"), error.message);
  }
}

// --------------------------------------------------------------- comments

/*
 * Comments are out-of-character notes on a message, or on part of one, in
 * threads. Select some text in a message and a Comment button appears; or
 * use a message's Comment action for the whole message. Commenting on your
 * partner's message gets a reply from them in the thread.
 */

/** The threads on one message. */
function threadsOn(messageId) {
  return state.threads.filter((t) => t.messageId === messageId);
}

/**
 * Highlight each thread's quoted text inside a rendered message. Formatting
 * like *italics* is ignored when matching, since it isn't visible.
 */
function highlightThreads(content, threads) {
  for (const thread of threads) {
    const quote = thread.quote.replace(/[*_]/g, "").trim();
    if (!quote) continue;
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let text = "";
    while (walker.nextNode()) {
      nodes.push({ node: walker.currentNode, start: text.length });
      text += walker.currentNode.nodeValue;
    }
    const start = text.toLowerCase().indexOf(quote.toLowerCase());
    if (start < 0) continue;
    const end = start + quote.length;
    // Wrap the part of each text node that falls inside the quote.
    for (const { node, start: nodeStart } of nodes) {
      const nodeEnd = nodeStart + node.nodeValue.length;
      if (nodeEnd <= start || nodeStart >= end) continue;
      const range = document.createRange();
      range.setStart(node, Math.max(0, start - nodeStart));
      range.setEnd(node, Math.min(node.nodeValue.length, end - nodeStart));
      const mark = document.createElement("mark");
      mark.className = "comment-mark";
      if (thread.resolved) mark.classList.add("resolved");
      mark.dataset.thread = thread.id;
      mark.title = "Open the comments";
      range.surroundContents(mark);
    }
  }
}

/** Open a thread, or several (a picker switches between them). */
function openThread(threadId) {
  const thread = state.threads.find((t) => t.id === threadId);
  if (!thread) return;
  state.thread = thread;
  renderThread();
  $("thread-dialog").showModal();
}

/** Start a new comment on a message, optionally on some quoted text. */
function newComment(messageId, quote = "") {
  state.thread = { id: null, messageId, quote, resolved: false, comments: [] };
  renderThread();
  $("thread-dialog").showModal();
  $("thread-note").focus();
}

function renderThread() {
  const thread = state.thread;
  const form = $("thread-form");
  hideFormError(form);
  $("thread-title").textContent = thread.id ? "Comments" : "New comment";

  // More than one thread on this message: pick which.
  const siblings = thread.id ? threadsOn(thread.messageId) : [];
  const picker = $("thread-picker");
  picker.hidden = siblings.length < 2;
  picker.replaceChildren(
    ...siblings.map((t) => new Option(`${t.resolved ? "✓ " : ""}${t.quote ? `“${t.quote.slice(0, 40)}”` : "Whole message"}`, t.id)),
  );
  if (thread.id) picker.value = thread.id;

  const quote = $("thread-quote");
  quote.hidden = !thread.quote;
  quote.textContent = thread.quote;

  const partner = state.settings.partnerName;
  $("thread-comments").replaceChildren(
    ...thread.comments.map((comment) => {
      const item = document.createElement("li");
      item.className = "thread-comment";
      item.dataset.author = comment.author;
      const who = document.createElement("span");
      who.className = "thread-comment-author";
      who.textContent = comment.author === "user" ? "You" : partner;
      const time = document.createElement("time");
      time.className = "message-time";
      time.textContent = formatTime(comment.createdAt);
      const note = document.createElement("p");
      note.className = "thread-comment-note";
      note.textContent = comment.note;
      item.append(who, time, note);
      if (comment.author === "user") {
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "link-button";
        remove.textContent = "Delete";
        remove.addEventListener("click", () => deleteComment(comment));
        item.append(remove);
      }
      return item;
    }),
  );

  const busy = state.busy.has(state.channelId);
  $("thread-status").hidden = !thread.replying;
  $("thread-status-text").textContent = `${partner} is replying…`;
  $("thread-send").textContent = thread.id ? "Reply" : "Comment";
  $("thread-send").disabled = Boolean(thread.replying);
  $("thread-resolve").hidden = !thread.id;
  $("thread-resolve").textContent = thread.resolved ? "Reopen" : "Resolve";
  $("thread-note").disabled = Boolean(thread.replying) || busy;
  $("thread-note").placeholder = busy
    ? `Wait for ${partner} to finish writing.`
    : "Out of character: the characters never see this.";
}

async function sendComment(event) {
  event.preventDefault();
  const thread = state.thread;
  const note = $("thread-note").value.trim();
  if (!note) return;
  const channelId = state.channelId;
  // Your partner replies when it's their message, or they're in the thread.
  const message = state.messages.find((m) => m.id === thread.messageId);
  thread.replying = message?.author === "partner" || thread.comments.some((c) => c.author === "partner");
  thread.comments = [...thread.comments, { author: "user", note, createdAt: new Date().toISOString() }];
  $("thread-note").value = "";
  renderThread();

  const request = thread.id
    ? api("POST", `/api/comments/${encodeURIComponent(thread.id)}/replies`, { note })
    : api("POST", `/api/messages/${encodeURIComponent(thread.messageId)}/comments`, { note, quote: thread.quote });
  const work = async () => {
    try {
      const data = await request;
      acceptThread(data.thread);
      if (data.toolCalls?.length) {
        state.toolCalls.push(...data.toolCalls);
        refreshNotebook().catch(() => {});
      }
      if (data.error) showFormError($("thread-form"), `${state.settings.partnerName} couldn't reply: ${data.error}`);
    } catch (error) {
      thread.replying = false;
      showFormError($("thread-form"), error.message);
    }
  };
  // While your partner replies, the channel is busy, like any turn.
  if (thread.replying) await withBusyChannel(channelId, work);
  else await work();
  // The channel is free again: unlock the reply box.
  if ($("thread-dialog").open) renderThread();
}

/** Put a thread from the server into state, and show it if it's open. */
function acceptThread(thread) {
  const index = state.threads.findIndex((t) => t.id === thread.id);
  if (index >= 0) state.threads[index] = thread;
  else state.threads.push(thread);
  if ($("thread-dialog").open && (state.thread.id === thread.id || !state.thread.id)) {
    state.thread = thread;
    renderThread();
  }
  renderMessages();
}

async function resolveThread() {
  const thread = state.thread;
  try {
    const data = await api("POST", `/api/comments/${encodeURIComponent(thread.id)}/resolve`, { resolved: !thread.resolved });
    acceptThread(data.thread);
  } catch (error) {
    showFormError($("thread-form"), error.message);
  }
}

async function deleteComment(comment) {
  const first = comment.id === state.thread.id;
  if (!confirm(first ? "Delete this comment and its whole thread?" : "Delete this comment?")) return;
  try {
    await api("DELETE", `/api/comments/${encodeURIComponent(comment.id)}`, {});
    if (first) {
      state.threads = state.threads.filter((t) => t.id !== comment.id);
      $("thread-dialog").close();
      renderMessages();
    } else {
      state.thread.comments = state.thread.comments.filter((c) => c.id !== comment.id);
      acceptThread(state.thread);
    }
  } catch (error) {
    showFormError($("thread-form"), error.message);
  }
}

/**
 * When you select text inside a message, show a Comment button just below
 * the selection.
 */
function updateCommentButton() {
  const button = $("comment-float");
  const selection = document.getSelection();
  const text = selection?.toString().trim() ?? "";
  // The selection's ends can be text nodes or elements.
  const contentOf = (node) => (node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement)?.closest(".message-content");
  const anchor = contentOf(selection?.anchorNode);
  const focus = contentOf(selection?.focusNode);
  if (!text || !anchor || anchor !== focus || text.length > 1000) {
    button.hidden = true;
    return;
  }
  const rect = selection.getRangeAt(0).getBoundingClientRect();
  button.hidden = false;
  button.style.top = `${Math.min(rect.bottom + 8, window.innerHeight - 56)}px`;
  button.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 140))}px`;
  button.dataset.messageId = anchor.closest(".message").dataset.messageId;
  button.dataset.quote = text;
}

// ----------------------------------------------------------- attachments

/*
 * Attaching notes: pick notebook entries with the paperclip, and they're
 * sent to your partner in full with your next message, and kept in their
 * view while that message is in the conversation. `[[Name]]` in the text
 * attaches that entry too (the server finds those).
 */

/** Entries you can attach: ones your partner can see. */
function attachable() {
  return state.notebook.entries.filter((e) => !(e.owner === "user" && e.settings.visibility === "hidden"));
}

function pickedAttachments() {
  if (!state.attachments.has(state.channelId)) state.attachments.set(state.channelId, new Set());
  return state.attachments.get(state.channelId);
}

function openAttach() {
  $("attach-search").value = "";
  renderAttachList();
  $("attach-dialog").showModal();
}

function renderAttachList() {
  const picked = pickedAttachments();
  const query = $("attach-search").value.trim().toLowerCase();
  const entries = attachable().filter((e) => !query || e.name.toLowerCase().includes(query));
  $("attach-list").replaceChildren(
    ...entries.map((entry) => {
      const item = document.createElement("li");
      const label = document.createElement("label");
      label.className = "attach-option";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = picked.has(entry.id);
      box.addEventListener("change", () => {
        if (box.checked) picked.add(entry.id);
        else picked.delete(entry.id);
        renderAttachRow();
      });
      const name = document.createElement("span");
      name.textContent = entry.name;
      label.append(box, entryAvatar(entry.name, entry.kind), name, badge(ownerLabel(entry.owner)));
      item.append(label);
      return item;
    }),
  );
  if (entries.length === 0) {
    const empty = document.createElement("li");
    empty.className = "hint";
    empty.textContent = "No entries found.";
    $("attach-list").append(empty);
  }
}

/** The chips above the text box: what's attached to the message you're writing. */
function renderAttachRow() {
  const row = $("attach-row");
  const picked = [...(state.attachments.get(state.channelId) ?? [])].map(findEntry).filter(Boolean);
  row.hidden = picked.length === 0;
  row.replaceChildren(
    ...picked.map((entry) => {
      const chip = document.createElement("span");
      chip.className = "attach-chip";
      chip.textContent = `📎 ${entry.name}`;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "link-button";
      remove.textContent = "✕";
      remove.setAttribute("aria-label", `Don't attach ${entry.name}`);
      remove.addEventListener("click", () => {
        pickedAttachments().delete(entry.id);
        renderAttachRow();
      });
      chip.append(remove);
      return chip;
    }),
  );
}

/** Under a message: the notes attached to it, each opening its entry. */
function renderAttachments(message) {
  const row = document.createElement("div");
  row.className = "message-attachments";
  for (const id of message.attachments) {
    const entry = findEntry(id);
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "attach-chip";
    chip.textContent = `📎 ${entry?.name ?? "a note you can't see"}`;
    chip.disabled = !entry;
    if (entry) chip.addEventListener("click", () => openEntry(entry));
    row.append(chip);
  }
  return row;
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
// The channel indicator follows the links' size when the sidebar changes width.
new ResizeObserver(() => moveChannelIndicator()).observe(els.channelList);

$("menu-button").addEventListener("click", openSidebar);
$("sidebar-scrim").addEventListener("click", closeSidebar);

$("settings-button").addEventListener("click", openSettings);
els.settingsForm.addEventListener("submit", saveSettings);
els.loadModels.addEventListener("click", loadModels);

$("channel-settings-button").addEventListener("click", openChannelSettings);
// Memory, in channel settings: fetch the latest summaries when it's opened.
$("channel-memory").addEventListener("toggle", () => {
  if ($("channel-memory").open) refreshSummaries();
});
$("memory-save-story").addEventListener("click", saveStory);
$("memory-update").addEventListener("click", () => updateSummaries(false));
$("memory-rebuild").addEventListener("click", () => updateSummaries(true));
els.settingsForm.elements.summaries.addEventListener("change", updateSummariesOnly);
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

$("open-models").addEventListener("click", openModels);
$("new-profile").addEventListener("click", () => openProfile(null));
$("new-roulette").addEventListener("click", () => openRoulette(null));
$("profile-form").addEventListener("submit", saveProfile);
$("profile-delete").addEventListener("click", deleteProfile);
$("roulette-form").addEventListener("submit", saveRoulette);
$("roulette-delete").addEventListener("click", deleteRoulette);
$("roulette-add").addEventListener("click", () => {
  const used = new Set([...$("roulette-entries").querySelectorAll(".roulette-profile")].map((s) => s.value));
  const next = state.profiles.find((p) => !used.has(p.id)) ?? state.profiles[0];
  $("roulette-entries").append(rouletteEntryRow({ profileId: next.id, weight: 1 }));
  updateRouletteShares();
});
$("roulette-entries").addEventListener("input", updateRouletteShares);
$("regenerate-form").addEventListener("submit", (event) => {
  event.preventDefault();
  $("regenerate-dialog").close();
  regenerate($("regenerate-profile").value || undefined);
});

// Stage 6: activity, tool log, inbox, comments, attachments.
$("inbox-button").addEventListener("click", openInbox);
$("open-tool-log").addEventListener("click", openToolLog);
$("tool-log-errors").addEventListener("change", renderToolLog);
$("tool-log-copy").addEventListener("click", copyToolLog);
$("profile-test").addEventListener("click", testProfileTools);
$("attach-button").addEventListener("click", openAttach);
$("attach-search").addEventListener("input", renderAttachList);
$("thread-form").addEventListener("submit", sendComment);
$("thread-resolve").addEventListener("click", resolveThread);
$("thread-picker").addEventListener("change", (event) => openThread(event.target.value));
els.messages.addEventListener("click", (event) => {
  const mark = event.target.closest(".comment-mark");
  if (mark) openThread(mark.dataset.thread);
});
document.addEventListener("selectionchange", updateCommentButton);
// Keep the selection when the button is pressed, so it's still there to read.
$("comment-float").addEventListener("pointerdown", (event) => event.preventDefault());
$("comment-float").addEventListener("click", (event) => {
  const { messageId, quote } = event.currentTarget.dataset;
  event.currentTarget.hidden = true;
  document.getSelection()?.removeAllRanges();
  newComment(messageId, quote);
});

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
