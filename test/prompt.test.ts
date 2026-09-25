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
  toChatHistory,
  type PromptInput,
} from "../src/prompt.ts";
import type { Author, Channel, Message, Settings } from "../src/types.ts";

const settings: Settings = {
  partnerName: "Arlo",
  partnerPrompt: "You are Arlo, a writer of grounded prose.",
  model: "test/model",
  temperature: 0.9,
  maxTokens: 500,
  historyLimit: 40,
  userCharacters: [],
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
    position: 0,
    characterName: "Ilse Marrow",
    characterSheet: "Name: Ilse Marrow\nRole: lighthouse keeper",
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}

const story = channel({});
const ooc = channel({ id: "ooc", name: "ooc", kind: "ooc", position: 1, characterName: "", characterSheet: "" });

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
  return buildPromptStack({ settings, channel: story, channels: [story, ooc], messages: [msg("user", "Hi")], ...overrides });
}

describe("buildPromptStack in an RP channel", () => {
  test("puts every instruction layer in one system message, in stack order", () => {
    const [system] = build();
    expect(system!.role).toBe("system");

    const text = system!.content;
    const framing = text.indexOf(RP_FRAMING);
    const partner = text.indexOf(settings.partnerPrompt);
    const character = text.indexOf(story.characterSheet);

    // Layer 1 (framing, then partner prompt) comes before layer 3 (character).
    expect(framing).toBeGreaterThanOrEqual(0);
    expect(partner).toBeGreaterThan(framing);
    expect(character).toBeGreaterThan(partner);
    expect(text).toContain("## The character you play: Ilse Marrow");
  });

  test("leaves out the layers that aren't built yet", () => {
    const [system] = build();
    expect(system!.content).not.toContain("Model notes");
  });

  test("layer 2 describes the current scene's mode, between who's writing and the character", () => {
    const [literary] = build();
    const style = literary!.content.indexOf("## Style");
    expect(literary!.content).toContain(modeInstructions("literary", "Ilse Marrow"));
    expect(style).toBeGreaterThan(literary!.content.indexOf(RP_FRAMING));
    expect(style).toBeLessThan(literary!.content.indexOf("## The character you play"));

    const [casual] = build({ channel: channel({ mode: "casual" }) });
    expect(casual!.content).toContain(modeInstructions("casual", "Ilse Marrow"));
    expect(casual!.content).toContain("Ilse Marrow: *leans on the doorframe*");
  });

  test("names your characters in casual scenes only", () => {
    const withCharacters = { ...settings, userCharacters: [{ name: "Kestrel", prefix: "k" }] };
    expect(build({ settings: withCharacters, channel: channel({ mode: "casual" }) })[0]!.content).toContain(
      "The user plays Kestrel. Never write their messages.",
    );
    expect(build({ settings: withCharacters })[0]!.content).not.toContain("Kestrel");
  });

  test("leaves out an empty character sheet instead of sending an empty heading", () => {
    const [system] = build({ channel: channel({ characterSheet: "   " }) });
    expect(system!.content).not.toContain("The character you play");
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
    expect(system!.content).not.toContain(story.characterSheet);
    // Your partner prompt still applies: it's who they are.
    expect(system!.content).toContain(settings.partnerPrompt);
  });

  test("lists the channels on the server", () => {
    const [system] = build({ channel: ooc });
    expect(system!.content).toContain("## Channels on your server");
    expect(system!.content).toContain("#story: roleplay, you play Ilse Marrow");
    expect(system!.content).toContain("#ooc: this conversation");
  });

  test("uses the OOC nudges", () => {
    expect(build({ channel: ooc, messages: [] }).at(-1)!.content).toBe(NUDGES.ooc.opening);
  });
});

describe("describeChannels", () => {
  test("describes each kind of channel", () => {
    const other = channel({ id: "x", name: "side-chat", kind: "ooc", characterName: "" });
    const noCharacter = channel({ id: "y", name: "draft", characterName: "" });
    expect(describeChannels([story, other, noCharacter, ooc], ooc)).toBe(
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
