/**
 * A small client for nanoGPT's API.
 *
 * nanoGPT gives one API key access to many models (DeepSeek, GLM, Kimi, ...)
 * and speaks the same "chat completions" format as OpenAI. A request is a
 * plain HTTPS POST with a JSON body:
 *
 *   POST https://nano-gpt.com/api/v1/chat/completions
 *   Authorization: Bearer <your key>
 *   { "model": "...", "messages": [...], "temperature": 0.9, "max_tokens": 1024 }
 *
 * and the reply is JSON with the generated text at
 * `choices[0].message.content`.
 *
 * This file uses the built-in `fetch`, so there is no SDK to install.
 */

import type { ChatMessage } from "./types.ts";

/** What the client needs to know to reach the API. */
export interface ApiOptions {
  apiKey: string;
  /** e.g. `https://nano-gpt.com/api/v1` (no trailing slash). */
  baseUrl: string;
  /** Give up after this many milliseconds. */
  timeoutMs: number;
}

/** The parameters of one generation request. */
export interface CompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature: number;
  maxTokens: number;
}

/** A successful generation. */
export interface CompletionResult {
  /** The generated text, with any `<think>` reasoning removed. */
  content: string;
  /** The model that actually answered, as reported by the API. */
  model: string;
  /** Why generation stopped: `"stop"` is normal, `"length"` means it hit `maxTokens`. */
  finishReason: string | null;
}

/**
 * An error from the API, carrying the HTTP status when there is one.
 * The message is written to be shown to you directly in the app.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Ask the model for one reply.
 *
 * Throws `ApiError` if the key is missing, the network fails, the request
 * times out, the API returns an error, or the reply is empty.
 */
export async function createChatCompletion(
  options: ApiOptions,
  request: CompletionRequest,
): Promise<CompletionResult> {
  if (!options.apiKey) {
    throw new ApiError("No nanoGPT API key is set. Add NANOGPT_API_KEY to your .env file and restart the server.");
  }

  // The request body. Note the API uses snake_case (`max_tokens`), while
  // our own code uses camelCase (`maxTokens`).
  const body = {
    model: request.model,
    messages: request.messages,
    temperature: request.temperature,
    max_tokens: request.maxTokens,
    // We wait for the whole reply rather than streaming it word by word.
    // Streaming is a nice later improvement but adds complexity.
    stream: false,
  };

  const json = await postJson(options, "/chat/completions", body);

  // Dig the text out of the response. Everything is checked because a model
  // provider having a bad day can return all sorts of shapes.
  const choice = (json as { choices?: unknown[] })?.choices?.[0] as
    | { message?: { content?: unknown }; finish_reason?: string }
    | undefined;
  const rawContent = choice?.message?.content;
  if (typeof rawContent !== "string") {
    throw new ApiError("The model's reply didn't contain any text.");
  }

  const content = stripReasoning(rawContent);
  if (content === "") {
    throw new ApiError(
      choice?.finish_reason === "length"
        ? "The model ran out of tokens before writing anything. Try raising Max tokens."
        : "The model returned an empty reply.",
    );
  }

  return {
    content,
    model: typeof (json as { model?: unknown }).model === "string" ? (json as { model: string }).model : request.model,
    finishReason: choice?.finish_reason ?? null,
  };
}

/**
 * List the model ids available to your key, for the settings panel.
 * Returns them sorted alphabetically.
 */
export async function listModels(options: ApiOptions): Promise<string[]> {
  const json = await request(options, "/models", { method: "GET" });
  const data = (json as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  return data
    .map((entry) => (entry as { id?: unknown })?.id)
    .filter((id): id is string => typeof id === "string")
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Remove "thinking" text from a reply.
 *
 * Some reasoning models put their private reasoning inside
 * `<think>...</think>` tags at the start of the reply. That's not part of the
 * post, so it's removed. (Models that send reasoning in a separate field
 * don't need this; we simply never read that field.)
 */
export function stripReasoning(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

// ------------------------------------------------------------------ helpers

function postJson(options: ApiOptions, path: string, body: unknown): Promise<unknown> {
  return request(options, path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * Send one request and return the parsed JSON response, turning every kind
 * of failure into an `ApiError` with a readable message.
 */
async function request(options: ApiOptions, path: string, init: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${options.baseUrl}${path}`, {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${options.apiKey}` },
      // Abort the request if it takes longer than the timeout.
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch (error) {
    if ((error as Error).name === "TimeoutError") {
      throw new ApiError(`The model took longer than ${Math.round(options.timeoutMs / 1000)} seconds to reply.`);
    }
    throw new ApiError(`Couldn't reach nanoGPT: ${(error as Error).message}`);
  }

  const text = await response.text();

  if (!response.ok) {
    throw new ApiError(describeHttpError(response.status, text), response.status);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError("nanoGPT sent back something that isn't JSON.", response.status);
  }
}

/** A friendly explanation for an HTTP error status, plus the API's own message if it sent one. */
function describeHttpError(status: number, body: string): string {
  const hints: Record<number, string> = {
    401: "nanoGPT rejected the API key. Check NANOGPT_API_KEY in your .env file.",
    402: "nanoGPT says your balance is too low.",
    404: "nanoGPT doesn't recognise that model id. Check the model in settings.",
    429: "nanoGPT is rate-limiting you. Wait a moment and try again.",
  };
  const hint = hints[status] ?? `nanoGPT returned an error (HTTP ${status}).`;

  // Error bodies are usually `{ "error": { "message": "..." } }`.
  let detail = "";
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } | string };
    const err = parsed.error;
    detail = typeof err === "string" ? err : typeof err?.message === "string" ? err.message : "";
  } catch {
    detail = body.slice(0, 200);
  }
  return detail ? `${hint} (${detail})` : hint;
}
