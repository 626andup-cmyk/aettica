/**
 * Themes: how Aettica looks, and how that's stored, served and scoped.
 *
 * A theme is a folder (see "Themes" in DESIGN.md):
 *
 *   themes/<id>/                 built-in themes, shipped with Aettica
 *   data/themes/<id>/            your themes
 *     theme.json                 name, description, preview colours
 *     theme.css                  the theme itself
 *     theme-lite.css             optional: the cheap "fake glass" version,
 *                                loaded on top of theme.css in Lite mode
 *     sky.svg, wood.jpg, ...     optional images and fonts it uses
 *
 * A theme is plain CSS, loaded after the base stylesheet (public/style.css).
 * Mostly it redefines the variables ("tokens") listed in
 * docs/theme-reference.md, but it can restyle anything.
 *
 * Themes are used in two ways:
 *
 *   - As the **app theme**, a theme's CSS applies to the whole page as is.
 *   - As a **channel theme**, it must only affect that channel: its messages,
 *     header, composer and background, never the sidebar or dialogs. So the
 *     server rewrites it into a scoped version (`scopeToChannel`) wrapped in
 *     `@scope (.channel-view) { ... }`, a CSS feature that limits rules to
 *     one part of the page.
 *
 * Built-in themes can't be edited or deleted, but can be copied into a theme
 * of your own, which can.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, cpSync } from "node:fs";
import { extname, join } from "node:path";
import { NotFoundError, ValidationError } from "./store.ts";

// ------------------------------------------------------------------ types

/** What the theme picker needs to know about a theme. */
export interface ThemeInfo {
  /** Folder name, e.g. "frutiger-aero". Lowercase letters, digits and dashes. */
  id: string;
  name: string;
  description: string;
  /** Shipped with Aettica: can be copied, but not edited or deleted. */
  builtIn: boolean;
  /** Has a `theme-lite.css` for Lite mode. */
  hasLite: boolean;
  /** A few CSS colours or gradients for the theme's preview swatch. */
  swatch: string[];
}

/** Everything the theme editor needs. */
export interface ThemeDetails extends ThemeInfo {
  css: string;
  liteCss: string;
  /** Images and fonts in the theme's folder. */
  files: string[];
}

/** The id of the default theme, which is simply the base stylesheet. */
export const DEFAULT_THEME = "classic";

// --------------------------------------------------------------- limits

const THEME_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
/** A file name inside a theme: no folders, no hidden files. */
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
/** Files that belong to the theme itself, and can't be uploaded over. */
const RESERVED_FILES = new Set(["theme.json", "theme.css", "theme-lite.css"]);
const MAX_CSS_LENGTH = 200_000;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 50;

/** The file types a theme may contain, and how each is served. */
const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
};

/**
 * Headers for everything served from a theme. `nosniff` stops the browser
 * from guessing a different file type, and the Content-Security-Policy
 * stops an SVG from running scripts if it's ever opened on its own.
 */
const THEME_HEADERS = {
  "Cache-Control": "no-cache",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "script-src 'none'",
};

// -------------------------------------------------------- CSS rewriting

/**
 * Make relative `url(...)`s in a theme's CSS point at the theme's folder:
 * `url(sky.svg)` becomes `url("/themes/<id>/sky.svg")`.
 *
 * Browsers resolve a relative URL against the stylesheet it's in, *except*
 * inside CSS variables, where it can end up relative to wherever the
 * variable is used. Making them absolute removes that trap, so themes can
 * safely write `--app-background: url(sky.svg) center / cover`.
 */
export function rewriteUrls(css: string, themeId: string): string {
  return css.replace(/url\(\s*(['"]?)([^'")\s]+)\1\s*\)/g, (whole, _quote, target: string) => {
    // Leave absolute URLs, site paths, data: URIs and #fragments alone.
    if (/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(target)) return whole;
    return `url("/themes/${themeId}/${target.replace(/^\.\//, "")}")`;
  });
}

/**
 * Walk through CSS text, calling `onPrelude` for each rule's prelude (the
 * part before a `{`: a selector like `.message, .sidebar`, or an at-rule
 * like `@media (max-width: 600px)`), and replacing it with what it returns.
 * Strings and comments are skipped, so a `{` inside them isn't mistaken for
 * the start of a block.
 *
 * @param onPrelude  Receives the prelude and the nesting depth it's at.
 */
function mapPreludes(css: string, onPrelude: (prelude: string, depth: number) => string): string {
  let out = "";
  let start = 0; // where the current prelude began
  let depth = 0;
  let i = 0;
  while (i < css.length) {
    const char = css[i]!;
    if (char === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      i = end === -1 ? css.length : end + 2;
    } else if (char === '"' || char === "'") {
      i++;
      while (i < css.length && css[i] !== char) i += css[i] === "\\" ? 2 : 1;
      i++;
    } else if (char === "{") {
      out += onPrelude(css.slice(start, i), depth) + "{";
      depth++;
      start = ++i;
    } else if (char === "}" || char === ";") {
      out += css.slice(start, i + 1);
      if (char === "}") depth = Math.max(0, depth - 1);
      start = ++i;
    } else {
      i++;
    }
  }
  return out + css.slice(start);
}

/**
 * Split CSS into its top-level statements (rules and at-rules), keeping
 * everything, including comments and whitespace, attached to the statement
 * that follows it.
 */
export function topLevelStatements(css: string): string[] {
  const statements: string[] = [];
  // Track depth, and cut after each `}` or `;` that ends a top-level
  // statement. Strings and comments are skipped as in `mapPreludes`.
  let depth = 0;
  let i = 0;
  let start = 0;
  while (i < css.length) {
    const char = css[i]!;
    if (char === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      i = end === -1 ? css.length : end + 2;
      continue;
    }
    if (char === '"' || char === "'") {
      i++;
      while (i < css.length && css[i] !== char) i += css[i] === "\\" ? 2 : 1;
      i++;
      continue;
    }
    if (char === "{") depth++;
    if (char === "}") depth = Math.max(0, depth - 1);
    i++;
    if ((char === "}" || char === ";") && depth === 0) {
      statements.push(css.slice(start, i));
      start = i;
    }
  }
  if (css.slice(start).trim() !== "") statements.push(css.slice(start));
  return statements;
}

/**
 * At-rules that must stay at the top level of a stylesheet, outside
 * `@scope`: font and animation definitions and imports. They don't style
 * anything by themselves, so leaving them unscoped is harmless.
 */
const HOISTED_AT_RULES = /^\s*(?:\/\*[\s\S]*?\*\/\s*)*@(?:charset|import|font-face|keyframes|-webkit-keyframes|property|counter-style|font-feature-values)\b/i;

/**
 * Wrap a stylesheet in an `@scope` rule, so it only styles part of the page.
 *
 * 1. Font, animation and import rules are moved out to the top level,
 *    because they aren't allowed inside `@scope`. They don't style anything
 *    by themselves, so leaving them unscoped is harmless.
 * 2. Everything else goes inside the `@scope` rule (`scopePrelude`).
 * 3. `:root`, `html` and `body` in selectors become `:scope`, the root of
 *    the scope. That's where a theme's tokens (`:root { --x: ... }`) need to
 *    go to take effect there.
 * 4. `firstRules` go at the start of the scope, before the theme's own
 *    rules, so the theme can still override them.
 */
function scopeCss(css: string, scopePrelude: string, firstRules: string[]): string {
  const hoisted: string[] = [];
  const scoped: string[] = [];
  for (const statement of topLevelStatements(css)) {
    (HOISTED_AT_RULES.test(statement) ? hoisted : scoped).push(statement);
  }

  const body = mapPreludes(scoped.join(""), (prelude) =>
    prelude.trimStart().startsWith("@")
      ? prelude
      : prelude.replace(/(^|[\s,>+~(])(?::root|html|body)(?![\w-])/g, "$1:scope"),
  );

  return [...hoisted.map((s) => s.trim()), `${scopePrelude} {`, ...firstRules, body, "}"].join("\n");
}

/**
 * Turn a theme into a channel theme: the same CSS, limited to the channel
 * view with `@scope (.channel-view)`. A rule like `.message { ... }` then only
 * matches messages inside the channel, and `.sidebar { ... }` matches nothing.
 *
 * With `baseTokens` (the full theme, not its Lite version), the scope also
 * starts by:
 *
 *   - setting every token back to its default, so tokens the theme doesn't
 *     set come from the defaults, not from whatever the app theme happens
 *     to be. A channel theme looks the same whatever the app theme is.
 *   - setting the channel's text colour and font from the theme's tokens.
 *     (The page sets these on <body> from the app theme's tokens, and the
 *     channel would otherwise inherit the finished colour.)
 *   - giving the channel view the theme's wallpaper (`--app-background`),
 *     with the theme's `--channel-background` tint behind the messages, so
 *     the channel looks like a small window of the whole theme.
 *
 * A Lite version passes `null`: it's loaded on top of the full theme, and
 * resetting would undo it.
 */
export function scopeToChannel(css: string, baseTokens: string | null): string {
  const firstRules =
    baseTokens === null
      ? []
      : [
          `:scope { ${baseTokens} }`,
          ":scope { color: var(--text); font: var(--font-size) / var(--line-height) var(--font-body); }",
          ":scope { background: var(--app-background); }",
          ":scope > .messages { background: var(--channel-background); }",
        ];
  return scopeCss(css, "@scope (.channel-view)", firstRules);
}

/**
 * The app theme, for when the open channel has a theme of its own: the same
 * CSS, applied everywhere *except* inside the channel view. This is a
 * "donut scope": `@scope (:root) to (.channel-view)` starts at the top of
 * the page and stops at the channel view. So the channel theme fully
 * replaces the app theme inside its channel, including any layout changes
 * the app theme makes.
 */
export function scopeOutsideChannel(css: string): string {
  return scopeCss(css, "@scope (:root) to (.channel-view)", []);
}

/**
 * The declarations inside the base stylesheet's first `:root { ... }`
 * block: every token with its default value. Used to reset tokens in
 * channel themes, and as the starting point for a new theme.
 */
export function extractRootTokens(baseCss: string): string {
  const match = baseCss.match(/:root\s*\{([\s\S]*?)\n\}/);
  if (!match) throw new Error("The base stylesheet has no :root block.");
  return match[1]!.trim();
}

// ---------------------------------------------------------------- library

interface Manifest {
  name?: unknown;
  description?: unknown;
  swatch?: unknown;
}

/** Reads, writes and serves themes from the built-in and your theme folders. */
export class ThemeLibrary {
  /** The base stylesheet's tokens (see `extractRootTokens`). */
  private readonly baseTokens: string;

  /**
   * @param builtInDir  Folder of built-in themes (`themes/`).
   * @param userDir     Folder of your themes (`data/themes/`). Created if needed.
   * @param baseCss     The base stylesheet, public/style.css.
   */
  constructor(
    private readonly builtInDir: string,
    private readonly userDir: string,
    baseCss: string,
  ) {
    mkdirSync(userDir, { recursive: true });
    this.baseTokens = extractRootTokens(baseCss);
  }

  // ------------------------------------------------------------ reading

  /** Every theme: Classic first, then the other built-ins, then yours, by name. */
  list(): ThemeInfo[] {
    const builtIn = this.idsIn(this.builtInDir).map((id) => this.info(id));
    const yours = this.idsIn(this.userDir)
      .filter((id) => !this.isBuiltIn(id))
      .map((id) => this.info(id))
      .sort((a, b) => a.name.localeCompare(b.name));
    builtIn.sort((a, b) => (a.id === DEFAULT_THEME ? -1 : b.id === DEFAULT_THEME ? 1 : a.name.localeCompare(b.name)));
    return [...builtIn, ...yours];
  }

  /** Whether a theme with this id exists. */
  exists(id: string): boolean {
    return THEME_ID.test(id) && existsSync(join(this.folder(id), "theme.css"));
  }

  /** One theme's picker details. Throws `NotFoundError` if it doesn't exist. */
  info(id: string): ThemeInfo {
    const folder = this.requireFolder(id);
    const manifest = this.readManifest(folder);
    return {
      id,
      name: typeof manifest.name === "string" && manifest.name.trim() ? manifest.name.trim() : id,
      description: typeof manifest.description === "string" ? manifest.description : "",
      builtIn: this.isBuiltIn(id),
      hasLite: existsSync(join(folder, "theme-lite.css")),
      swatch: Array.isArray(manifest.swatch) ? manifest.swatch.filter((s) => typeof s === "string").slice(0, 4) : [],
    };
  }

  /** Everything about a theme, for the editor. */
  details(id: string): ThemeDetails {
    const folder = this.requireFolder(id);
    return {
      ...this.info(id),
      css: readFileSync(join(folder, "theme.css"), "utf8"),
      liteCss: existsSync(join(folder, "theme-lite.css")) ? readFileSync(join(folder, "theme-lite.css"), "utf8") : "",
      files: this.assetNames(folder),
    };
  }

  // ------------------------------------------------------------ writing

  /**
   * Make a new theme of your own, as a copy of another (with its images).
   * Copying Classic starts from the full list of tokens with their default
   * values, ready to change.
   *
   * @returns The new theme. Its id is made from the name, made unique.
   */
  create(name: string, fromId: string = DEFAULT_THEME): ThemeInfo {
    const cleanName = validateName(name);
    const source = this.requireFolder(fromId);
    const id = this.uniqueId(cleanName);
    const folder = join(this.userDir, id);

    cpSync(source, folder, { recursive: true });
    if (fromId === DEFAULT_THEME) writeFileSync(join(folder, "theme.css"), this.template());
    const manifest = this.readManifest(folder);
    writeFileSync(
      join(folder, "theme.json"),
      JSON.stringify({ ...manifest, name: cleanName, description: `Based on ${this.info(fromId).name}.` }, null, 2),
    );
    return this.info(id);
  }

  /** Change one of your themes. Built-in themes can't be changed. */
  update(id: string, changes: { name?: unknown; description?: unknown; css?: unknown; liteCss?: unknown }): ThemeDetails {
    const folder = this.requireEditable(id);
    const manifest = this.readManifest(folder);
    if (changes.name !== undefined) manifest.name = validateName(changes.name);
    if (changes.description !== undefined) {
      if (typeof changes.description !== "string" || changes.description.length > 500) {
        throw new ValidationError("description must be text of 500 characters at most");
      }
      manifest.description = changes.description;
    }
    if (changes.css !== undefined) writeFileSync(join(folder, "theme.css"), validateCss(changes.css, "css"));
    if (changes.liteCss !== undefined) {
      const lite = validateCss(changes.liteCss, "liteCss");
      // An empty Lite version means "no Lite version".
      if (lite.trim() === "") rmSync(join(folder, "theme-lite.css"), { force: true });
      else writeFileSync(join(folder, "theme-lite.css"), lite);
    }
    writeFileSync(join(folder, "theme.json"), JSON.stringify(manifest, null, 2));
    return this.details(id);
  }

  /** Delete one of your themes, with its images. */
  remove(id: string): void {
    rmSync(this.requireEditable(id), { recursive: true, force: true });
  }

  /** Add (or replace) an image or font in one of your themes. */
  addFile(id: string, fileName: string, bytes: Uint8Array): string[] {
    const folder = this.requireEditable(id);
    if (!FILE_NAME.test(fileName) || RESERVED_FILES.has(fileName) || !(extname(fileName).toLowerCase() in CONTENT_TYPES)) {
      throw new ValidationError(
        "Files must be images or fonts (png, jpg, webp, gif, avif, svg, woff, woff2, ttf, otf) with a simple name.",
      );
    }
    if (extname(fileName).toLowerCase() === ".css") throw new ValidationError("Edit the theme's CSS in the editor instead.");
    if (bytes.length > MAX_FILE_BYTES) throw new ValidationError("Files can be 8 MB at most.");
    const existing = this.assetNames(folder);
    if (!existing.includes(fileName) && existing.length >= MAX_FILES) {
      throw new ValidationError(`A theme can have ${MAX_FILES} files at most.`);
    }
    writeFileSync(join(folder, fileName), bytes);
    return this.assetNames(folder);
  }

  /** Remove an image or font from one of your themes. */
  removeFile(id: string, fileName: string): string[] {
    const folder = this.requireEditable(id);
    if (!FILE_NAME.test(fileName) || RESERVED_FILES.has(fileName) || !existsSync(join(folder, fileName))) {
      throw new NotFoundError("file");
    }
    rmSync(join(folder, fileName));
    return this.assetNames(folder);
  }

  // ------------------------------------------------------------ serving

  /**
   * Serve `/themes/<id>/<file>`. Besides the theme's own files, each theme
   * has two generated ones:
   *
   *   channel.css       theme.css, scoped to the channel view (for channel themes)
   *   channel-lite.css  theme-lite.css, scoped the same way
   *   outside.css       theme.css everywhere except the channel view (for the
   *                     app theme while the open channel has its own)
   *   outside-lite.css  theme-lite.css, scoped the same way
   *
   * All CSS has its relative URLs rewritten (see `rewriteUrls`).
   *
   * @returns The response, or `null` if there's no such theme or file.
   */
  serve(id: string, fileName: string): Response | null {
    if (!this.exists(id) || !FILE_NAME.test(fileName)) return null;
    const folder = this.folder(id);

    const css = (name: string, scope: "none" | "channel" | "outside"): Response | null => {
      const path = join(folder, name);
      if (!existsSync(path)) return null;
      let text = rewriteUrls(readFileSync(path, "utf8"), id);
      // Only the full theme resets tokens; its Lite version builds on it.
      if (scope === "channel") text = scopeToChannel(text, name === "theme.css" ? this.baseTokens : null);
      if (scope === "outside") text = scopeOutsideChannel(text);
      return new Response(text, { headers: { ...THEME_HEADERS, "Content-Type": CONTENT_TYPES[".css"]! } });
    };

    if (fileName === "theme.css" || fileName === "theme-lite.css") return css(fileName, "none");
    if (fileName === "channel.css") return css("theme.css", "channel");
    if (fileName === "channel-lite.css") return css("theme-lite.css", "channel");
    if (fileName === "outside.css") return css("theme.css", "outside");
    if (fileName === "outside-lite.css") return css("theme-lite.css", "outside");

    const type = CONTENT_TYPES[extname(fileName).toLowerCase()];
    const path = join(folder, fileName);
    if (!type || RESERVED_FILES.has(fileName) || !existsSync(path)) return null;
    return new Response(Bun.file(path), { headers: { ...THEME_HEADERS, "Content-Type": type } });
  }

  /**
   * The starting CSS for a theme made from Classic: every token with its
   * default value, with a short guide on top.
   */
  template(): string {
    return `/*
 * Your theme. Change any value below; delete the ones you don't need.
 * Every token is described in docs/theme-reference.md.
 *
 * To use an image you've added to this theme, refer to it by file name:
 *   --app-background: url(sky.jpg) center / cover;
 *
 * You can also style anything else, e.g.:
 *   .message-author { text-transform: uppercase; }
 */

:root {
  ${this.baseTokens}
}
`;
  }

  // ------------------------------------------------------------ helpers

  private isBuiltIn(id: string): boolean {
    return existsSync(join(this.builtInDir, id, "theme.css"));
  }

  /** Where a theme lives: built-in themes win, so yours can't shadow them. */
  private folder(id: string): string {
    return this.isBuiltIn(id) ? join(this.builtInDir, id) : join(this.userDir, id);
  }

  private requireFolder(id: string): string {
    if (!this.exists(id)) throw new NotFoundError("theme");
    return this.folder(id);
  }

  private requireEditable(id: string): string {
    const folder = this.requireFolder(id);
    if (this.isBuiltIn(id)) throw new ValidationError("Built-in themes can't be changed. Make a copy to edit.");
    return folder;
  }

  private idsIn(dir: string): string[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter(
      (name) => THEME_ID.test(name) && statSync(join(dir, name)).isDirectory() && existsSync(join(dir, name, "theme.css")),
    );
  }

  private readManifest(folder: string): Manifest & Record<string, unknown> {
    try {
      return JSON.parse(readFileSync(join(folder, "theme.json"), "utf8"));
    } catch {
      return {}; // missing or broken manifest: fall back to defaults
    }
  }

  /** Images and fonts in a theme folder (everything but the theme's own files). */
  private assetNames(folder: string): string[] {
    return readdirSync(folder)
      .filter((name) => FILE_NAME.test(name) && !RESERVED_FILES.has(name) && extname(name).toLowerCase() in CONTENT_TYPES)
      .sort();
  }

  /** An id made from a name ("My Aero!" -> "my-aero"), unused by any theme. */
  private uniqueId(name: string): string {
    const base =
      name
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 50) || "theme";
    let id = base;
    for (let n = 2; this.exists(id) || existsSync(join(this.userDir, id)); n++) id = `${base}-${n}`;
    return id;
  }
}

function validateName(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new ValidationError("A theme needs a name");
  if (value.trim().length > 60) throw new ValidationError("Theme names can be 60 characters at most");
  return value.trim();
}

function validateCss(value: unknown, field: string): string {
  if (typeof value !== "string") throw new ValidationError(`${field} must be text`);
  if (value.length > MAX_CSS_LENGTH) throw new ValidationError(`${field} is too long`);
  return value;
}
