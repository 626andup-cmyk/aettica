# Jev audit: every guess Aettica makes, and who makes it

Jev (TypeSafe's decision model, see [stage 8](stage-8.md)) answers yes/no and multiple-choice questions with a probability. I went through every feature for the places Aettica *guesses*, and decided for each whether a Jev series should decide instead. A **series** is one question asked in two or three phrasings, all of which must agree (`askSeries` in `src/jev.ts`). I also looked at [Kitsikai](https://github.com/626andup-cmyk/kitsikai.)'s Jev uses for ideas.

The rule of thumb:

- **Jev decides** when a wrong guess costs something (a message you didn't want, a wrong fact spreading, something deleted) and the question is one of meaning, which plain rules can't answer.
- **Rules stay** where the input is exact syntax you type, where it's a preference or a limit you set, or where a model can't help (parsing formats, ranking search results).
- **Unsure always takes the safe path**, which is usually exactly what Aettica did before asking.

All the checks added here can be turned off with **Settings → Decisions (Jev) → Double-check with Jev** (`jevChecks`). Without Jev (and no fallback profile), everything works as it did before.

## Now decided by Jev

| Where | The question | Unsure means | Code |
| --- | --- | --- | --- |
| Wake-ups (stage 8) | Is this the moment to reach out? | Stay quiet | `src/wakeups.ts` |
| Wake-ups: which channel **(new, from Kitsikai)** | With several OOC channels: which one fits this message? (a choice, in the same call) | The one you used last | `src/wakeups.ts` |
| Notebook keeper | Was something new named? A lasting fact established? **Something contradicted (new, from Kitsikai's "does this take back the note?")**, each as a series. Then: is each drafted claim in the text? | Leave the notebook alone | `src/keeper.ts` |
| Comment replies **(new)** | Your comment on your own message: does it invite your partner's reply? | No reply (as before) | `wantsReply` in `src/judge.ts` |
| Your partner deleting their entry **(new)** | Is deleting it clearly wanted? (The only thing they can do that can't be undone.) | Held back, and they're told why | `confirmDelete` |
| Your partner editing *your* entry **(new, from Kitsikai's planner rule)** | Did you ask for this change? If not, it becomes a suggestion, even on entries open to them. | Suggestion | `userAskedFor` |
| Scene summaries **(new)** | Is everything in the summary supported by the scene? (A confident no rewrites it once, more strictly.) | Keep it | `faithfulSummary` |
| OOC channel mentions **(new)** | A channel named by a bare word ("story"): is the conversation really about that channel? | Include its summary (as before) | `aboutChannels` |

The notebook keeper also never changes your own entries directly now. Its notes on them are always suggestions, following Kitsikai's rule that nothing of yours changes on someone else's idea alone.

## Staying as rules, and why

| Where | What's decided | Why not Jev |
| --- | --- | --- |
| Wake-up limits: chattiness, quiet hours, cooldown, never twice unanswered, not mid-conversation | Whether an event counts at all | They're your settings and hard limits, not judgement. They're also checked first, so most events cost nothing |
| `=====` scene breaks, `[[Name]]` attachments, proxy tags (`k: text`), `Name: text` bubbles | What you meant by the syntax you typed | Exact syntax you chose; a model could only get it wrong |
| Tool calls written as text (Qwen, Kimi, DeepSeek formats) | Finding calls in a reply | Parsing a format; Jev can't read structure |
| `[nothing]` on a wake-up | Your partner chose not to write | An exact token they were told to use |
| Summaries: when each is due | Cost control | Counts and thresholds you set |
| Story so far and digests | Built from scene summaries | The scene summaries under them are checked; checking each layer again would repeat the cost |
| Library: headings, speakers, search ranking | Splitting and finding passages | Format structure, and FTS5 ranking; your partner decides *when* to search |
| Roulette picks | Which profile writes | Random by design |
| Your partner's other actions (pin, create or rename a channel, react, comment) | Whether to do them | That's their own judgement, the point of the tools. Each is visible under the message and reversible |
| Proposing to delete a channel, deleting your entries | Whether it happens | Already needs your approval (proposal, suggestion) |

## Considered, and left for later

- **Attaching notebook entries mentioned in OOC** (without `[[Name]]`): it would add a Jev call to the start of every OOC turn. OOC already lists the whole notebook, and your partner can read any entry with a tool.
- **Kitsikai's "would a text now interrupt a conversation?"**: wake-ups already skip "opened" within 30 minutes of the last message anywhere, and only other events (a scene you just ended, a suggestion) wake your partner otherwise.
- **Kitsikai's "did they already talk about this?"** (so a reminder isn't redundant): for the heartbeat's idea drawer, so an idea isn't brought up after you've already talked it through.

## Testing without Jev getting in the way

In the tests, the fake nanoGPT keeps Jev's requests and replies apart (`fake.jevRequests`, `fake.jevReplies`). With no reply queued, Jev answers every question 50/50 (unsure), so tests of other features see Aettica behave exactly as it did before these checks. `test/judge.test.ts` covers each check both ways, `test/keeper.test.ts` covers contradictions and suggestions on your entries, and `test/wakeups.test.ts` the channel pick.
