# The reference library

The library holds long texts your partner can look things up in: a film's screenplay, a book, episode transcripts, a wiki page for a fandom. None of it is sent with your messages. Your partner **searches** it and **reads** the passages they need, when they decide a detail is worth checking. It's the same way you'd flip to the right page of a script, not reread the whole thing before every line.

## Using it

- Open the **Notebook**, then **Library**.
- **Add a document**: choose a plain text file (`.txt`, `.md`, `.fountain`...), give it a title and a line about what it is ("The screenplay of the first film"). A PDF or Word script needs saving as text first.
- **Channels**: tick the channels your partner may use it in (say, the fandom's RP channel). Tick none for everywhere. OOC channels can always use every document, since that's where you'd talk about it.
- **Search** the library yourself to see what your partner would find, and tap a result to read the passage (with Previous and Next).
- Tap a document to rename it, change its description or channels, or delete it.

Your partner needs a profile that can use tools (Settings → Profiles and roulettes). Their prompt lists the library's titles and descriptions, and asks them to look things up rather than guess. What they searched for and read shows under their message, like any other action ("⚙ Arlo searched "The Lighthouse" for "drowned bell", read passage 12").

## How it works

### Passages

A document is split into **passages** of about 1,500 characters, roughly a page (`splitPassages` in `src/library.ts`):

- Paragraphs are kept whole where they fit; a paragraph too long for one passage is split at sentence ends.
- **Headings** start a new passage (once the current one has some text): a screenplay's scene headings (`INT. LAMP ROOM - NIGHT`, `EXT.`, `INT./EXT.`), Markdown headings, and lines like `Chapter 12` or `Act II`. Each passage remembers the heading it's under.
- **Speakers**: in a script, a short line in capitals followed straight away by dialogue is a character cue (`KESTREL`, `ILSE (V.O.)`). Each passage remembers who speaks in it. Transitions like `CUT TO:` aren't speakers.
- Deep script indentation is compacted (every 5 spaces become 1, at most 4). The shape stays, so cues and dialogue still stand out, but it reads on a phone and costs fewer tokens.

### Search

Passages are indexed with SQLite's full-text search, **FTS5**, with Porter stemming: "drowning bells" finds "the bell drowned". A search (`Library.search`):

- matches **any** of the words, with passages matching more of them ranked higher (BM25);
- keeps `"quoted phrases"` together, for an exact line;
- drops common words ("the", "what", "was");
- never passes FTS5's own syntax through, so any text is a safe query;
- weighs **speakers** most, then **headings**, then the text. So "Gandalf Bag End" puts scenes where Gandalf speaks at Bag End first.

Each result is a document, a passage number, its heading, and a snippet with the matches marked.

A feature-length script (about 170,000 characters, 400 passages) is split and indexed in under a tenth of a second, and a search takes a few milliseconds, on a desktop.

### Your partner's tools

| Tool | Does |
| --- | --- |
| `search_library` | `query`, and optionally one `document`: the best 6 passages, each with a snippet |
| `read_library` | `document` and `passage`, and `count` (1 to 3): passages in full, and the next passage number |

Both are only offered when the library has something for the channel. Documents are named by title (a unique part of one works too). Mistakes are explained back ("There's no document called "Hamlet" here. The library has: ..."), as with every tool.

## Where it's stored

Migration 9 in `src/db.ts`:

| Table | Holds |
| --- | --- |
| `library_docs` | Each document: title, description, the channels it's limited to (a JSON list), its length and passage count |
| `library_passages` | Each passage: its document, number, heading, speakers and text |
| `library_fts` | The FTS5 search index over the passages' headings, speakers and text. It reads the text from `library_passages` rather than keeping a second copy |

Deleting a document deletes its passages and removes them from the index. Deleting a channel takes it off any document limited to it.

A document can be up to 5,000,000 characters.

## API

- `GET /api/library`: the documents.
- `POST /api/library` with `title`, `content`, and optionally `description` and `channelIds`: add a document.
- `PATCH /api/library/:id`: change its `title`, `description` or `channelIds`.
- `DELETE /api/library/:id`: delete it.
- `GET /api/library/search?q=...` (and `&doc=id` for one document): up to 20 results.
- `GET /api/library/:id/passages/:seq?count=n`: passages in full, up to 10 in a row.

## Tests

`test/library.test.ts`:

- splitting: headings, cues, scripts, long prose, and text without punctuation;
- queries: phrases, stopwords, FTS5 syntax;
- stemmed search, with speakers ranking first, limited to some documents, and forgotten on deletion;
- channels;
- both tools, and their mistakes;
- the prompt: listed with tools, never the text itself;
- the API.

The library dialog, adding a file, searching and reading were checked in a real browser on a phone-sized screen.
