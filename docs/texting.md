# Texting in OOC, and a random partner

Two endgame features from [DESIGN.md](../DESIGN.md): out-of-character chat that feels like texting (borrowed from Kitsikai), and "Surprise me", which invents a new partner.

## Texting in OOC

- **Your partner texts in bursts.** A reply in an OOC channel comes as a few short texts ("omg wait", "you actually said that??", "legend") instead of one paragraph. They arrive **one at a time**, with "Arlo is typing…" between them; a longer text takes longer to type. **Double-tap "typing…"** to see the rest straight away.
- **Each thing you send is its own text**, and your partner **waits until you pause** (2.5 seconds by default, and longer while you're still typing) before answering all of them in one reply. So you can send "hey", then "guess what", then the news, and they answer the whole thing.
- Turn it off, or tune it, in the **partner menu** (tap the partner card) → **Texting in OOC**: how long a pause is, and the typing speed. Roleplay channels are never affected.

### How it works

`src/texting.ts`:

- The OOC prompt asks the model to put `<cht>` between separate texts (`TEXTING_STYLE`). The reply is split there into separate messages, all in one turn, so regenerating replaces the whole burst. The splitter forgives `<CHT>`, `< cht >`, `</cht>` and `<cht/>`.
- In the conversation the model reads (`toChatHistory` in `src/prompt.ts`), your partner's texts are joined with the marker, so it keeps writing that way. Yours are joined one per line.
- A comment reply is a single note: any markers in it become line breaks.
- Your texts are sent with `reply: false` (saved, no turn). The app starts a timer (`replyDelayMs`), restarts it when you send again or type, and then asks for a partner turn. Leaving the channel with the timer running asks for the reply at once.
- The reveal is in the app only. All the texts are saved as soon as the reply is written; the first shows at once, and each next one after `typingBaseMs + characters × typingPerCharMs` (600 ms + 40 ms per character by default, Kitsikai's numbers). History, your own messages, and texts that arrive while you're elsewhere always show at once. Live updates wait until a reveal (or a pause) is over.

| Setting | Default | What it does |
| --- | --- | --- |
| `oocBubbles` | on | Texting in OOC |
| `replyDelayMs` | 2500 | How long your partner waits after your last text (0: answer each at once) |
| `typingBaseMs`, `typingPerCharMs` | 600, 40 | How long a text takes to "type" |

## RNG partner creation

**🎲 Surprise me** invents a new partner: a name and a "who your partner is" description. In the partner menu it rerolls the open partner; in **+** (a new server) or **Add a partner here**, it fills in the new partner. It fills in the form; nothing changes until you press **Save**, so roll as often as you like.

Asking a model for "a random character" gets the same few every time, so the randomness comes from Aettica (`src/rng.ts`). It picks a temperament, a way of talking, two interests, a quirk and two kinds of story they love from lists, and the model (the profile that writes OOC, at a high temperature) turns them into one believable person. The ingredients are shown under the button ("Meet Wren (dry and deadpan; quotes old films; ...)").

`POST /api/partner/random` returns `{name, prompt, seeds}`. A reply without both a name and a description is an error you can retry.

## Tests

`test/texting.test.ts`:

- splitting texts;
- a reply becoming several messages in one turn;
- the prompt asking for texts and showing past ones with the marker (and not in roleplay, or when off);
- comment replies without markers;
- `reply: false`;
- settings;
- random seeds, a random partner from a fake model (not saved), and a messy answer.

In a real browser: two quick texts got one reply, which appeared text by text with "typing…", and a double-tap skipped the rest. Surprise me filled in a new partner.
