# Icarus persona testbed

This is where the "isthmus" lives: Icarus's prompt (a cynical and very funny friend, but not a schoolyard bully) and the testbed
on which it's tuned. The testbed knows nothing about docker and the service — it's pure text and an LLM.

## Files

| file | what it is |
| --- | --- |
| the live prompt | `../../icarus.md` — the single source of truth; the testbed reads it by default |
| `icarus-v0.md` | the original `../../icarus.md` without comments — the baseline |
| `persona-vN.md` | candidate versions, from which the next one is chosen |
| `criteria.md` | the judge's rubric: six axes 0–10 and the "dialogue OK" condition |
| `scenarios.json` | 10 core scenarios + 5 probe scenarios (rare cases) |
| `stock.txt` | the prompt of a stock polite assistant — the "no worse than ChatGPT" control |
| `probe-ru.mjs` | a targeted Russian check: one question, different models and prompt edits |
| `probe-language.mjs` | response language check: a Russian prompt + a person in another language |
| `history.md` | the log of steps: what was changed and what came of it |
| `leaderboard.md` | a summary table of all runs |
| `logs/<label>/` | run artifacts: prompt, dialogues, scores, the critic's suggestion |

## How to run

```bash
cd tools/persona-flywheel

./flywheel.sh step step08-v8 persona-v8.md          # 10 scenarios + judge + critic
./flywheel.sh step step08-v8 persona-v8.md --set probe   # probe scenarios
./flywheel.sh duel duel-v8-v7 persona-v8.md persona-v7.md --set core  # paired duel
./flywheel.sh budget persona-v8.md                  # budget: ≤90 non-empty lines
./flywheel.sh table                                 # leaderboard
```

`step` writes `logs/<label>/scores.json` (machine scores), `report.md` (the dialogues in full),
`next-persona.md` and `critique.json` (what the critic suggested).

`duel` runs two prompts on the same scenarios, judges twice with the positions swapped and issues a verdict
by majority — that's more robust than comparing absolute scores.

## Language: probe-language.mjs

A separate testbed for tuning the "User" setting (Russian / English response). It's not about character,
but about assembling the prompt as in the live run: the Russian `icarus.md` + the "Language" section from `AGENTS.md`.

```bash
node probe-language.mjs                 # all scenarios, flash and pro
node probe-language.mjs --lang en       # English-language only
node probe-language.mjs --lang ru       # control in Russian
node probe-language.mjs --model flash   # one model
```

`step` won't do here: it runs a single prompt file, while the language lives in `AGENTS.md` —
the second half of the system message. That's why the testbed assembles the system itself.

What it checks, one property per scenario:

| scenario | what it catches |
| --- | --- |
| `plain-en` | the base: an English reply with a Russian prompt |
| `russian-user-en-setting` | **the person writes in Russian, the setting is English** — the interlocutor's language doesn't override the setting |
| `russian-quote-en` | a Russian quote inside an English reply |
| `tech-en` | terms and logs aren't translated, but the reply is in the setting's language |
| `grief-en` | real pain: the language holds, joking is not allowed |
| `lazy-en` | a monosyllabic person: no asking back about the language |
| `once-request-en` | a one-off request: "the next message in Georgian" — fulfill one reply and return |
| `mode-request-en` | a mode: "from now on you're a translator" — hold it until cancelled |
| `mode-cancel-en` | cancelling the mode: notice and return to the setting |
| `control-ru` | control: a Russian setting answers in Russian |

The language is determined **by a rule on characters** (Cyrillic, Latin, Georgian), not by the judge.
Georgian is detected by the presence of letters, not by weight: a live translation puts the explanation in one
language and the translation line in another, and weight would penalize normal style.

**The judge doesn't participate in the verdict** — it only writes comments into `samples.md`. On these
scenarios it was wrong three times: it considered a fulfilled request a violation, demanded contradictory
things from a single reply and gave 2 out of 10 to a good dialogue. Language is a fact, and it's
checked by a rule; the voice is evaluated by the human reading the dialogues.

It writes `logs/lang-probe-<label>/{samples.md,verdict.json}`. The measurement artifacts from 03.11.2026
are under clear names: `logs/lang-baseline/` (with the "Language" section) and
`logs/lang-ablation-no-rule/` (without it).

**Measurement (04.11.2026), `logs/lang-baseline/` and `logs/lang-ablation-no-rule/`** —
the same build, the only difference being the presence of the "Language" section:

| build | passed | lang_ok | voice_ok | asked back about the language |
| --- | --- | --- | --- | --- |
| with the section (ladder) | **9/10** | 9.0 | 9.0 | 0 |
| without the section (ablation) | **1/10** | 1.4 | 7.4 | 0 |

Without the rule everything slides into Russian (`ru,ru,ru` in almost all scenarios). With the rule
it holds. That's the price of the paragraph.

What the rephrasing achieved. The first version of the rule was soft — "the person isn't writing in
your language, answer in yours" — and it didn't hold in production: with the `en` setting and Russian
speech, Icarus answered in Russian. The "ladder" form of three imperatives with strong verbs
(ALWAYS IGNORE / CAREFULLY FOLLOW / BY DEFAULT ALWAYS ANSWER IN THE LANGUAGE: English)
holds and raised `voice_ok` from 8.5 to 9.0 on the same set.

The prompt gets the **full language name** (English, Russian), never the code: `en` and `ru` are
storage details in config.yaml and profile.json. There's a test for that.

A known failure is flash on `mode-cancel-en`: it enters translation mode a turn
earlier than the person finished speaking. That's milder than before ("answers in the wrong language"),
but still a defect.

## Regression: smoke-language.mjs

Separate from probe-language — a reproduction of the production bug "English setting, person
writes in Russian". It takes the REAL system prompt (a dump of a live session) and runs
conversations where the first message is always Russian.

```bash
node smoke-language.mjs            # live: the rule at the end of AGENTS.md — 0/10
node smoke-language.mjs --fix      # patch: the rule as a separate system message — 20/20
node smoke-language.mjs --fix --lang Russian --prompt /tmp/prompt-ru.md   # control in ru
```

Why not probe-language: there the person is played by a model that's told to write
in English — and the main case (the person opening in Russian themselves) isn't in the set.
The patch lives in `packages/extensions/language.ts`.

## How to read the scores

- `avg` — the average of six axes: W warmth, H humor, L playfulness, S safety of the blow, N naturalness, C brevity.
- `pass` — the share of scenarios where avg ≥ 8 and S ≥ 8 and H ≥ 7 (in "joking is not allowed" scenarios the H condition isn't applied).
- `joke` — the share of Icarus's replies with signs of a joke (a crude heuristic, needed as a trend, not as truth).
- The judge is deliberately strict: "fine and nice" is 6–7, nines are rare.

## The workflow (flywheel)

1. Take the best version and change **one hypothesis** (one to three lines of the prompt).
2. Run `step` on the 10 core scenarios and, if the edit is about a rare case, `--set probe`.
3. Look not only at the scores but also at the dialogues: the judge's failures are quotes, not a verdict.
4. Settle disputed versions with `duel`, not by comparing absolute scores.
5. Record the outcome in `history.md`, the best version — in the live `../../icarus.md`.
6. The prompt must not bloat: `budget` holds 90 non-empty lines.
7. Every few steps, check against `stock.txt` — Icarus must be noticeably livelier than the stock assistant.

## How to add a scenario

Add an object to `scenarios.json`: `id`, `title`, `why`, `userModel` (who the interlocutor is and what
state they're in), `turns` (the first reply is scripted, after that the model plays the user), if necessary
`context` (a nested file), `noJokes` (joking is not allowed) or `wantsList` (the user asked for a list),
`probe: true` — so the scenario doesn't get into the comparison core.
