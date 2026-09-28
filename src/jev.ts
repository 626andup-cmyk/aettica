/**
 * Jev: the fast decision model (stage 8), borrowed from Kitsikai.
 *
 * Aettica makes small yes/no calls: would reaching out now feel natural?
 * Did the story just establish something the notebook should remember? Is
 * this idea worth sharing? A chat model *could* answer those, but it's
 * slow, costly, and answers in words that then have to be read. **Jev** ([TypeSafe](https://typesafe.ai), on
 * nanoGPT) is built for exactly this: you give it some **state** (what's
 * going on, as text) and some **questions** with fixed options, and it
 * returns, for each question, the option it picks and a **probability** for
 * every option. It never writes words, and can't read images.
 *
 *   state:     "Newest message: 'ugh my head is killing me' ..."
 *   question:  "Did they say they had a headache?"  options: yes, no
 *   answer:    yes (probabilities: yes 0.94, no 0.06)
 *
 * "Can't hallucinate" means its answers are never malformed (always one of
 * the options), **not** that they're never wrong. So every answer is read in
 * three tiers (`tier`): **confident yes**, **confident no**, or **unsure**,
 * and unsure always takes the safe path (don't text, don't touch the
 * notebook). The line between them is the confidence setting (default 0.8).
 *
 * ## The request
 *
 * Jev is called through Chat Completions with a "questions" response format
 * (DESIGN.md): a map of named questions, each a choice with its options
 * described (`jevRequestBody`). The first live test found the shape (the
 * questions have to be a map, not a list); the reply is read forgivingly
 * (`readAnswers` accepts several layouts). Settings → "Test Jev" sends one
 * tiny question and shows the raw reply, for checking exactly this.
 *
 * ## If Jev isn't reachable
 *
 * DESIGN.md notes nanoGPT listed Jev as "Unavailable" once. So a **fallback**
 * can be set: a normal connection profile that's asked the same questions
 * and told to answer in JSON with a probability (`askProfile`). It's slower
 * and less calibrated, but keeps everything working. Without one, a failed
 * Jev call just means that decision is skipped this time.
 *
 * ## The Jev log
 *
 * Every call is recorded as it happened (`JevCall`): what asked, the request
 * exactly as sent, the reply exactly as received, any error, and the
 * fallback's request and reply if it was asked. The server keeps the last
 * 36 hours of them (src/jevlog.ts), for Settings → "Jev log".
 */

import { extractJson } from "./json.ts";
import { profileRequest } from "./partner.ts";
import { ApiError, createChatCompletion, type ApiOptions } from "./nanogpt.ts";
import type { ChatMessage, Profile } from "./types.ts";

// ------------------------------------------------------------------ types

/** A question for Jev: a yes/no, or a choice between fixed options. */
export type Question =
  | { id: string; kind: "yesno"; question: string }
  | { id: string; kind: "choice"; question: string; options: string[] };

/** Jev's answer to one question. */
export interface Answer {
  id: string;
  /** The option it picked. */
  selected: string;
  /** A probability (0 to 1) for every option. */
  probabilities: Record<string, number>;
  /** How sure it is of the pick. */
  confidence: number;
}

/** Answers by question id. A question missing from it wasn't answered. */
export type Answers = Map<string, Answer>;

/** How sure an answer is, in three tiers. */
export type Tier = "yes" | "no" | "unsure";

/** The options a question has. */
export function optionsOf(question: Question): string[] {
  return question.kind === "yesno" ? ["yes", "no"] : question.options;
}

// ----------------------------------------------------------------- tiers

/** The probability an answer gives one option (0 if it didn't say). */
export function probabilityOf(answer: Answer | undefined, option: string): number {
  if (!answer) return 0;
  const p = answer.probabilities[option];
  if (typeof p === "number") return p;
  return answer.selected === option ? answer.confidence : 0;
}

/**
 * A yes/no answer in three tiers: confident yes (p(yes) at least the
 * threshold), confident no (p(yes) at most 1 − threshold), or unsure. No
 * answer at all is unsure: the safe path.
 */
export function tier(answer: Answer | undefined, threshold: number): Tier {
  if (!answer) return "unsure";
  const yes = probabilityOf(answer, "yes");
  // A hair of tolerance, because computers store 1 − 0.8 as 0.19999999999999996.
  if (yes >= threshold - EPSILON) return "yes";
  if (yes <= 1 - threshold + EPSILON) return "no";
  return "unsure";
}

/** A choice answer's pick, if it's confident; otherwise `null` (unsure). */
export function confidentChoice(answer: Answer | undefined, threshold: number): string | null {
  if (!answer) return null;
  return probabilityOf(answer, answer.selected) >= threshold - EPSILON ? answer.selected : null;
}

const EPSILON = 1e-9;

// ---------------------------------------------------------------- series

/**
 * One decision asked several ways at once: a **series**. Jev can be wrong,
 * and a question can be misread through one wording that another avoids.
 * Asking two or three phrasings of the same thing in one call, and only
 * acting when every one of them agrees, trades a little recall for a lot
 * fewer mistakes (and costs nothing extra: it's still one request).
 */
export interface SeriesQuestion {
  id: string;
  /** Different wordings of the same yes/no question. */
  phrasings: string[];
}

/** What a series came to, and each phrasing's p(yes). */
export interface SeriesVerdict {
  verdict: Tier;
  yes: number[];
}

/** The questions sent for a series: `id~0`, `id~1`... */
export function seriesQuestions(series: SeriesQuestion[]): Question[] {
  return series.flatMap((s) => s.phrasings.map((question, i) => ({ id: `${s.id}~${i}`, kind: "yesno" as const, question })));
}

/**
 * Combine a series' answers: **yes** only if every phrasing is a confident
 * yes, **no** only if every one is a confident no, and unsure otherwise
 * (including any missing answer): the safe path.
 */
export function agree(answers: (Answer | undefined)[], threshold: number): Tier {
  const tiers = answers.map((a) => tier(a, threshold));
  if (tiers.length > 0 && tiers.every((t) => t === "yes")) return "yes";
  if (tiers.length > 0 && tiers.every((t) => t === "no")) return "no";
  return "unsure";
}

/** Read a series' verdicts from the answers to `seriesQuestions(series)`. */
export function seriesVerdicts(series: SeriesQuestion[], answers: Answers, threshold: number): Map<string, SeriesVerdict> {
  return new Map(
    series.map((s) => {
      const each = s.phrasings.map((_, i) => answers.get(`${s.id}~${i}`));
      return [s.id, { verdict: agree(each, threshold), yes: each.map((a) => probabilityOf(a, "yes")) }];
    }),
  );
}

/** "yes (94%, 91%)", for logs. */
export function describeVerdict(v: SeriesVerdict): string {
  return `${v.verdict} (${v.yes.map(percent).join(", ")})`;
}

/** "92%", for logs. */
export function percent(p: number): string {
  return `${Math.round(p * 100)}%`;
}

// --------------------------------------------------------------- request

/**
 * What each option means, for Jev: its "criteria". Yes/no questions get the
 * two plain answers; for the others, the option says what it is.
 */
function criteriaOf(question: Question): Record<string, string> {
  if (question.kind === "yesno") return { yes: "Yes.", no: "No." };
  return Object.fromEntries(question.options.map((option) => [option, option]));
}

/**
 * The request body for Jev: Chat Completions, with the state as the message
 * and the questions as a "questions" response format. Isolated here so it
 * can be adjusted in one place.
 *
 * The questions are a **map**, keyed by the question's id (the key is only
 * for matching answers; the model never sees it), and each is a "choice":
 * instructions, and criteria (every option, with what it means). A yes/no
 * question is a choice between "yes" and "no". Confirmed against nanoGPT
 * with a real key (its error: "Jev decision models require a non-empty
 * questions map") and TypeSafe's documented format:
 *
 *   "questions": {
 *     "t1": { "type": "choice", "instructions": "Did they have a headache?", "criteria": { "yes": "Yes.", "no": "No." } }
 *   }
 */
export function jevRequestBody(model: string, state: string, questions: Question[]): Record<string, unknown> {
  return {
    model,
    messages: [{ role: "user", content: state }],
    response_format: {
      type: "questions",
      questions: Object.fromEntries(
        questions.map((q) => [q.id, { type: "choice", instructions: q.question, criteria: criteriaOf(q) }]),
      ),
    },
    stream: false,
  };
}

/**
 * Read Jev's answers from a response, forgivingly. Accepted layouts:
 *
 *   - `choices[0].message.content` as JSON text, or `.parsed` / `.answers`
 *     on the message, or `answers` / `results` at the top level
 *   - answers as an object by id (`{q1: {...}}`, TypeSafe's format) or a
 *     list (`[{id, selected, probabilities}]`)
 *   - each answer's pick as `choice` (TypeSafe's), `selected`, `answer`,
 *     `option` or `value`; its probabilities as an object or a list of
 *     `{option, probability}`; `confidence` optional
 *
 * TypeSafe documents a choice answer as
 * `{"type": "choice", "choice": "technical", "probabilities": {...}, "confidence": 0.82}`.
 *
 * Answers to questions that weren't asked, or with a pick that isn't one of
 * the options, are dropped: Jev's answers should always fit, and anything
 * that doesn't is treated as no answer (unsure).
 */
export function readAnswers(json: unknown, questions: Question[]): Answers {
  const root = json as Record<string, any>;
  const message = root?.choices?.[0]?.message;
  let payload: unknown = message?.parsed ?? message?.answers ?? root?.answers ?? root?.results;
  if (payload === undefined && typeof message?.content === "string" && message.content.trim()) {
    try {
      payload = extractJson(message.content);
    } catch {
      payload = undefined;
    }
  }
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const inner = (payload as Record<string, unknown>).answers ?? (payload as Record<string, unknown>).results;
    if (inner) payload = inner;
  }

  const list: [string | undefined, unknown][] = Array.isArray(payload)
    ? payload.map((item) => [typeof item?.id === "string" ? item.id : typeof item?.question_id === "string" ? item.question_id : undefined, item])
    : payload && typeof payload === "object"
      ? Object.entries(payload as Record<string, unknown>)
      : [];

  const answers: Answers = new Map();
  list.forEach(([id, raw], index) => {
    const question = questions.find((q) => q.id === id) ?? (id === undefined ? questions[index] : undefined);
    if (!question) return;
    const answer = readAnswer(raw, question);
    if (answer) answers.set(question.id, answer);
  });
  return answers;
}

/** One answer, in any of the accepted layouts; `null` if it doesn't fit its question. */
function readAnswer(raw: unknown, question: Question): Answer | null {
  const options = optionsOf(question);
  const match = (value: unknown) => {
    if (typeof value === "boolean") value = value ? "yes" : "no";
    if (typeof value !== "string" && typeof value !== "number") return undefined;
    return options.find((o) => o.toLowerCase() === String(value).trim().toLowerCase());
  };
  const item = (typeof raw === "object" && raw !== null ? raw : { selected: raw }) as Record<string, unknown>;

  const probabilities: Record<string, number> = {};
  const rawProbabilities = item.probabilities ?? item.probs ?? item.distribution ?? item.scores;
  if (Array.isArray(rawProbabilities)) {
    for (const entry of rawProbabilities as Record<string, unknown>[]) {
      const option = match(entry?.option ?? entry?.label ?? entry?.value ?? entry?.choice);
      const p = Number(entry?.probability ?? entry?.p ?? entry?.score);
      if (option && Number.isFinite(p)) probabilities[option] = p;
    }
  } else if (rawProbabilities && typeof rawProbabilities === "object") {
    for (const [key, value] of Object.entries(rawProbabilities)) {
      const option = match(key);
      if (option && typeof value === "number" && Number.isFinite(value)) probabilities[option] = value;
    }
  }

  let selected = match(item.selected ?? item.answer ?? item.choice ?? item.option ?? item.value);
  if (!selected && Object.keys(probabilities).length) {
    selected = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]![0];
  }
  if (!selected) return null;
  const rawConfidence = Number(item.confidence ?? item.probability);
  const confidence = Number.isFinite(rawConfidence) ? rawConfidence : (probabilities[selected] ?? 1);
  if (Object.keys(probabilities).length === 0) {
    // Only a pick and a confidence: spread the rest over the other options.
    probabilities[selected] = confidence;
    const others = options.filter((o) => o !== selected);
    for (const o of others) probabilities[o] = others.length ? (1 - confidence) / others.length : 0;
  }
  return { id: question.id, selected, probabilities, confidence };
}

// -------------------------------------------------------------- calling

/** What `Decider.ask` needs to know about the settings. */
export interface DeciderSettings {
  /** Jev's model id on nanoGPT, pinned (not jev-latest: upgrade on purpose). */
  decisionModel: string;
  /** A profile to ask instead when Jev fails, or `null` for none. */
  fallback: Profile | null;
}

/** Options for one `ask`. */
export interface AskOptions {
  /** Stops the call. */
  signal?: AbortSignal;
  /** What's asking, for the Jev log: "Wake-up", "Notebook keeper"... */
  purpose?: string;
}

/** One call, exactly as it went: a row of the Jev log (src/jevlog.ts). */
export interface JevCall {
  /** What asked (`AskOptions.purpose`). */
  purpose: string;
  /** Jev's model id ("" when Jev is turned off). */
  model: string;
  /** The request body sent to Jev, exactly; `null` if Jev wasn't asked (turned off). */
  request: Record<string, unknown> | null;
  /** Jev's reply, exactly as it came back ("" if there wasn't one). */
  response: string;
  /** Why Jev failed, when it did. */
  error: string | null;
  /** Who answered in the end: Jev, the fallback profile, or nobody (`null`). */
  answeredBy: "jev" | "fallback" | null;
  /** The answers, in short: "t1: yes (95%), plan: no (90%)" ("" if none). */
  summary: string;
  /** The fallback profile's request and reply, when it was asked. */
  fallback: { profile: string; model: string; messages: ChatMessage[]; response: string; error: string | null } | null;
  durationMs: number;
}

/** What the last call did, for Settings → Test Jev. */
export interface DeciderReport {
  /** "jev", or "fallback" when Jev failed and the fallback profile answered. */
  answeredBy: "jev" | "fallback";
  /** Jev's raw reply (or error), for troubleshooting a format mismatch. */
  raw: string;
  /** Why Jev failed, when it did. */
  jevError: string | null;
  seconds: number;
}

/** A failed Jev call, with its raw reply when there was one (for the Jev log). */
class JevError extends ApiError {
  constructor(
    message: string,
    readonly raw: string,
    status?: number,
  ) {
    super(message, status);
  }
}

async function postChat(api: ApiOptions, body: Record<string, unknown>, signal?: AbortSignal): Promise<{ json: unknown; raw: string }> {
  if (!api.apiKey) throw new ApiError("No nanoGPT API key is set. Add NANOGPT_API_KEY to your .env file and restart the server.");
  const timeout = AbortSignal.timeout(api.timeoutMs);
  let response: Response;
  let raw: string;
  try {
    response = await fetch(`${api.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${api.apiKey}` },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
    raw = await response.text();
  } catch (error) {
    if (timeout.aborted) throw new ApiError(`Jev took longer than ${Math.round(api.timeoutMs / 1000)} seconds to answer.`);
    throw new ApiError(`Couldn't reach nanoGPT: ${(error as Error).message}`);
  }
  if (!response.ok) throw new JevError(`Jev returned an error (HTTP ${response.status}): ${raw.slice(0, 300)}`, raw, response.status);
  try {
    return { json: JSON.parse(raw), raw };
  } catch {
    throw new JevError(`Jev sent back something that isn't JSON: ${raw.slice(0, 200)}`, raw);
  }
}

/**
 * Ask the questions of a normal chat model instead (the fallback), telling
 * it to answer in JSON with a probability for each.
 */
function fallbackMessages(state: string, questions: Question[]): ChatMessage[] {
  const listed = questions.map((q) => `- "${q.id}": ${q.question} Options: ${optionsOf(q).map((o) => JSON.stringify(o)).join(", ")}`).join("\n");
  return [
    {
      role: "system",
      content: `You answer questions about a situation, precisely and without guessing wildly. For each question, pick one of its options and give the probability (0 to 1) that your pick is right. Reply with JSON only, like {"q1": {"answer": "yes", "probability": 0.9}}.`,
    },
    { role: "user", content: `The situation:\n\n${state}\n\nThe questions:\n${listed}` },
  ];
}

/** `log` gets the reply as soon as there is one, so the Jev log has it even if reading it fails. */
async function askProfile(
  api: ApiOptions,
  profile: Profile,
  messages: ChatMessage[],
  questions: Question[],
  signal: AbortSignal | undefined,
  log: (content: string) => void,
): Promise<Answers> {
  const response = await createChatCompletion(api, { ...profileRequest(profile), temperature: 0, messages, signal });
  log(response.content);
  const json = extractJson(response.content) as Record<string, unknown>;
  const shaped = Object.fromEntries(
    Object.entries(json ?? {}).map(([id, value]) => {
      const item = (value ?? {}) as Record<string, unknown>;
      return [id, { selected: item.answer ?? item.selected, confidence: item.probability ?? item.confidence }];
    }),
  );
  return readAnswers({ answers: shaped }, questions);
}

/** "t1: yes (95%), plan: no (90%)": answers in short, for the Jev log. */
function summarize(answers: Answers): string {
  return [...answers.values()].map((a) => `${a.id}: ${a.selected} (${percent(probabilityOf(a, a.selected))})`).join(", ");
}

/** Asks Jev (or the fallback) questions, and remembers how the last call went. */
export class Decider {
  /** How the last call went. */
  lastReport: DeciderReport | null = null;

  constructor(
    private readonly api: ApiOptions,
    private readonly settings: () => DeciderSettings,
    /** Told about every call, for the Jev log (src/jevlog.ts). */
    private readonly record?: (call: JevCall) => void,
  ) {}

  /** Whether anything can answer: Jev, or a fallback profile. */
  enabled(): boolean {
    const { decisionModel, fallback } = this.settings();
    return decisionModel !== "" || fallback !== null;
  }

  /**
   * Ask questions about a state.
   *
   * @throws ApiError if Jev fails and there's no fallback (or it fails too).
   */
  async ask(state: string, questions: Question[], options: AskOptions = {}): Promise<Answers> {
    if (questions.length === 0) return new Map();
    const { signal, purpose = "Other" } = options;
    const { decisionModel, fallback } = this.settings();
    const started = Date.now();
    const call: JevCall = { purpose, model: decisionModel, request: null, response: "", error: null, answeredBy: null, summary: "", fallback: null, durationMs: 0 };
    try {
      return await this.answer(state, questions, signal, decisionModel, fallback, call, started);
    } finally {
      // Only calls that went somewhere are logged, and logging never gets in
      // the way of a decision.
      if (call.request || call.fallback) {
        call.durationMs = Date.now() - started;
        if (signal?.aborted && !call.answeredBy) call.error = "Stopped.";
        try {
          this.record?.(call);
        } catch (error) {
          console.error("[jev] couldn't write the Jev log", error);
        }
      }
    }
  }

  /**
   * Ask several series at once (see `SeriesQuestion`), in one call.
   *
   * @throws like `ask`.
   */
  async askSeries(state: string, series: SeriesQuestion[], threshold: number, options: AskOptions = {}): Promise<Map<string, SeriesVerdict>> {
    const answers = await this.ask(state, seriesQuestions(series), options);
    return seriesVerdicts(series, answers, threshold);
  }

  private async answer(
    state: string,
    questions: Question[],
    signal: AbortSignal | undefined,
    decisionModel: string,
    fallback: Profile | null,
    call: JevCall,
    started: number,
  ): Promise<Answers> {
    const seconds = () => Math.round((Date.now() - started) / 100) / 10;
    const viaFallback = async (profile: Profile, jevError: string, raw: string): Promise<Answers> => {
      const messages = fallbackMessages(state, questions);
      const asked: NonNullable<JevCall["fallback"]> = { profile: profile.name, model: profile.model, messages, response: "", error: null };
      call.fallback = asked;
      try {
        const answers = await askProfile(this.api, profile, messages, questions, signal, (content) => (asked.response = content));
        call.answeredBy = "fallback";
        call.summary = summarize(answers);
        this.lastReport = { answeredBy: "fallback", raw, jevError, seconds: seconds() };
        return answers;
      } catch (error) {
        asked.error = error instanceof Error ? error.message : String(error);
        throw error;
      }
    };

    if (!decisionModel) {
      // Jev is turned off: straight to the fallback, if there is one.
      const jevError = "Jev is turned off (no decision model is set).";
      call.error = jevError;
      if (!fallback) throw new ApiError(`${jevError} Set one, or a fallback profile, in Settings.`);
      return viaFallback(fallback, jevError, "");
    }
    const body = jevRequestBody(decisionModel, state, questions);
    call.request = body;
    try {
      const { json, raw } = await postChat(this.api, body, signal);
      call.response = raw;
      const answers = readAnswers(json, questions);
      this.lastReport = { answeredBy: "jev", raw, jevError: null, seconds: seconds() };
      if (answers.size === 0) throw new ApiError(`Jev's reply had no answers in a shape Aettica understands: ${raw.slice(0, 200)}`);
      call.answeredBy = "jev";
      call.summary = summarize(answers);
      return answers;
    } catch (error) {
      if (!(error instanceof ApiError)) {
        call.error = error instanceof Error ? error.message : String(error);
        throw error;
      }
      const jevError = error.message;
      call.error = jevError;
      if (error instanceof JevError) call.response = error.raw;
      this.lastReport = { answeredBy: "jev", raw: this.lastReport?.raw ?? "", jevError, seconds: seconds() };
      if (!fallback) throw error;
      console.warn(`[jev] ${jevError} Asking ${fallback.name} instead.`);
      return viaFallback(fallback, jevError, this.lastReport.raw);
    }
  }
}

// -------------------------------------------------------------- testing

/** What Settings → "Test Jev" shows. */
export interface JevTestResult {
  /** Whether the answer came back, and made sense. */
  ok: boolean;
  /** A sentence explaining what happened. */
  detail: string;
  /** The answer, if there was one. */
  answer: Answer | null;
  /** Who answered, the raw reply, and how long it took. */
  report: DeciderReport | null;
}

/**
 * Ask Jev one tiny question with an obvious answer, and explain what came
 * back. This is the live test DESIGN.md asks for before relying on Jev: is
 * it reachable, and does its reply have the shape Aettica expects? The raw
 * reply is shown either way, so a format mismatch can be fixed in
 * `jevRequestBody` / `readAnswers`.
 */
export async function testJev(decider: Decider): Promise<JevTestResult> {
  const question: Question = { id: "pet", kind: "yesno", question: "Did they say they got a pet?" };
  try {
    const answers = await decider.ask("They texted: \"guess what, I just got a puppy!! his name is Biscuit\"", [question], { purpose: "Test Jev" });
    const answer = answers.get("pet") ?? null;
    const report = decider.lastReport;
    const who = report?.answeredBy === "fallback" ? `Jev failed (${report.jevError}), so the fallback profile answered` : "Jev answered";
    if (!answer) return { ok: false, detail: `${who}, but there was no answer to the question.`, answer, report };
    const sure = percent(probabilityOf(answer, answer.selected));
    return answer.selected === "yes"
      ? { ok: report?.answeredBy === "jev", detail: `${who} "yes", ${sure} sure, as expected.${report?.answeredBy === "jev" ? " It's working." : ""}`, answer, report }
      : { ok: false, detail: `${who} "${answer.selected}" (${sure} sure), but the answer should have been "yes". Check the raw reply.`, answer, report };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error), answer: null, report: decider.lastReport };
  }
}
