/**
 * Tests for channel categories: the store, moving channels between them
 * (a drag in the sidebar), your partner's tools, the prompt, and the API.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promptForChannel } from "../src/partner.ts";
import { createApp, type App } from "../src/server.ts";
import { runTool } from "../src/tools.ts";
import type { Channel } from "../src/types.ts";
import { startFakeNanoGpt, tempDir, testConfig, type FakeNanoGpt } from "./helpers.ts";

let fake: FakeNanoGpt;
let dir: ReturnType<typeof tempDir>;
let app: App;
let story: Channel;
let ooc: Channel;

beforeEach(() => {
  fake = startFakeNanoGpt();
  dir = tempDir();
  app = createApp(testConfig(dir.path, fake.baseUrl));
  [story, ooc] = app.store.listChannels() as [Channel, Channel];
});

afterEach(() => {
  app.summarizer.stop();
  app.store.close();
  fake.stop();
  dir.cleanup();
});

async function call(method: string, path: string, body?: unknown) {
  const response = await app.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  return { status: response.status, data: (await response.json()) as any };
}

describe("categories", () => {
  test("made at the bottom, renamed, folded, reordered", () => {
    const a = app.store.createCategory({ name: " Fantasy " });
    const b = app.store.createCategory({ name: "Sci-fi" });
    expect(app.store.listCategories().map((c) => [c.name, c.position])).toEqual([
      ["Fantasy", 0],
      ["Sci-fi", 1],
    ]);
    expect(app.store.updateCategory(a.id, { collapsed: true })).toMatchObject({ name: "Fantasy", collapsed: true });
    expect(app.store.updateCategory(a.id, { name: "High fantasy" })).toMatchObject({ name: "High fantasy", collapsed: true });
    expect(app.store.reorderCategories([b.id, a.id]).map((c) => c.name)).toEqual(["Sci-fi", "High fantasy"]);
    expect(() => app.store.reorderCategories([b.id])).toThrow();
    expect(() => app.store.createCategory({ name: "" })).toThrow();
  });

  test("channels go in and out; deleting a category keeps its channels", () => {
    const fantasy = app.store.createCategory({ name: "Fantasy" });
    const dragons = app.store.createChannel({ name: "dragons", kind: "rp", categoryId: fantasy.id });
    expect(dragons.categoryId).toBe(fantasy.id);
    app.store.updateChannel(story.id, { categoryId: fantasy.id });
    expect(app.store.getChannel(story.id).categoryId).toBe(fantasy.id);
    app.store.deleteCategory(fantasy.id);
    expect(app.store.getChannel(dragons.id).categoryId).toBeNull();
    expect(app.store.getChannel(story.id).categoryId).toBeNull();
    expect(() => app.store.updateChannel(story.id, { categoryId: "nope" })).toThrow();
  });

  test("a drag: the new order and a category, all at once", () => {
    const fantasy = app.store.createCategory({ name: "Fantasy" });
    const channels = app.store.reorderChannels([ooc.id, story.id], { [story.id]: fantasy.id });
    expect(channels.map((c) => [c.name, c.categoryId])).toEqual([
      ["ooc", null],
      ["story", fantasy.id],
    ]);
    expect(() => app.store.reorderChannels([ooc.id, story.id], { [story.id]: "nope" })).toThrow();
    // Nothing changed by the failed one.
    expect(app.store.getChannel(story.id).categoryId).toBe(fantasy.id);
  });
});

describe("your partner", () => {
  const ctx = () => ({ store: app.store, channel: ooc, mode: "post" as const });

  test("makes a channel in a category (making the category if needed)", () => {
    const result = runTool(ctx(), "create_channel", { name: "heist", kind: "roleplay", category: "Crime" });
    expect(result.ok).toBe(true);
    const crime = app.store.listCategories().find((c) => c.name === "Crime")!;
    expect(app.store.listChannels().find((c) => c.name === "heist")!.categoryId).toBe(crime.id);
    // The same name (any case) is the same category.
    runTool(ctx(), "create_channel", { name: "noir", kind: "roleplay", category: "crime" });
    expect(app.store.listCategories()).toHaveLength(1);
  });

  test("moves a channel into a category, out of it, and along", () => {
    const into = runTool(ctx(), "move_channel", { channel: "#story", category: "Fantasy" });
    expect(into.summary).toBe("moved #story into Fantasy");
    const out = runTool(ctx(), "move_channel", { channel: "#story", category: "none", position: 2 });
    expect(out.summary).toBe("moved #story out of its category and to place 2");
    expect(app.store.getChannel(story.id).categoryId).toBeNull();
    expect(runTool(ctx(), "move_channel", { channel: "#story" }).ok).toBe(false);
  });

  test("sees categories in the OOC channel list", () => {
    runTool(ctx(), "move_channel", { channel: "#story", category: "Fantasy" });
    expect(promptForChannel(app.store, ooc.id)[0]!.content).toContain("- #story (in Fantasy): roleplay");
  });
});

describe("the API", () => {
  test("make, list in state, rename, fold, reorder, delete", async () => {
    const a = (await call("POST", "/api/categories", { name: "Fantasy" })).data.category;
    const b = (await call("POST", "/api/categories", { name: "Sci-fi" })).data.category;
    expect((await call("GET", "/api/state")).data.categories.map((c: any) => c.name)).toEqual(["Fantasy", "Sci-fi"]);
    expect((await call("PATCH", `/api/categories/${a.id}`, { collapsed: true })).data.category.collapsed).toBe(true);
    expect((await call("PUT", "/api/categories/order", { ids: [b.id, a.id] })).data.categories[0].name).toBe("Sci-fi");
    const made = (await call("POST", "/api/channels", { name: "mars", kind: "rp", categoryId: b.id })).data.channel;
    expect(made.categoryId).toBe(b.id);
    const moved = await call("PUT", "/api/channels/order", { ids: [made.id, story.id, ooc.id], categories: { [story.id]: a.id } });
    expect(moved.data.channels.map((c: any) => c.categoryId)).toEqual([b.id, a.id, null]);
    expect((await call("PATCH", `/api/channels/${ooc.id}`, { categoryId: a.id })).data.channel.categoryId).toBe(a.id);
    const deleted = await call("DELETE", `/api/categories/${a.id}`, {});
    expect(deleted.data.channels.find((c: any) => c.id === story.id).categoryId).toBeNull();
  });

  test("bad input", async () => {
    expect((await call("POST", "/api/categories", { name: "" })).status).toBe(400);
    expect((await call("PATCH", "/api/categories/nope", { name: "x" })).status).toBe(404);
    expect((await call("PUT", "/api/channels/order", { ids: [story.id, ooc.id], categories: [] })).status).toBe(400);
    expect((await call("POST", "/api/channels", { name: "x", kind: "rp", categoryId: "nope" })).status).toBe(404);
  });
});
