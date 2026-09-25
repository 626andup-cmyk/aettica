/**
 * Aettica's web app: everything that happens in the browser.
 *
 * The app is deliberately simple: no framework, no build step. It keeps a
 * copy of the chat in `state`, talks to the server with `fetch`, and redraws
 * the message list with `render()` whenever something changes.
 *
 * The server is always the source of truth. The browser never guesses what
 * was saved; it shows what the server sends back.
 */

"use strict";

// ------------------------------------------------------------------ state

/** Everything the page is currently showing. */
const state = {
  /** @type {null | {partnerPrompt:string, characterSheet:string, model:string, temperature:number, maxTokens:number, historyLimit:number}} */
  settings: null,
  /** @type {Array<{id:string, author:"user"|"partner", content:string, createdAt:string, editedAt?:string, model?:string}>} */
  messages: [],
  /** True while the partner is writing. Disables the buttons that would start another turn. */
  busy: false,
  /** Id of the message being edited, if any. */
  editingId: null,
  /** What "Try again" does after an error, or null if retrying makes no sense. */
  retry: null,
};

// Shortcut for looking up elements by id.
const $ = (id) => document.getElementById(id);

const els = {
  messages: $("messages"),
  status: $("status"),
  error: $("error"),
  errorText: $("error-text"),
  errorRetry: $("error-retry"),
  errorDismiss: $("error-dismiss"),
  form: $("composer-form"),
  input: $("composer-input"),
  send: $("send-button"),
  turn: $("turn-button"),
  settingsButton: $("settings-button"),
  settingsDialog: $("settings-dialog"),
  settingsForm: $("settings-form"),
  settingsError: $("settings-error"),
  settingsCancel: $("settings-cancel"),
  loadModels: $("load-models"),
  modelList: $("model-list"),
  previewPrompt: $("preview-prompt"),
  promptDialog: $("prompt-dialog"),
  promptPreview: $("prompt-preview"),
  promptClose: $("prompt-close"),
  clearChat: $("clear-chat"),
};

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

/** Fetch the whole chat from the server and redraw. */
async function loadState() {
  const data = await api("GET", "/api/state");
  state.settings = data.settings;
  state.messages = data.messages;
  setBusy(data.busy);
  render();
  scrollToBottom();
  // If a turn was already running (say, started in another tab), check back
  // until it finishes so its reply shows up here too.
  if (data.busy) setTimeout(loadState, 3000);
}

// ---------------------------------------------------------------- actions

/**
 * Send what's in the text box. The server saves it and your partner replies
 * in the same request.
 */
async function sendMessage() {
  const content = els.input.value;
  if (content.trim() === "" || state.busy) return;

  hideError();
  setBusy(true);

  // Show your post straight away, as a placeholder, while the partner
  // writes. It's swapped for the saved copy when the server answers.
  const placeholder = { id: "pending", author: "user", content, createdAt: new Date().toISOString() };
  state.messages.push(placeholder);
  els.input.value = "";
  autoGrow();
  render();
  scrollToBottom();

  try {
    const data = await api("POST", "/api/messages", { content });
    state.messages = state.messages.filter((m) => m !== placeholder);
    state.messages.push(data.userMessage);
    if (data.partnerMessage) {
      state.messages.push(data.partnerMessage);
    } else if (data.error) {
      // Your message is saved but the reply failed. "Try again" asks the
      // partner for a turn, which answers the message you already sent.
      showError(data.error, partnerTurn);
    }
  } catch (error) {
    // Nothing was saved (e.g. the server is down), so put your text back in
    // the box; "Try again" simply sends it again.
    state.messages = state.messages.filter((m) => m !== placeholder);
    els.input.value = content;
    autoGrow();
    showError(error.message, sendMessage);
  } finally {
    setBusy(false);
    render();
    scrollToBottom();
  }
}

/** Let your partner write without a new message from you. */
async function partnerTurn() {
  await runTurn(async () => {
    const data = await api("POST", "/api/turn", {});
    state.messages.push(data.partnerMessage);
  }, partnerTurn);
}

/** Replace your partner's last reply with a fresh one. */
async function regenerate() {
  await runTurn(async () => {
    const data = await api("POST", "/api/regenerate", {});
    state.messages = state.messages.filter((m) => m.id !== data.replacedId);
    state.messages.push(data.partnerMessage);
  }, regenerate);
}

/** Shared wrapper for partner turns: busy indicator, errors, redraw. */
async function runTurn(work, retry) {
  if (state.busy) return;
  hideError();
  setBusy(true);
  try {
    await work();
  } catch (error) {
    showError(error.message, retry);
  } finally {
    setBusy(false);
    render();
    scrollToBottom();
  }
}

async function saveEdit(id, content) {
  try {
    const data = await api("PATCH", `/api/messages/${id}`, { content });
    const index = state.messages.findIndex((m) => m.id === id);
    if (index !== -1) state.messages[index] = data.message;
    state.editingId = null;
    render();
  } catch (error) {
    showError(error.message, null);
  }
}

async function deleteMessage(id) {
  if (!confirm("Delete this message?")) return;
  try {
    await api("DELETE", `/api/messages/${id}`, {});
    state.messages = state.messages.filter((m) => m.id !== id);
    render();
  } catch (error) {
    showError(error.message, null);
  }
}

// -------------------------------------------------------------- rendering

/** Redraw the whole message list from `state.messages`. */
function render() {
  els.messages.replaceChildren();

  if (state.messages.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent =
      "No messages yet. Write the first post, or press “Partner's turn” to let your partner open the story.";
    els.messages.append(empty);
    return;
  }

  const lastId = state.messages.at(-1).id;
  for (const message of state.messages) {
    els.messages.append(renderMessage(message, message.id === lastId));
  }
}

/**
 * Build the element for one message.
 *
 * Text is always inserted as text, never as raw HTML, except for the tiny
 * bit of formatting in `formatText`, which escapes everything first. That
 * way a model reply containing `<script>` can't run code in your browser.
 */
function renderMessage(message, isLast) {
  const isUser = message.author === "user";
  const name = isUser ? "You" : "Partner";

  const root = document.createElement("article");
  root.className = `message ${message.author}`;

  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = name[0];
  avatar.setAttribute("aria-hidden", "true");

  const meta = document.createElement("div");
  meta.className = "meta";
  const author = document.createElement("span");
  author.className = "author";
  author.textContent = name;
  const time = document.createElement("time");
  time.className = "time";
  time.dateTime = message.createdAt;
  time.textContent = formatTime(message.createdAt) + (message.editedAt ? " (edited)" : "");
  meta.append(author, time);
  if (message.model) {
    const model = document.createElement("span");
    model.className = "model";
    // Show just the part after the last "/" (e.g. "DeepSeek-V3.1-Terminus")
    // to save space on a phone; the full id appears when you hover or long-press.
    model.textContent = message.model.split("/").at(-1);
    model.title = message.model;
    meta.append(model);
  }

  root.append(avatar, meta);

  // The placeholder for a post that's still being sent has no actions yet.
  if (message.id === "pending") {
    const content = document.createElement("div");
    content.className = "content";
    content.innerHTML = formatText(message.content);
    root.append(content);
    return root;
  }

  if (state.editingId === message.id) {
    root.append(renderEditor(message));
    return root;
  }

  const content = document.createElement("div");
  content.className = "content";
  content.innerHTML = formatText(message.content);

  const actions = document.createElement("div");
  actions.className = "actions";
  actions.append(
    actionButton("Edit", () => {
      state.editingId = message.id;
      render();
    }),
    actionButton("Delete", () => deleteMessage(message.id)),
  );
  // Only the newest message can be regenerated, and only if it's the partner's.
  if (isLast && !isUser) {
    actions.append(actionButton("Regenerate", regenerate, state.busy));
  }

  root.append(content, actions);
  return root;
}

/** The inline editor shown in place of a message's text while editing. */
function renderEditor(message) {
  const wrapper = document.createElement("div");
  const box = document.createElement("textarea");
  box.className = "edit-box";
  box.value = message.content;

  const actions = document.createElement("div");
  actions.className = "actions";
  actions.append(
    actionButton("Save", () => {
      if (box.value.trim() !== "") saveEdit(message.id, box.value);
    }),
    actionButton("Cancel", () => {
      state.editingId = null;
      render();
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

// ------------------------------------------------------ status and errors

/** Show or hide the "writing…" indicator and lock the turn buttons. */
function setBusy(busy) {
  state.busy = busy;
  els.status.hidden = !busy;
  els.send.disabled = busy;
  els.turn.disabled = busy;
}

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

// --------------------------------------------------------------- settings

/** Fill the settings form from `state.settings` and open it. */
function openSettings() {
  const s = state.settings;
  const form = els.settingsForm.elements;
  form.partnerPrompt.value = s.partnerPrompt;
  form.characterSheet.value = s.characterSheet;
  form.model.value = s.model;
  form.temperature.value = s.temperature;
  form.maxTokens.value = s.maxTokens;
  form.historyLimit.value = s.historyLimit;
  els.settingsError.hidden = true;
  els.settingsDialog.showModal();
}

/** Read the settings form. Numbers are converted from the text boxes' strings. */
function readSettingsForm() {
  const form = els.settingsForm.elements;
  return {
    partnerPrompt: form.partnerPrompt.value,
    characterSheet: form.characterSheet.value,
    model: form.model.value,
    temperature: Number(form.temperature.value),
    maxTokens: Number(form.maxTokens.value),
    historyLimit: Number(form.historyLimit.value),
  };
}

async function saveSettings(event) {
  // Stop the <form method="dialog"> from closing the dialog before we know
  // the save worked.
  event.preventDefault();
  try {
    const data = await api("PUT", "/api/settings", readSettingsForm());
    state.settings = data.settings;
    els.settingsDialog.close();
  } catch (error) {
    els.settingsError.textContent = error.message;
    els.settingsError.hidden = false;
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
    els.settingsError.textContent = error.message;
    els.settingsError.hidden = false;
    els.loadModels.textContent = "Load list";
  } finally {
    els.loadModels.disabled = false;
  }
}

/**
 * Show the exact prompt stack the next turn would send. Uses the *saved*
 * settings, so save first if you want to preview a change.
 */
async function previewPrompt() {
  try {
    const { messages } = await api("GET", "/api/prompt");
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
    els.settingsError.textContent = error.message;
    els.settingsError.hidden = false;
  }
}

async function clearChat() {
  if (!confirm("Delete every message in this chat? This can't be undone.")) return;
  try {
    await api("DELETE", "/api/messages", {});
    state.messages = [];
    els.settingsDialog.close();
    render();
  } catch (error) {
    els.settingsError.textContent = error.message;
    els.settingsError.hidden = false;
  }
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
els.errorRetry.addEventListener("click", () => state.retry && state.retry());
els.errorDismiss.addEventListener("click", hideError);

els.settingsButton.addEventListener("click", openSettings);
els.settingsForm.addEventListener("submit", saveSettings);
els.settingsCancel.addEventListener("click", () => els.settingsDialog.close());
els.loadModels.addEventListener("click", loadModels);
els.previewPrompt.addEventListener("click", previewPrompt);
els.promptClose.addEventListener("click", () => els.promptDialog.close());
els.clearChat.addEventListener("click", clearChat);

// Register the service worker, which is what makes the app installable.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch((error) => {
    console.warn("Service worker registration failed:", error);
  });
}

loadState().catch((error) => showError(`Couldn't load the chat: ${error.message}`, () => location.reload()));
