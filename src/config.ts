/**
 * Server configuration, read from environment variables.
 *
 * Bun automatically loads a `.env` file from the project folder, so on the
 * phone you put your settings there (see `.env.example`) rather than typing
 * them every time you start the server.
 *
 * Only things that belong to the *machine* live here: the API key, the port,
 * the data folder. Things that belong to the *chat* (partner prompt, model,
 * temperature) are settings you change in the app; see `store.ts`.
 */

import { resolve } from "node:path";

export interface Config {
  /** Interface to listen on. `127.0.0.1` means "this device only". */
  host: string;
  port: number;
  /** Absolute path of the folder where the chat is saved. */
  dataDir: string;
  /** Absolute path of the folder holding the web app's files. */
  publicDir: string;
  /** Absolute path of the folder of built-in themes. (Your own are in `<dataDir>/themes`.) */
  themesDir: string;
  /** nanoGPT API key. Empty means "not configured yet". */
  apiKey: string;
  /** Base URL of the OpenAI-compatible API, without a trailing slash. */
  apiBaseUrl: string;
  /** How long to wait for one model reply, in milliseconds. */
  requestTimeoutMs: number;
}

/**
 * Build the configuration from an environment (normally `process.env`).
 *
 * Taking the environment as a parameter instead of reading `process.env`
 * directly lets the tests build a config without touching real variables.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  // The project root is one folder up from this file (src/..).
  const root = resolve(import.meta.dir, "..");

  return {
    host: env.HOST || "127.0.0.1",
    port: parsePositiveInt(env.PORT, 3000, "PORT"),
    dataDir: resolve(root, env.DATA_DIR || "data"),
    publicDir: resolve(root, "public"),
    themesDir: resolve(root, "themes"),
    apiKey: (env.NANOGPT_API_KEY || "").trim(),
    // Strip any trailing slashes so we can always write `${base}/path`.
    apiBaseUrl: (env.NANOGPT_BASE_URL || "https://nano-gpt.com/api/v1").replace(/\/+$/, ""),
    requestTimeoutMs: parsePositiveInt(env.REQUEST_TIMEOUT_SECONDS, 180, "REQUEST_TIMEOUT_SECONDS") * 1000,
  };
}

/**
 * Parse a whole number greater than zero, falling back to a default when the
 * variable is unset. A value that is set but invalid is an error: silently
 * ignoring a typo like `PORT=30OO` would be more confusing than failing.
 */
function parsePositiveInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a whole number greater than 0, got "${value}"`);
  }
  return parsed;
}
