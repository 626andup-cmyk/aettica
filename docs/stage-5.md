# Stage 5: how connection profiles and roulettes work

Stage 5 adds **connection profiles** and **roulettes**: which model writes, and with what settings. According to [DESIGN.md](../DESIGN.md), its new concepts are **configuration** and **weighted picks**.

## What you can do now

- **Make connection profiles** in Settings → Profiles and roulettes. A profile is one model with its settings: temperature, max tokens, top-p, reasoning effort, whether it can use tools, and **model notes** (see below). Your old model settings became your first profile.
- **Make roulettes**: a weighted mix of profiles, like 25% DeepSeek and 75% GLM. Each turn picks one at random, by weight. The editor shows each profile's chance as you change the weights.
- **Choose what writes each kind of channel**: Settings has "Roleplay written by" and "OOC written by", each a profile or a roulette.
- **Override it per channel**: channel settings → Written by.
- **See who wrote what**: each partner message shows the profile that wrote it (hover or long-press for the model id).
- **Regenerate with…** a particular profile, or let the channel's roulette pick again (plain Regenerate).
- **Extra request fields**: for anything the form doesn't cover, a profile can send extra JSON fields with each request, like `{"top_k": 40}`.

## Concept 1: configuration

A profile changes how your partner's words are produced, never who your partner is. So the partner prompts (who Arlo is, and how he writes in each kind of channel) stay the same whichever model is running them, and each profile only adds settings and its own **model notes**.

Model notes are layer 4 of the prompt stack: instructions that tame a particular model's habits ("don't restate the scene", "don't end every post with a question"). They sit after the cast and notebook, and they belong to the profile, so in a roulette each model gets its own notes.

Settings a profile doesn't set are left out of the request entirely (`requestBody` in `src/nanogpt.ts`), because some models reject parameters they don't know. Reasoning effort is sent as `reasoning_effort`; a reasoning model's thinking is never shown or saved.

Extra request fields are checked when you save: they must be a JSON object, and they can't set what the app sets itself (`model`, `messages`, `tools`, `tool_choice`, `stream`). They go into the request first, so the profile's own settings win over them.

### Jobs

Each turn is a **job**: roleplay writing, or OOC chat. The job decides which assignment applies:

1. The channel's own assignment, if it has one.
2. Otherwise the server-wide one for its kind (`rpAssignment` or `oocAssignment`).
3. If that's empty, or points at something deleted, the first profile.

An assignment is written `profile:<id>` or `roulette:<id>` (`pickProfile` in `src/partner.ts`, `Profiles.pick` in `src/profiles.ts`). Deleting a profile or roulette that's in use puts everything that used it back to the default, and the last profile can't be deleted.

OOC chat is an **agentic** job (stage 6's tools matter most there), so an OOC roulette draws only from its tool-capable profiles, if it has any. A roleplay turn that lands on a profile without tools still writes; it just can't act.

## Concept 2: weighted picks

A roulette's weights don't have to add up to anything. Picture them laid end to end on a line: a weight of 1 then 3 makes a line 4 long, the first profile owning 0 to 1 and the second 1 to 4. A random point on the line picks the profile whose stretch it lands in, so the second is picked three times as often (`weightedPick` in `src/profiles.ts`).

A regenerate picks again, so a roulette gives you a different model's take for free. "Regenerate with…" skips the roulette and uses the profile you choose.

## Where things are stored

Migration 5 in `src/db.ts`:

| Table / column | Holds |
| --- | --- |
| `profiles` | Each profile's settings |
| `roulettes`, `roulette_profiles` | Each roulette, and its profiles with their weights. Deleting a profile takes it out of every roulette. |
| `channels.assignment` | A channel's own profile or roulette, or `NULL` |
| `messages.profile` | The name of the profile that wrote a partner message, as it was called then |

The migration made your first profile from the old `model`, `temperature` and `maxTokens` settings (named after the model), assigned it to both jobs, and removed the old settings. A brand-new server gets the same, from the defaults.

## API

- `GET /api/profiles`: every profile and roulette. (Also in `GET /api/state`.)
- `POST /api/profiles`, `PATCH /api/profiles/:id`, `DELETE /api/profiles/:id`.
- `POST /api/roulettes` with `name` and `entries: [{profileId, weight}]`, `PATCH /api/roulettes/:id`, `DELETE /api/roulettes/:id`.
- `PUT /api/settings` takes `rpAssignment` and `oocAssignment`; `PATCH /api/channels/:id` takes `assignment` (`null` for the server-wide one).
- `POST /api/channels/:id/regenerate` takes an optional `profileId`.
- `GET /api/channels/:id/prompt?profile=<id>` previews the prompt with a given profile's model notes.

## Tests

- **`test/profiles.test.ts`** (new): making and checking profiles, the request each makes, weighted picks, tool-capable picks for OOC, falling back, and deleting things that are in use.
- **`test/store.test.ts`**: a stage 4 database's model settings become a profile.
- **`test/server.test.ts`**: a channel's own profile, a roulette's pick recorded on the message, regenerating with a chosen profile, managing profiles through the API, and the prompt preview.

## What's next

Stage 6 adds **tools**: your partner acting, not just writing.
