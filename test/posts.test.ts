/**
 * Tests for turning text into messages: casual bubbles (src/bubbles.ts) and
 * posts, replies and scene break commands (src/posts.ts).
 */

import { describe, expect, test } from "bun:test";
import { partnerAliases, splitBubbles } from "../src/bubbles.ts";
import { mentionedCharacters, parseSceneBreak, postToMessages, replyToMessages } from "../src/posts.ts";
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
    theme: null,
    position: 0,
    createdAt: "",
    ...overrides,
  };
}
const characters = [{ name: "Kestrel", proxyPrefix: "k" }];
const ilse = [{ name: "Ilse Marrow" }];

describe("mentionedCharacters", () => {
  const cast = [{ name: "Ilse Marrow" }, { name: "Tamsin Hale" }];

  test("finds characters by full or first name", () => {
    expect(mentionedCharacters("Tamsin laughed. Ilse Marrow did not.", cast)).toEqual(["Ilse Marrow", "Tamsin Hale"]);
  });

  test("doesn't match inside other words", () => {
    expect(mentionedCharacters("Ilsebeth waved.", cast)).toEqual([]);
  });

  test("falls back to the only character, or to nobody (narration)", () => {
    expect(mentionedCharacters("The sea rose.", [cast[0]!])).toEqual(["Ilse Marrow"]);
    expect(mentionedCharacters("The sea rose.", cast)).toEqual([]);
  });
});

describe("postToMessages", () => {
  test("a literary post is one message, voicing no one", () => {
    expect(postToMessages(channel({}), "k: *knocks*", characters, "Kestrel")).toEqual([
      { channelId: "c", author: "user", content: "k: *knocks*", characters: [], mode: "literary" },
    ]);
  });

  test("a casual post is split into bubbles by proxy tag, using the picked character by default", () => {
    const messages = postToMessages(channel({ mode: "casual" }), "hi\nk: *waves*", [...characters, { name: "Jun", proxyPrefix: "j" }], "Jun");
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
  test("a literary reply with one character in the cast voices them", () => {
    expect(replyToMessages(channel({}), "Ilse: prose", "m", ilse)).toEqual([
      { channelId: "c", author: "partner", model: "m", content: "Ilse: prose", characters: ["Ilse Marrow"], mode: "literary" },
    ]);
  });

  test("a casual reply becomes one bubble per Name: line", () => {
    const messages = replyToMessages(channel({ mode: "casual" }), "Ilse Marrow: Door's open.\nIlse: *nods*\nstill nodding", "m", ilse);
    expect(messages.map((m) => [m.characters, m.content])).toEqual([
      [["Ilse Marrow"], "Door's open."],
      [["Ilse Marrow"], "*nods*\nstill nodding"],
    ]);
  });

  test("a casual reply with no tags is one bubble for the first character in the cast", () => {
    const messages = replyToMessages(channel({ mode: "casual" }), "Door's open.", "m", [...ilse, { name: "Tamsin Hale" }]);
    expect(messages.map((m) => m.characters)).toEqual([["Ilse Marrow"]]);
  });

  test("a casual reply can switch between cast members by first name", () => {
    const messages = replyToMessages(channel({ mode: "casual" }), "Ilse: Hm.\nTamsin: Ha!", "m", [...ilse, { name: "Tamsin Hale" }]);
    expect(messages.map((m) => m.characters)).toEqual([["Ilse Marrow"], ["Tamsin Hale"]]);
  });

  test("an OOC reply voices no one", () => {
    expect(replyToMessages(channel({ kind: "ooc" }), "hey!", "m", ilse)[0]).toMatchObject({
      characters: [],
      mode: null,
    });
  });
});
