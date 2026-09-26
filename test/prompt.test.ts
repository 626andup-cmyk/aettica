/**
 * Tests for prompt assembly (src/prompt.ts): the prompt stack's order, what
 * gets left out, how RP and OOC channels differ, and the nudge that lets the
 * partner write without a message.
 */

import { describe, expect, test } from "bun:test";
import {
  buildPromptStack,
  describeChannels,
  modeInstructions,
  NEW_SCENE_NUDGE,
  NUDGES,
  OOC_FRAMING,
  RP_FRAMING,
  recentMessages,
  sceneBreakMarker,
  SECRET_NOTE,
  toChatHistory,
  type PromptInput,
} from "../src/prompt.ts";
import type { PromptEntry } from "../src/notebook.ts";
import type { Author, Channel, Message, NotebookEntry, Settings } from "../src/types.ts";

const settings: Settings = {
  partnerName: "Arlo",
  partnerPrompt: "You are Arlo, a writer of grounded prose.",
  literaryPrompt: "LITERARY: take your time.",
  casualPrompt: "CASUAL: keep it snappy.",
  oocPrompt: "OOC: one or two sentences.",
  rpAssignment: "",
  oocAssignment: "",
  historyLimit: 40,
  appTheme: "classic",
};

function channel(overrides: Partial<Channel>): Channel {
  return {
    id: "story",
    name: "story",
    kind: "rp",
    mode: "literary",
    pendingMode: null,
    theme: null,
    assignment: null,
    position: 0,
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}

const story = channel({});
const ooc = channel({ id: "ooc", name: "ooc", kind: "ooc", position: 1 });

/** A notebook entry, as the prompt receives it. */
function entry(name: string, extra: Partial<NotebookEntry> = {}, hiddenFromUser = false): PromptEntry {
  return {
    entry: {
      id: name,
      kind: "character",
      name,
      fields: [],
      systemPrompt: "",
      proxyPrefix: null,
      folderId: null,
      owner: "partner",
      visibility: null,
      editing: null,
      createdAt: "",
      updatedAt: "",
      ...extra,
    },
    hiddenFromUser,
  };
}

const ilse = entry("Ilse Marrow", {
  fields: [
    { label: "Role", value: "lighthouse keeper" },
    { label: "Empty", value: "" },
  ],
  systemPrompt: "Ilse never raises her voice. She knows [[The Charted Sea|the sea]].",
});
const kestrel = entry("Kestrel", { owner: "user", proxyPrefix: "k" });
const storyNotebook = { pinned: [ilse], linked: [] };

let nextId = 0;
function msg(author: Author, content: string, extra: Partial<Message> = {}): Message {
  return {
    id: String(nextId++),
    channelId: "story",
    kind: "post",
    mode: "literary",
    turnId: null,
    author,
    content,
    characters: [],
    createdAt: new Date(0).toISOString(),
    ...extra,
  };
}

/** A scene break, as stored. */
function sceneBreak(title: string): Message {
  return msg("user", title, { kind: "scene_break", mode: null });
}

/** Build a stack for `#story` unless told otherwise. */
function build(overrides: Partial<PromptInput> = {}) {
  return buildPromptStack({
    settings,
    channel: story,
    channels: [story, ooc],
    messages: [msg("user", "Hi")],
    notebook: storyNotebook,
    overview: { castNames: { story: ["Ilse Marrow"] }, entries: [ilse] },
    ...overrides,
  });
}

describe("buildPromptStack in an RP channel", () => {
  test("sends only the prompt for the scene's mode, after its mode instructions", () => {
    const [literary] = build();
    expect(literary!.content).toContain(`${modeInstructions("literary", "Ilse Marrow")}\n\n${settings.literaryPrompt}`);
    expect(literary!.content).not.toContain(settings.casualPrompt);
    expect(literary!.content).not.toContain(settings.oocPrompt);

    const [casual] = build({ channel: channel({ mode: "casual" }) });
    expect(casual!.content).toContain(settings.casualPrompt);
    expect(casual!.content).not.toContain(settings.literaryPrompt);
  });

  test("puts every instruction layer in one system message, in stack order", () => {
    const [system] = build();
    expect(system!.role).toBe("system");

    const text = system!.content;
    const framing = text.indexOf(RP_FRAMING);
    const partner = text.indexOf(settings.partnerPrompt);
    const character = text.indexOf("### Ilse Marrow (you play this character)");

    // Layer 1 (framing, then partner prompt) comes before layer 3 (the cast).
    expect(framing).toBeGreaterThanOrEqual(0);
    expect(partner).toBeGreaterThan(framing);
    expect(character).toBeGreaterThan(partner);
    expect(text).toContain("## The cast");
  });

  test("writes each pinned entry out with its fields and notes, and links as plain names", () => {
    const [system] = build();
    expect(system!.content).toContain(
      "### Ilse Marrow (you play this character)\nRole: lighthouse keeper\nNotes for you: Ilse never raises her voice. She knows the sea.",
    );
    // Empty fields are left out.
    expect(system!.content).not.toContain("Empty:");
  });

  test("puts lore and linked notes under their own headings", () => {
    const sea = entry("The Charted Sea", { kind: "lore", fields: [{ label: "Summary", value: "Mapped waters." }] });
    const bell = entry("The Bell", { kind: "lore", fields: [{ label: "Summary", value: "It rings." }] });
    const [system] = build({ notebook: { pinned: [ilse, bell], linked: [sea] } });
    expect(system!.content).toContain("## Lore\n\n### The Bell\nSummary: It rings.");
    expect(system!.content).toContain("## Linked notes\n\n### The Charted Sea\nSummary: Mapped waters.");
  });

  test("says who plays whom, so the model leaves the user's characters alone", () => {
    const [system] = build({ notebook: { pinned: [ilse, kestrel], linked: [] } });
    expect(system!.content).toContain("### Kestrel (the user plays this character)");
    expect(system!.content).toContain(
      "You play Ilse Marrow. The user plays Kestrel. Never write their actions, dialogue or thoughts.",
    );
  });

  test("says shared characters are open to both of you", () => {
    const bo = entry("Bo", { owner: "joint" });
    const [system] = build({ notebook: { pinned: [ilse, bo, kestrel], linked: [] } });
    expect(system!.content).toContain("### Bo (shared: either of you can play this character)");
    expect(system!.content).toContain(
      "You play Ilse Marrow. You and the user share Bo: either of you can write for them. Keep to what the user has written for them. The user plays Kestrel.",
    );
  });

  test("marks entries hidden from the user as secrets", () => {
    const secret = entry("The Drowned Man", {}, true);
    const [system] = build({ notebook: { pinned: [ilse, secret], linked: [] } });
    expect(system!.content).toContain(`### The Drowned Man (you play this character)\n(${SECRET_NOTE})`);
  });

  test("leaves out the model notes when the profile has none, and adds them when it does", () => {
    expect(build()[0]!.content).not.toContain("Model notes");
    const [system] = build({ modelNotes: "Don't restate the scene." });
    const text = system!.content;
    expect(text).toContain("## Model notes\n\nDon't restate the scene.");
    // Layer 4 comes after layer 3 (the cast).
    expect(text.indexOf("## Model notes")).toBeGreaterThan(text.indexOf("## The cast"));
  });

  test("layer 2 describes the current scene's mode, between who's writing and the character", () => {
    const [literary] = build();
    const style = literary!.content.indexOf("## Style");
    expect(literary!.content).toContain(modeInstructions("literary", "Ilse Marrow"));
    expect(style).toBeGreaterThan(literary!.content.indexOf(RP_FRAMING));
    expect(style).toBeLessThan(literary!.content.indexOf("## The cast"));

    const [casual] = build({ channel: channel({ mode: "casual" }) });
    expect(casual!.content).toContain(modeInstructions("casual", "Ilse Marrow"));
    expect(casual!.content).toContain("Ilse Marrow: *leans on the doorframe*");
  });

  test("leaves out empty cast, lore and linked sections instead of sending empty headings", () => {
    const [system] = build({ notebook: { pinned: [], linked: [] } });
    expect(system!.content).not.toContain("## The cast");
    expect(system!.content).not.toContain("## Lore");
    expect(system!.content).not.toContain("## Linked notes");
    expect(system!.content).not.toContain("## Whose characters");
  });

  test("follows the system message with the conversation", () => {
    const stack = build({ messages: [msg("user", "Knock knock"), msg("partner", "Who's there?"), msg("user", "Lettuce")] });
    expect(stack.slice(1)).toEqual([
      { role: "user", content: "Knock knock" },
      { role: "assistant", content: "Who's there?" },
      { role: "user", content: "Lettuce" },
    ]);
  });

  test("adds a continue nudge when the channel ends on the partner (a turn without a user message)", () => {
    const stack = build({ messages: [msg("user", "Hi"), msg("partner", "Hello there.")] });
    expect(stack.at(-1)).toEqual({ role: "user", content: NUDGES.rp.continue });
  });

  test("adds an opening nudge when the channel is empty", () => {
    const stack = build({ messages: [] });
    expect(stack).toHaveLength(2);
    expect(stack[1]).toEqual({ role: "user", content: NUDGES.rp.opening });
  });

  test("only sends the most recent historyLimit messages", () => {
    const messages = [msg("user", "one"), msg("partner", "two"), msg("user", "three")];
    const stack = build({ settings: { ...settings, historyLimit: 1 }, messages });
    expect(stack.slice(1)).toEqual([{ role: "user", content: "three" }]);
  });
});

describe("scene breaks and casual bubbles in the history", () => {
  test("a scene break becomes an OOC line from the user", () => {
    const stack = build({ messages: [msg("user", "Hi"), msg("partner", "Hello."), sceneBreak("The Storm"), msg("user", "*Thunder.*")] });
    expect(stack.slice(1)).toEqual([
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello." },
      { role: "user", content: `${sceneBreakMarker("The Storm")}\n\n*Thunder.*` },
    ]);
    expect(sceneBreakMarker("")).toBe("(OOC: Scene break.)");
  });

  test("ending on a scene break asks for the new scene's opening", () => {
    const stack = build({ messages: [msg("user", "Hi"), msg("partner", "Hello."), sceneBreak("")] });
    expect(stack.at(-1)).toEqual({ role: "user", content: `(OOC: Scene break.)\n\n${NEW_SCENE_NUDGE}` });
  });

  test("casual bubbles are named and joined line by line", () => {
    const casual = { mode: "casual" as const };
    const stack = build({
      channel: channel({ mode: "casual" }),
      messages: [
        msg("user", "*waves*", { ...casual, characters: ["Kestrel"] }),
        msg("user", "hi", { ...casual, characters: ["Kestrel"] }),
        msg("partner", "Door's open.", { ...casual, characters: ["Ilse Marrow"] }),
        msg("partner", "*nods*", { ...casual, characters: ["Ilse Marrow"] }),
      ],
    });
    expect(stack.slice(1, 3)).toEqual([
      { role: "user", content: "Kestrel: *waves*\nKestrel: hi" },
      { role: "assistant", content: "Ilse Marrow: Door's open.\nIlse Marrow: *nods*" },
    ]);
  });
});

describe("buildPromptStack in an OOC channel", () => {
  test("frames the partner as themselves, with no character sheet", () => {
    const [system] = build({ channel: ooc });
    expect(system!.content).toContain(OOC_FRAMING);
    expect(system!.content).not.toContain(RP_FRAMING);
    expect(system!.content).not.toContain("lighthouse keeper");
    // Your partner prompt still applies: it's who they are.
    expect(system!.content).toContain(settings.partnerPrompt);
  });

  test("sends only the OOC prompt, after who your partner is", () => {
    const [system] = build({ channel: ooc });
    const text = system!.content;
    expect(text).toContain(`## How you talk here\n\n${settings.oocPrompt}`);
    expect(text.indexOf(settings.oocPrompt)).toBeGreaterThan(text.indexOf(settings.partnerPrompt));
    expect(text).not.toContain(settings.literaryPrompt);
    expect(text).not.toContain(settings.casualPrompt);
  });

  test("lists the channels on the server", () => {
    const [system] = build({ channel: ooc });
    expect(system!.content).toContain("## Channels on your server");
    expect(system!.content).toContain("#story: roleplay, you play Ilse Marrow");
    expect(system!.content).toContain("#ooc: this conversation");
  });

  test("lists the notebook, flagging secrets", () => {
    const secret = entry("The Drowned Man", {}, true);
    const sea = entry("The Charted Sea", { kind: "lore", owner: "joint" });
    const [system] = build({ channel: ooc, overview: { castNames: {}, entries: [ilse, secret, sea, kestrel] } });
    expect(system!.content).toContain("## Your shared notebook");
    expect(system!.content).toContain("- Ilse Marrow (character, yours)");
    expect(system!.content).toContain("- The Drowned Man (character, yours, hidden from the user)");
    expect(system!.content).toContain("- The Charted Sea (lore, shared)");
    expect(system!.content).toContain("- Kestrel (character, the user's)");
    expect(system!.content).toContain("Don't reveal them here either.");
  });

  test("uses the OOC nudges", () => {
    expect(build({ channel: ooc, messages: [] }).at(-1)!.content).toBe(NUDGES.ooc.opening);
  });
});

describe("describeChannels", () => {
  test("describes each kind of channel", () => {
    const other = channel({ id: "x", name: "side-chat", kind: "ooc" });
    const noCharacter = channel({ id: "y", name: "draft" });
    expect(describeChannels([story, other, noCharacter, ooc], ooc, { story: ["Ilse Marrow"] })).toBe(
      [
        "- #story: roleplay, you play Ilse Marrow",
        "- #side-chat: another out-of-character chat",
        "- #draft: roleplay",
        "- #ooc: this conversation",
      ].join("\n"),
    );
  });
});

describe("toChatHistory", () => {
  test("merges consecutive messages from the same author", () => {
    const history = toChatHistory([msg("user", "First."), msg("user", "Second."), msg("partner", "Reply.")]);
    expect(history).toEqual([
      { role: "user", content: "First.\n\nSecond." },
      { role: "assistant", content: "Reply." },
    ]);
  });

  test("skips messages that are only whitespace", () => {
    expect(toChatHistory([msg("user", "  \n "), msg("partner", "Hi")])).toEqual([{ role: "assistant", content: "Hi" }]);
  });
});

describe("recentMessages", () => {
  test("keeps the newest messages in their original order", () => {
    const messages = [msg("user", "a"), msg("user", "b"), msg("user", "c")];
    expect(recentMessages(messages, 2).map((m) => m.content)).toEqual(["b", "c"]);
  });
});
