/**
 * The reference library: long texts (a movie script, a book, a wiki dump
 * for a fandom) that your partner can look things up in, without any of it
 * being sent with every message.
 *
 * A document is split into **passages** of a page or so, following its own
 * structure where it has one (a screenplay's scene headings, Markdown
 * headings, chapters), and each passage is indexed for full-text search
 * with SQLite's FTS5 (stemmed, so "running" finds "run"). Each passage
 * also remembers:
 *
 *   - its **heading**: the scene or chapter it's in ("INT. BAG END - NIGHT")
 *   - its **speakers**: in a script, the characters with lines in it
 *
 * Both are searched too, and weigh more than the text, so "Gandalf at Bag
 * End" finds the passages where Gandalf speaks in that scene first.
 *
 * Your partner uses it through two tools (src/tools.ts): `search_library`
 * finds passages and shows a snippet of each; `read_library` reads a
 * passage in full, and the ones after it. The prompt only says what's in
 * the library (titles and descriptions), so it costs nothing until your
 * partner decides a detail is worth looking up.
 *
 * A document can be limited to some channels (say, the fandom's RP
 * channel). It's always available in OOC channels, where you'd talk about it.
 */

import type { Database } from "bun:sqlite";
import { NotFoundError, ValidationError } from "./errors.ts";
import type { Channel } from "./types.ts";

/** A document in the library (without its text). */
export interface LibraryDoc {
  id: string;
  title: string;
  /** What it is, for your partner ("The screenplay of the first film"). */
  description: string;
  /** Channels it's limited to; empty means everywhere. OOC channels always see it. */
  channelIds: string[];
  /** Its length, in characters. */
  chars: number;
  passages: number;
  createdAt: string;
  updatedAt: string;
}

/** One passage of a document. `seq` counts from 1. */
export interface Passage {
  docId: string;
  seq: number;
  heading: string;
  speakers: string[];
  content: string;
}

/** A search result: where, and a snippet with the matches in «». */
export interface SearchHit {
  docId: string;
  title: string;
  seq: number;
  heading: string;
  snippet: string;
}

/** The longest document accepted (in characters): a feature-length script is ~200,000. */
export const MAX_DOC_CHARS = 5_000_000;

/** Aim for passages about this long (characters): roughly a page. */
export const PASSAGE_TARGET = 1500;

/** Never longer than this: a long paragraph is split at sentences. */
const PASSAGE_MAX = 2400;

/** A new heading starts a new passage once the current one has this much. */
const PASSAGE_MIN = 300;

// ------------------------------------------------------------- splitting

/** Screenplay scene headings ("INT. HOUSE - DAY"), Markdown headings, chapters, acts. */
const HEADING =
  /^(?:(?:INT|EXT|INT\.?\/EXT|EXT\.?\/INT|I\/E)[.\s].{2,}|#{1,6}\s+\S.*|(?:chapter|prologue|epilogue|act|part|book)\b.{0,60}|scene\s+\d+.{0,60})$/i;

/** A screenplay character cue: a short line in capitals, maybe with (V.O.) or (CONT'D). */
const CUE = /^([A-Z][A-Z0-9 .'\-&]{0,30}[A-Z0-9.])(?:\s*\([^)]*\))*\s*:?$/;

/** Cues that aren't characters. */
const NOT_SPEAKERS = new Set([
  "CUT TO", "FADE IN", "FADE OUT", "FADE TO BLACK", "DISSOLVE TO", "SMASH CUT TO", "THE END", "CONTINUED",
  "MORE", "BACK TO SCENE", "LATER", "MOMENTS LATER", "CONTINUOUS", "INTERCUT", "END", "TITLE", "SUPER",
]);

/** The speaker named by a cue line, if it is one. */
export function cueName(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed.length > 45 || HEADING.test(trimmed)) return null;
  const match = CUE.exec(trimmed);
  if (!match) return null;
  const name = match[1]!.replace(/[.:]+$/, "").trim();
  if (NOT_SPEAKERS.has(name) || name.length < 2) return null;
  return name;
}

/** Whether a line is a heading, and its text if so (without Markdown's #s). */
export function headingOf(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed.length > 90 || !HEADING.test(trimmed)) return null;
  return trimmed.replace(/^#{1,6}\s+/, "");
}

/** Split a long paragraph at sentence (or line) ends, into pieces under PASSAGE_MAX. */
function splitLong(paragraph: string): string[] {
  if (paragraph.length <= PASSAGE_MAX) return [paragraph];
  const pieces: string[] = [];
  const sentences = paragraph.match(/[^.!?\n]+(?:[.!?]+["')\]]*|\n|$)\s*/g) ?? [paragraph];
  let current = "";
  for (const sentence of sentences) {
    if (current && current.length + sentence.length > PASSAGE_TARGET) {
      pieces.push(current.trim());
      current = "";
    }
    // A single enormous "sentence" (no punctuation at all): cut it by length.
    for (let i = 0; i < sentence.length; i += PASSAGE_MAX) {
      const part = sentence.slice(i, i + PASSAGE_MAX);
      if (part.length === PASSAGE_MAX) pieces.push(part.trim());
      else current += part;
    }
  }
  if (current.trim()) pieces.push(current.trim());
  return pieces;
}

/**
 * Split a document into passages, following its headings. Paragraphs are
 * kept whole where possible; each passage knows the heading it's under and
 * the characters who speak in it.
 */
export function splitPassages(text: string): Omit<Passage, "docId">[] {
  const clean = text
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "    ")
    .replace(/\u00a0/g, " ")
    // Scripts indent cues and dialogue deeply. Keep the shape, not the width:
    // every 5 spaces become 1 (at most 4), which reads on a phone and costs
    // your partner fewer tokens.
    .replace(/^ +/gm, (spaces) => " ".repeat(Math.min(4, Math.floor(spaces.length / 5))));
  const passages: Omit<Passage, "docId">[] = [];
  let heading = "";
  let current: string[] = [];
  let size = 0;
  let passageHeading = "";

  const flush = () => {
    const content = current.join("\n\n").trim();
    if (content) {
      const speakers = new Set<string>();
      // A cue is followed straight away by its dialogue (a title isn't).
      const lines = content.split("\n");
      lines.forEach((line, i) => {
        const name = lines[i + 1]?.trim() ? cueName(line) : null;
        if (name) speakers.add(name);
      });
      passages.push({ seq: passages.length + 1, heading: passageHeading, speakers: [...speakers], content });
    }
    current = [];
    size = 0;
  };

  for (const block of clean.split(/\n\s*\n/)) {
    const paragraph = block.replace(/[ ]+$/gm, "").replace(/^\n+|\n+$/g, "");
    if (!paragraph.trim()) continue;
    const firstLine = paragraph.trimStart().split("\n")[0]!;
    const newHeading = headingOf(firstLine);
    if (newHeading) {
      if (size >= PASSAGE_MIN) flush();
      heading = newHeading;
      // A passage still without a heading (a title page) takes this one.
      if (size === 0 || !passageHeading) passageHeading = heading;
    }
    for (const piece of splitLong(paragraph)) {
      if (size > 0 && size + piece.length > PASSAGE_TARGET) flush();
      if (size === 0) passageHeading = heading;
      current.push(piece);
      size += piece.length + 2;
    }
  }
  flush();
  return passages;
}

// -------------------------------------------------------------- searching

/** Words too common to search for. */
const STOPWORDS = new Set(
  "a an and are as at be but by did do does for from had has have he her his how i in is it its me my of on or she so that the their them then there they this to was we were what when where which who why will with you your".split(
    " ",
  ),
);

/**
 * Turn what your partner (or you) typed into an FTS5 query: "quoted
 * phrases" stay phrases, other words are matched on their own (stemmed),
 * and any of them can match; passages matching more of them rank higher.
 * Returns null if nothing is left to search for.
 */
export function ftsQuery(input: string): string | null {
  const terms: string[] = [];
  const rest = input.replace(/"([^"]+)"/g, (_, phrase: string) => {
    const words = phrase.match(/[\p{L}\p{N}']+/gu);
    if (words?.length) terms.push(`"${words.join(" ").replace(/"/g, "")}"`);
    return " ";
  });
  for (const word of rest.match(/[\p{L}\p{N}]+(?:'[\p{L}]+)?/gu) ?? []) {
    const lower = word.toLowerCase();
    if (STOPWORDS.has(lower) || (lower.length < 2 && !/\d/.test(lower))) continue;
    const term = `"${word.replace(/'/g, "")}"`;
    if (!terms.includes(term)) terms.push(term);
  }
  return terms.length ? terms.slice(0, 16).join(" OR ") : null;
}

// ------------------------------------------------------------------ store

interface DocRow {
  id: string;
  title: string;
  description: string;
  channel_ids: string;
  chars: number;
  passages: number;
  created_at: string;
  updated_at: string;
}

interface PassageRow {
  doc_id: string;
  seq: number;
  heading: string;
  speakers: string;
  content: string;
}

function toDoc(row: DocRow): LibraryDoc {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    channelIds: JSON.parse(row.channel_ids) as string[],
    chars: row.chars,
    passages: row.passages,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toPassage(row: PassageRow): Passage {
  return { docId: row.doc_id, seq: row.seq, heading: row.heading, speakers: row.speakers ? row.speakers.split("\n") : [], content: row.content };
}

/** Check a document's title, description and channels (for adding and editing). */
function cleanDetails(input: Record<string, unknown>, partial: boolean, channelExists: (id: string) => boolean) {
  const out: { title?: string; description?: string; channelIds?: string[] } = {};
  if (input.title !== undefined || !partial) {
    if (typeof input.title !== "string" || !input.title.trim()) throw new ValidationError("A document needs a title.");
    if (input.title.trim().length > 200) throw new ValidationError("A title can be at most 200 characters.");
    out.title = input.title.trim();
  }
  if (input.description !== undefined) {
    if (typeof input.description !== "string") throw new ValidationError("description must be text.");
    if (input.description.length > 1000) throw new ValidationError("A description can be at most 1,000 characters.");
    out.description = input.description.trim();
  }
  if (input.channelIds !== undefined) {
    if (!Array.isArray(input.channelIds) || input.channelIds.some((id) => typeof id !== "string" || !channelExists(id))) {
      throw new ValidationError("channelIds must be a list of channels.");
    }
    out.channelIds = [...new Set(input.channelIds as string[])];
  }
  return out;
}

export class Library {
  constructor(
    private readonly db: Database,
    private readonly channelExists: (id: string) => boolean,
  ) {}

  /** Every document, by title. */
  list(): LibraryDoc[] {
    return (this.db.query("SELECT * FROM library_docs ORDER BY title COLLATE NOCASE").all() as DocRow[]).map(toDoc);
  }

  get(id: string): LibraryDoc {
    const row = this.db.query("SELECT * FROM library_docs WHERE id = $id").get({ id }) as DocRow | null;
    if (!row) throw new NotFoundError("There's no such document in the library.");
    return toDoc(row);
  }

  /** The documents your partner can use in a channel: its own, the unlimited ones, and all of them in OOC. */
  forChannel(channel: Pick<Channel, "id" | "kind">): LibraryDoc[] {
    return this.list().filter((d) => channel.kind === "ooc" || d.channelIds.length === 0 || d.channelIds.includes(channel.id));
  }

  /** Add a document: split it into passages and index them. */
  add(input: Record<string, unknown>): LibraryDoc {
    const details = cleanDetails(input, false, this.channelExists);
    if (typeof input.content !== "string" || !input.content.trim()) throw new ValidationError("The document is empty.");
    if (input.content.length > MAX_DOC_CHARS) {
      throw new ValidationError(`That's too long: the library takes up to ${MAX_DOC_CHARS.toLocaleString("en-US")} characters per document.`);
    }
    if (input.content.includes("\u0000")) throw new ValidationError("That doesn't look like a text file.");
    const passages = splitPassages(input.content);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO library_docs (id, title, description, channel_ids, chars, passages, created_at, updated_at)
           VALUES ($id, $title, $description, $channelIds, $chars, $passages, $now, $now)`,
        )
        .run({
          id,
          title: details.title!,
          description: details.description ?? "",
          channelIds: JSON.stringify(details.channelIds ?? []),
          chars: (input.content as string).length,
          passages: passages.length,
          now,
        });
      const insert = this.db.query(
        `INSERT INTO library_passages (doc_id, seq, heading, speakers, content)
         VALUES ($docId, $seq, $heading, $speakers, $content) RETURNING rowid`,
      );
      const index = this.db.query(
        "INSERT INTO library_fts (rowid, heading, speakers, content) VALUES ($rowid, $heading, $speakers, $content)",
      );
      for (const p of passages) {
        const speakers = p.speakers.join("\n");
        const { rowid } = insert.get({ docId: id, seq: p.seq, heading: p.heading, speakers, content: p.content }) as { rowid: number };
        index.run({ rowid, heading: p.heading, speakers, content: p.content });
      }
    })();
    return this.get(id);
  }

  /** Change a document's title, description or channels. */
  update(id: string, input: Record<string, unknown>): LibraryDoc {
    const doc = this.get(id);
    const details = cleanDetails(input, true, this.channelExists);
    this.db
      .query(
        `UPDATE library_docs SET title = $title, description = $description, channel_ids = $channelIds, updated_at = $now
         WHERE id = $id`,
      )
      .run({
        id,
        title: details.title ?? doc.title,
        description: details.description ?? doc.description,
        channelIds: JSON.stringify(details.channelIds ?? doc.channelIds),
        now: new Date().toISOString(),
      });
    return this.get(id);
  }

  /** Delete a document and its passages. */
  remove(id: string): void {
    this.get(id);
    this.db.transaction(() => {
      const rows = this.db.query("SELECT rowid, heading, speakers, content FROM library_passages WHERE doc_id = $id").all({ id }) as {
        rowid: number;
        heading: string;
        speakers: string;
        content: string;
      }[];
      // The index keeps its own copy of the words: tell it which to forget.
      const forget = this.db.query(
        "INSERT INTO library_fts (library_fts, rowid, heading, speakers, content) VALUES ('delete', $rowid, $heading, $speakers, $content)",
      );
      for (const row of rows) forget.run(row);
      this.db.query("DELETE FROM library_docs WHERE id = $id").run({ id });
    })();
  }

  /** Forget a channel that was deleted, in every document limited to it. */
  channelDeleted(channelId: string): void {
    for (const doc of this.list().filter((d) => d.channelIds.includes(channelId))) {
      this.update(doc.id, { channelIds: doc.channelIds.filter((c) => c !== channelId) });
    }
  }

  /** Passages `from` to `from + count - 1` of a document (as many as exist). */
  passages(id: string, from: number, count = 1): Passage[] {
    this.get(id);
    const rows = this.db
      .query("SELECT * FROM library_passages WHERE doc_id = $id AND seq >= $from AND seq < $to ORDER BY seq")
      .all({ id, from, to: from + count }) as PassageRow[];
    return rows.map(toPassage);
  }

  /**
   * Search passages, best first. Speakers weigh most, then headings, then
   * the text.
   *
   * @param docIds  Only these documents (by default, all).
   */
  search(query: string, docIds?: string[], limit = 6): SearchHit[] {
    const match = ftsQuery(query);
    if (!match) return [];
    if (docIds && docIds.length === 0) return [];
    const only = docIds ? `AND p.doc_id IN (${docIds.map((_, i) => `$d${i}`).join(", ")})` : "";
    const params: Record<string, string | number> = { match, limit };
    docIds?.forEach((id, i) => (params[`d${i}`] = id));
    const rows = this.db
      .query(
        `SELECT p.doc_id, d.title, p.seq, p.heading,
                snippet(library_fts, 2, '«', '»', '…', 24) AS snippet
         FROM library_fts
         JOIN library_passages p ON p.rowid = library_fts.rowid
         JOIN library_docs d ON d.id = p.doc_id
         WHERE library_fts MATCH $match ${only}
         ORDER BY bm25(library_fts, 2.0, 3.0, 1.0)
         LIMIT $limit`,
      )
      .all(params) as { doc_id: string; title: string; seq: number; heading: string; snippet: string }[];
    return rows.map((r) => ({ docId: r.doc_id, title: r.title, seq: r.seq, heading: r.heading, snippet: r.snippet.replace(/\s+/g, " ").trim() }));
  }

  /** Find a document your partner named, among those given: exact title, then a unique partial match. */
  find(name: string, docs: LibraryDoc[]): LibraryDoc | null {
    const wanted = name.trim().toLowerCase().replace(/^["']|["']$/g, "");
    const exact = docs.find((d) => d.title.toLowerCase() === wanted);
    if (exact) return exact;
    const partial = docs.filter((d) => d.title.toLowerCase().includes(wanted) || wanted.includes(d.title.toLowerCase()));
    return partial.length === 1 ? partial[0]! : null;
  }
}
