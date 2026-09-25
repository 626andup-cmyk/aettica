/**
 * Tests for turning text into messages: casual bubbles (src/bubbles.ts) and
 * posts, replies and scene break commands (src/posts.ts).
 */

import { describe, expect, test } from "bun:test";
import { partnerAliases, splitBubbles } from "../src/bubbles.ts";
import { parseSceneBreak, postToMessages, replyToMessages } from "../src/posts.ts";
import type { Channel } from "../src/types.ts";

const you = [
  { name: "Kestrel", aliases: ["k"] },
  { name: "Jun", aliases: ["j"] },
];

describe("splitBubbles", () => {
  test("starts a new bubble at each known tag, matching prefix or name in any case", () => {
    expect(splitBubbles("k: *waves*\nJUN: hi!\nkestrel: yo", you, null)).toEqual([
      { speaker: "Kestrel", text: "*waves*" },
      { speaker: "Jun", text: "hi!" },
      { speaker: "Kestrel", text: "yo" },
    ]);
  });

  test("keeps untagged lines in the current bubble", () => {
    expect(splitBubbles("k: first line\nsecond line", you, null)).toEqual([
      { speaker: "Kestrel", text: "first line\nsecond line" },
    ]);
  });

  test("gives lines before any tag to the fallback speaker", () => {
    expect(splitBubbles("hello\nj: hey", you, "Kestrel")).toEqual([
      { speaker: "Kestrel", text: "hello" },
      { speaker: "Jun", text: "hey" },
    ]);
    expect(splitBubbles("just me", you, null)).toEqual([{ speaker: null, text: "just me" }]);
  });

  test("ignores tags that aren't known speakers", () => {
    expect(splitBubbles("k: see https://example.com\nNote: the tide is out", you, null)).toEqual([
      { speaker: "Kestrel", text: "see https://example.com\nNote: the tide is out" },
    ]);
  });

  test("drops empty bubbles", () => {
    expect(splitBubbles("k:\nj:   \n", you, null)).toEqual([]);
  });
});

describe("partnerAliases", () => {
  test.each([
    ["Ilse Marrow", ["Ilse"]],
    ["Vee", []],
    ["", []],
  ])("%j -> %j", (name, aliases) => {
    expect(partnerAliases(name)).toEqual(aliases);
  });
});

describe("parseSceneBreak", () => {
  test.each([
    ["=====", ""],
    ["  ===== The Storm  ", "The Storm"],
    ["==========Dawn", "Dawn"],
    ["====", null],
    ["=====\nand more", null],
    ["text =====", null],
  ])("%j -> %j", (text, title) => {
    expect(parseSceneBreak(text)).toBe(title);
  });
});

function channel(overrides: Partial<Channel>): Channel {
  return {
    id: "c",
    name: "story",
    kind: "rp",
    mode: "literary",
    pendingMode: null,
    position: 0,
    characterName: "Ilse Marrow",
    characterSheet: "",
    createdAt: "",
    ...overrides,
  };
}
const characters = [{ name: "Kestrel", prefix: "k" }];

describe("postToMessages", () => {
  test("a literary post is one message, voicing no one", () => {
    expect(postToMessages(channel({}), "k: *knocks*", characters, "Kestrel")).toEqual([
      { channelId: "c", author: "user", content: "k: *knocks*", characters: [], mode: "literary" },
    ]);
  });

  test("a casual post is split into bubbles by proxy tag, using the picked character by default", () => {
    const messages = postToMessages(channel({ mode: "casual" }), "hi\nk: *waves*", [...characters, { name: "Jun", prefix: "j" }], "Jun");
    expect(messages.map((m) => [m.characters, m.content, m.mode])).toEqual([
      [["Jun"], "hi", "casual"],
      [["Kestrel"], "*waves*", "casual"],
    ]);
  });

  test("an OOC post is one message with no mode", () => {
    expect(postToMessages(channel({ kind: "ooc" }), "hey", characters, null)[0]).toMatchObject({ mode: null, characters: [] });
  });
});

describe("replyToMessages", () => {
  test("a literary reply is one post voicing the channel's character", () => {
    expect(replyToMessages(channel({}), "Ilse: prose", "m")).toEqual([
      { channelId: "c", author: "partner", model: "m", content: "Ilse: prose", characters: ["Ilse Marrow"], mode: "literary" },
    ]);
  });

  test("a casual reply becomes one bubble per Name: line", () => {
    const messages = replyToMessages(channel({ mode: "casual" }), "Ilse Marrow: Door's open.\nIlse: *nods*\nstill nodding", "m");
    expect(messages.map((m) => [m.characters, m.content])).toEqual([
      [["Ilse Marrow"], "Door's open."],
      [["Ilse Marrow"], "*nods*\nstill nodding"],
    ]);
  });

  test("a casual reply with no tags is one bubble for the channel's character", () => {
    expect(replyToMessages(channel({ mode: "casual" }), "Door's open.", "m")).toHaveLength(1);
  });

  test("an OOC reply voices no one", () => {
    expect(replyToMessages(channel({ kind: "ooc", characterName: "" }), "hey!", "m")[0]).toMatchObject({
      characters: [],
      mode: null,
    });
  });
});
