/**
 * Tests for themes (src/themes.ts): rewriting and scoping theme CSS, and the
 * theme library (listing, copying, editing, files, serving).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NotFoundError, ValidationError } from "../src/store.ts";
import {
  extractRootTokens,
  parseThemeOptions,
  rewriteUrls,
  scopeOutsideChannel,
  scopeToChannel,
  ThemeLibrary,
  topLevelStatements,
} from "../src/themes.ts";
import { tempDir } from "./helpers.ts";

const ROOT = join(import.meta.dir, "..");
const BASE_CSS = readFileSync(join(ROOT, "public", "style.css"), "utf8");

describe("rewriteUrls", () => {
  test("points relative urls at the theme's folder", () => {
    expect(rewriteUrls("a { b: url(sky.svg) } c { d: url('./wood.jpg') } e { f: url( \"x y.png\" ) }", "aero")).toBe(
      'a { b: url("/themes/aero/sky.svg") } c { d: url("/themes/aero/wood.jpg") } e { f: url( "x y.png" ) }',
    );
  });

  test("leaves absolute urls, data: URIs, site paths and fragments alone", () => {
    const css = 'a { b: url(https://x.com/a.png); c: url("data:image/png;base64,AAAA"); d: url(/icon.svg); e: url(#f) }';
    expect(rewriteUrls(css, "aero")).toBe(css);
  });
});

describe("topLevelStatements", () => {
  test("splits rules and at-rules, ignoring braces in strings and comments", () => {
    const css = `@import "a.css";\n.a { content: "}"; }\n/* { */ @media x { .b { c: d } }\n.e{}`;
    expect(topLevelStatements(css).map((s) => s.trim())).toEqual([
      '@import "a.css";',
      '.a { content: "}"; }',
      "/* { */ @media x { .b { c: d } }",
      ".e{}",
    ]);
  });
});

describe("scopeToChannel", () => {
  const scoped = scopeToChannel(
    `:root { --text: navy; }
html.dark .message, .sidebar > body { color: red; }
@media (max-width: 600px) { :root { --x: 1; } .a { b: c; } }
@font-face { font-family: Aero; src: url(a.woff2); }
@keyframes glow { from { opacity: 0 } to { opacity: 1 } }
.x::before { content: ":root html body"; }
.bodyish, .my-html { a: b; }`,
    "--base: 1;",
  );

  test("wraps rules in @scope (.channel-view), after resetting tokens and setting colour, font and background", () => {
    const start = scoped.indexOf("@scope (.channel-view) {");
    expect(start).toBeGreaterThan(-1);
    const inside = scoped.slice(start);
    expect(inside).toContain(":scope { --base: 1; }");
    expect(inside).toContain(":scope { color: var(--text);");
    expect(inside).toContain(":scope { background: var(--app-background); }");
    expect(inside).toContain(":scope > .messages { background: var(--channel-background); }");
    // The reset comes before the theme's own rules, so they win.
    expect(inside.indexOf("--base: 1")).toBeLessThan(inside.indexOf("--text: navy"));
  });

  test("turns :root, html and body into :scope, in selectors only", () => {
    expect(scoped).toContain(":scope { --text: navy; }");
    expect(scoped).toContain(":scope.dark .message, .sidebar > :scope { color: red; }");
    expect(scoped).toContain("@media (max-width: 600px) { :scope { --x: 1; } .a { b: c; } }");
    expect(scoped).toContain('content: ":root html body"');
    expect(scoped).toContain(".bodyish, .my-html { a: b; }");
  });

  test("keeps fonts and keyframes outside @scope, where they must be", () => {
    const scopeStart = scoped.indexOf("@scope");
    expect(scoped.indexOf("@font-face")).toBeLessThan(scopeStart);
    expect(scoped.indexOf("@keyframes glow")).toBeLessThan(scopeStart);
  });
});

describe("scopeOutsideChannel", () => {
  test("applies the theme everywhere but the channel view, with no reset", () => {
    const outside = scopeOutsideChannel(":root { --text: navy; } .channel-header { margin: 8px; } @font-face { font-family: X; }");
    expect(outside.indexOf("@font-face")).toBeLessThan(outside.indexOf("@scope"));
    expect(outside).toContain("@scope (:root) to (.channel-view) {");
    expect(outside).toContain(":scope { --text: navy; }");
    expect(outside).toContain(".channel-header { margin: 8px; }");
    expect(outside).not.toContain("--accent");
  });
});

describe("extractRootTokens", () => {
  test("finds every token in the base stylesheet", () => {
    const tokens = extractRootTokens(BASE_CSS);
    expect(tokens).toContain("--accent:");
    expect(tokens).toContain("--app-background:");
    expect(tokens).toContain("--drawer-bg:");
  });
});

describe("ThemeLibrary", () => {
  let dir: ReturnType<typeof tempDir>;
  let library: ThemeLibrary;

  beforeEach(() => {
    dir = tempDir();
    library = new ThemeLibrary(join(ROOT, "themes"), join(dir.path, "themes"), BASE_CSS);
  });
  afterEach(() => dir.cleanup());

  test("lists Classic first, then the other built-ins, then yours", () => {
    library.create("Zebra");
    library.create("Apple");
    const themes = library.list();
    expect(themes.map((t) => t.id)).toEqual([
      "classic",
      "aero-glass",
      "frutiger-aero",
      "liquid-glass",
      "rainy-window",
      "apple",
      "zebra",
    ]);
    expect(themes[1]).toMatchObject({ name: "Aero Glass", builtIn: true, hasLite: true });
    expect(themes.at(-1)).toMatchObject({ name: "Zebra", builtIn: false });
  });

  test("a copy of Classic starts from every token", () => {
    const theme = library.create("  My Theme!  ");
    expect(theme).toMatchObject({ id: "my-theme", name: "My Theme!", builtIn: false });
    expect(library.details(theme.id).css).toContain("--accent: #8b7cf6;");
  });

  test("a copy of another theme keeps its CSS, Lite version and images", () => {
    const theme = library.create("Sky", "frutiger-aero");
    const details = library.details(theme.id);
    expect(details.css).toContain("url(sky.svg)");
    expect(details.liteCss).toContain("--sidebar-backdrop: none");
    expect(details.files).toEqual(["sky.svg"]);
    expect(details.description).toBe("Based on Frutiger Aero.");
  });

  test("names are made into unique ids", () => {
    expect(library.create("Sky").id).toBe("sky");
    expect(library.create("Sky").id).toBe("sky-2");
    expect(library.create("Classic").id).toBe("classic-2");
  });

  test("your themes can be edited and deleted", () => {
    const { id } = library.create("Sky");
    const updated = library.update(id, { name: "Night", css: ":root { --text: white; }", liteCss: "a{}" });
    expect(updated).toMatchObject({ name: "Night", css: ":root { --text: white; }", hasLite: true });
    expect(library.update(id, { liteCss: "  " }).hasLite).toBe(false);

    library.remove(id);
    expect(library.exists(id)).toBe(false);
    expect(() => library.details(id)).toThrow(NotFoundError);
  });

  test("Rainy Window offers sliders, and a copy keeps them", () => {
    expect(library.info("rainy-window").options.map((o) => [o.id, o.variable])).toEqual([
      ["bubble-transparency", "--bubble-transparency"],
      ["bubble-blur", "--bubble-blur"],
      ["rain", "--rain"],
      ["parallax", "--parallax"],
    ]);
    const copy = library.create("My Rain", "rainy-window");
    expect(library.info(copy.id).options).toHaveLength(4);
    expect(library.details(copy.id).files).toEqual([
      "city-drops.svg",
      "city.svg",
      "drops-mask.svg",
      "drops-small-mask.svg",
      "drops-small.svg",
      "drops.svg",
      "rain.svg",
      "runners.svg",
    ]);
  });

  test("your themes' sliders can be changed in the editor", () => {
    const { id } = library.create("Sky");
    const option = { id: "blur", label: "Blur", variable: "--my-blur", min: 0, max: 30, step: 1, default: 12, unit: "px" };
    expect(library.update(id, { options: [option] }).options).toEqual([option]);
    expect(() => library.update(id, { options: [{ ...option, variable: "blur" }] })).toThrow(/CSS variable/);
    expect(library.update(id, { options: [] }).options).toEqual([]);
  });

  test("built-in themes can't be changed or deleted", () => {
    expect(() => library.update("frutiger-aero", { css: "" })).toThrow(ValidationError);
    expect(() => library.remove("classic")).toThrow(ValidationError);
    expect(() => library.addFile("classic", "a.png", new Uint8Array(1))).toThrow(ValidationError);
  });

  test("files: only images and fonts with simple names, never the theme's own files", () => {
    const { id } = library.create("Sky");
    expect(library.addFile(id, "wood.jpg", new Uint8Array([1, 2, 3]))).toEqual(["wood.jpg"]);
    for (const bad of ["theme.css", "theme.json", "../escape.png", ".hidden.png", "notes.txt", "style.css"]) {
      expect(() => library.addFile(id, bad, new Uint8Array(1))).toThrow(ValidationError);
    }
    expect(() => library.addFile(id, "huge.png", new Uint8Array(9 * 1024 * 1024))).toThrow(/8 MB/);
    expect(library.removeFile(id, "wood.jpg")).toEqual([]);
    expect(() => library.removeFile(id, "wood.jpg")).toThrow(NotFoundError);
  });

  test("invalid input is refused", () => {
    expect(() => library.create("")).toThrow(ValidationError);
    expect(() => library.create("x".repeat(61))).toThrow(ValidationError);
    expect(() => library.create("Sky", "nope")).toThrow(NotFoundError);
    const { id } = library.create("Sky");
    expect(() => library.update(id, { css: 42 })).toThrow(ValidationError);
  });

  describe("serving", () => {
    test("theme.css with rewritten urls", async () => {
      const response = library.serve("frutiger-aero", "theme.css")!;
      expect(response.headers.get("Content-Type")).toContain("text/css");
      expect(await response.text()).toContain('url("/themes/frutiger-aero/sky.svg")');
    });

    test("channel.css, scoped to the channel view", async () => {
      const text = await library.serve("aero-glass", "channel.css")!.text();
      expect(text).toContain("@scope (.channel-view)");
      expect(text).toContain("--accent: #3fb3ff;");
      expect(text).toContain("--accent: #8b7cf6;"); // the reset to defaults comes first
    });

    test("channel-lite.css, scoped but without the reset, so it builds on channel.css", async () => {
      const text = await library.serve("aero-glass", "channel-lite.css")!.text();
      expect(text).toContain("@scope (.channel-view)");
      expect(text).toContain("--sidebar-backdrop: none");
      expect(text).not.toContain("--accent: #8b7cf6;");
    });

    test("outside.css, for the app theme while a channel has its own", async () => {
      const text = await library.serve("liquid-glass", "outside.css")!.text();
      expect(text).toContain("@scope (:root) to (.channel-view)");
      expect(text).toContain('url("/themes/liquid-glass/blobs.svg")');
    });

    test("images, with safe headers", () => {
      const response = library.serve("frutiger-aero", "sky.svg")!;
      expect(response.headers.get("Content-Type")).toBe("image/svg+xml");
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(response.headers.get("Content-Security-Policy")).toBe("script-src 'none'");
    });

    test("nothing else", () => {
      expect(library.serve("frutiger-aero", "theme.json")).toBeNull();
      expect(library.serve("classic", "theme-lite.css")).toBeNull();
      expect(library.serve("nope", "theme.css")).toBeNull();
      expect(library.serve("frutiger-aero", "..")).toBeNull();
      expect(library.serve("../themes", "theme.css")).toBeNull();
    });
  });

  test("your themes live in the data folder", () => {
    const { id } = library.create("Sky");
    expect(existsSync(join(dir.path, "themes", id, "theme.css"))).toBe(true);
  });
});

describe("parseThemeOptions", () => {
  const good = { id: "glow", label: "Glow", variable: "--glow", min: 0, max: 1, default: 0.5 };

  test("fills in the step and unit", () => {
    expect(parseThemeOptions([good], true)).toEqual([{ ...good, step: 1, unit: "" }]);
  });

  test.each([
    [{ ...good, id: "Glow!" }, /id must be/],
    [{ ...good, variable: "glow" }, /CSS variable/],
    [{ ...good, min: 2 }, /min must be less than max/],
    [{ ...good, default: 5 }, /default must be between/],
    [{ ...good, unit: "vw" }, /unit must be/],
    [{ ...good, step: 0 }, /step must be a positive/],
  ])("refuses %j when saving", (option, error) => {
    expect(() => parseThemeOptions([option], true)).toThrow(error);
  });

  test("skips bad options in theme.json instead of failing", () => {
    expect(parseThemeOptions([good, { ...good, id: "x", min: 5 }], false).map((o) => o.id)).toEqual(["glow"]);
    expect(parseThemeOptions("nope", false)).toEqual([]);
  });

  test("ids must be unique", () => {
    expect(() => parseThemeOptions([good, good], true)).toThrow(/its own id/);
  });
});
