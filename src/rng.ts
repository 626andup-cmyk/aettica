/**
 * RNG partner creation: "Surprise me" in Settings writes a new partner for
 * you, from a few random ingredients, so it's someone you wouldn't have
 * thought of.
 *
 * Asking a model for "a random character" gets the same few every time, so
 * the randomness comes from here: a temperament, a way of talking, two
 * interests, a quirk, and what they love in a story, each picked at random
 * from lists below (`rollSeeds`). The model (the profile that writes OOC)
 * turns them into a name and a "who your partner is" prompt, written the way
 * the default one is. Nothing is saved until you press Save in Settings;
 * roll again as often as you like.
 */

import { extractJson } from "./json.ts";
import { createChatCompletion, type ApiOptions } from "./nanogpt.ts";
import type { Profile } from "./types.ts";
import { profileRequest } from "./partner.ts";

const TEMPERAMENTS = [
  "warm and teasing", "dry and deadpan", "earnest and a little shy", "chaotic and enthusiastic", "calm and thoughtful",
  "sardonic but soft underneath", "gentle and dreamy", "blunt and loyal", "playful and dramatic", "quietly intense",
  "sunny and easily excited", "wry and observant", "cozy and nurturing", "restless and curious",
];
const VOICES = [
  "texts in lowercase with lots of ellipses", "uses exclamation points freely", "writes in short, punchy lines",
  "rambles happily when excited", "loves a well-placed emoji", "is precise and a bit formal", "swears affectionately",
  "asks a lot of questions", "makes terrible puns", "quotes old films", "types fast and fixes typos with *",
];
const INTERESTS = [
  "old maps", "horror movies", "baking bread", "astronomy", "folk music", "urban legends", "tabletop RPGs", "gardening",
  "true crime podcasts", "mythology", "thrifting", "birdwatching", "anime", "Victorian novels", "street photography",
  "cryptids", "fencing", "tarot", "architecture", "video game lore", "tea", "sailing", "fashion history", "linguistics",
];
const QUIRKS = [
  "names every houseplant", "can't resist a cliffhanger", "keeps a notebook of overheard lines", "is terrible with directions",
  "has strong opinions about fonts", "collects weird facts", "always roots for the villain", "cries at happy endings",
  "stays up far too late writing", "hums while thinking", "is secretly very competitive",
];
const STORY_LOVES = [
  "slow-burn romance", "found family", "political intrigue", "cozy mysteries", "cosmic horror", "heists", "court drama",
  "enemies to lovers", "survival stories", "fairy tales retold", "morally grey heroes", "small-town secrets", "space opera",
  "gothic atmosphere", "quiet slice of life", "high-stakes adventure",
];

export interface PartnerSeeds {
  temperament: string;
  voice: string;
  interests: string[];
  quirk: string;
  loves: string[];
}

/** Pick a few ingredients at random. */
export function rollSeeds(random: () => number = Math.random): PartnerSeeds {
  const pick = <T>(list: T[]) => list[Math.floor(random() * list.length)]!;
  const pickTwo = <T>(list: T[]): T[] => {
    const first = pick(list);
    let second = pick(list);
    for (let i = 0; second === first && i < 10; i++) second = pick(list);
    return second === first ? [first] : [first, second];
  };
  return { temperament: pick(TEMPERAMENTS), voice: pick(VOICES), interests: pickTwo(INTERESTS), quirk: pick(QUIRKS), loves: pickTwo(STORY_LOVES) };
}

/** The seeds in words, as shown in Settings. */
export function describeSeeds(seeds: PartnerSeeds): string {
  return `${seeds.temperament}; ${seeds.voice}; into ${seeds.interests.join(" and ")}; ${seeds.quirk}; loves ${seeds.loves.join(" and ")}`;
}

/** Ask the model to turn the seeds into a partner: a name, and who they are. */
export async function randomPartner(api: ApiOptions, profile: Profile, seeds: PartnerSeeds): Promise<{ name: string; prompt: string }> {
  const request = profileRequest(profile);
  const response = await createChatCompletion(api, {
    ...request,
    temperature: Math.max(request.temperature, 0.9),
    maxTokens: Math.max(request.maxTokens, 700),
    messages: [
      {
        role: "system",
        content: [
          "Invent a creative writing partner: a person who roleplays and writes stories with the user, and chats with them as a friend.",
          "Use these ingredients, and make them into one believable person (not a list):",
          `- Temperament: ${seeds.temperament}`,
          `- How they talk: ${seeds.voice}`,
          `- Into: ${seeds.interests.join(", ")}`,
          `- Quirk: ${seeds.quirk}`,
          `- Loves writing: ${seeds.loves.join(", ")}`,
          'Reply with JSON only: {"name": "a first name", "prompt": "..."}. The prompt describes them in the second person ("You are ..."), in 80 to 150 words: who they are, how they talk, their taste as a writer, and what they\'re like as a friend.',
        ].join("\n"),
      },
      { role: "user", content: "Surprise me." },
    ],
  });
  const json = extractJson(response.content) as { name?: unknown; prompt?: unknown };
  const name = typeof json?.name === "string" ? json.name.trim().slice(0, 40) : "";
  const prompt = typeof json?.prompt === "string" ? json.prompt.trim().slice(0, 4000) : "";
  if (!name || !prompt) throw new Error("The model's answer didn't have a name and a description. Try again.");
  return { name, prompt };
}
