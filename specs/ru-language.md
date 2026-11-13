# Icarus's Russian: whose problem is it and what to do about it

A branch about the quality of Russian, 2026-09-20. The occasion — Icarus's reply about the security check at the entrance
to the consulate: superficially fluent, but with calques («где реально стоит держать голову» [where you really ought to keep your head],
«в чужие руки вне процедуры» [into someone else's hands outside the procedure], «в своей же стране проживания на ирландской земле» [in your own country of residence on Irish soil])
and with phrases that fall apart in meaning («голос не тот, за который стоит терпеть шмон» [not the voice worth enduring a shake-down for]).

## The short answer

This is not "DeepSeek can't do Russian" and not pure coincidence. Three layers converge:

1. **The model.** For DeepSeek English and Chinese are native; Russian is a second tier
   ("strong, with light review", not production-grade). The gap from the Western flagships
   on Russian text is measurable, but not catastrophic.
2. **The mode.** Enabled thinking eats up the budget and cuts the Russian reply off mid-word;
   the officially recommended `temperature` 1.3 for conversation in Russian wrecks the morphology.
3. **The persona.** `icarus.md` demands short replies packed with idiom, slang and jabs.
   This is exactly the register where a second-tier model starts **inventing** turns of phrase instead of
   knowing them. The denser the requirement for "liveliness" on compressed text, the more calques.

So "google it and change the model" is half the answer. The other half is cheaper and lies in the repository.

## What it was checked with: a run of `probe-ru.mjs`

The script `tools/persona-flywheel/probe-ru.mjs` takes the production `icarus.md`, one question
(the very one about the consulate) and runs the "model × mode × prompt edit" variants.
The full replies are in `tools/persona-flywheel/logs/ru-probe-*/samples.md`.

### Thinking on (the API default), `max_tokens: 400`

| variant | what came out |
| --- | --- |
| flash | 1501 tokens went into hidden reasoning; visible text ~99 tokens, cut off at «Это стандарт любого административного» [This is the standard of any administrative…] |
| pro | the same, cut off at «но право у них есть, если им что-то» [but they do have the right, if they have something…] |

The conclusion is blunt: **in Russian, with thinking on, Icarus's reply gets cut off** — while `icarus.md`
explicitly forbids cutting off. For the fast tier thinking is off, but escalation to strong goes to
`deepseek-ai/DeepSeek-V4.1-Flash:medium` — that is, precisely where the answer is longer and more complex, a cutoff is likely.
This is a separate routing bug, unrelated to language quality.

### Thinking off (the production fast mode)

| variant | Russian |
| --- | --- |
| flash, t=1 | even, simple, at times flat: «открытая сумка, закрытый телефон, ровный тон» [open bag, closed phone, even tone] |
| flash, t=1.3 | **the worst of all**: «ссыльного спора не заводишь», «киоск с оружием», «переведи в режим, где листать нечего» — invented turns of phrase and lost meaning |
| flash, t=1 + the «Русский» [Russian] block | cleaner and more idiomatic: «Требование обычно рассыпается» [The requirement usually falls apart], the closing question to the interlocutor to the point |
| pro, t=1 | composed, but with strained irony («гражданин с активной позицией» [a citizen with an active stance]) |
| pro, t=1 + the «Русский» block | the cleanest of the five, but the opening «открой закон» [open the law] is a factual invention of its own |

Two honest caveats. First: with one sample per variant the conclusions are not statistics;
the staging bench is noisy ±1.5 per scenario. Second: **that very quote could not be reproduced** — five
clean runs produced noticeably more decent Russian. So the reply shown is a worst case,
but it is precisely such worst cases that a person actually sees.

Still, two effects are visible at once: `t=1.3` for Russian is harmful advice, and an explicit block about
Russian in the persona changes the text for the better on the same model and the same temperature.

## Why this is so, according to external data

- DeepSeek is **bilingual-first**: the training corpus is skewed toward English and Chinese, Russian
  is placed in the second tier, the typical failure is sliding into English and English-like syntax
  ([DeepSeek languages](https://deepseekai.guide/guides/deepseek-languages/)).
- An independent comparison on MERA and LLM Arena RU puts
  GPT-5.4 in first place for Russian text, and rates DeepSeek at 85–90 % of it — cheap and decent, but not "like a native"
  ([a comparison of 8 models](https://ofox.ai/ru/blog/luchshaya-llm-dlya-russkogo-yazyka-sravnenie-2026/),
  [MERA](https://mera.a-ai.ru/), [LLM Arena RU](https://llmarena.ru/)).
- Russian morphology (6 cases, verb aspect, free word order) plus a **tokenization tax**:
  Cyrillic costs noticeably more tokens for the same meaning, that is, per word of Russian text
  the model has less budget and fewer chances to correct itself
  ([Tokenizer Tax Across 24 European Languages](https://arxiv.org/pdf/2605.24718)).
- Reasoning in models of this class runs in English and can bleed into the output —
  a well-known class of failures ([Language Mixing in Reasoning LMs](https://aclanthology.org/2025.emnlp-main.132.pdf)).

## What to do, in decreasing order of payoff

### 1. Make the defects visible: a language axis in the rubric and a judge outside the DeepSeek family

Right now `criteria.md` contains not a single criterion about Russian: there is N ("naturalness"), but it
is about the service tone, not about calques and cases. The judge and the critic are `deepseek-ai/DeepSeek-V4-Pro-0813`, that is, **the same
family, with the same blind spot**: "avg 8.80" on the bench and a calque in production do not contradict each
other. This is the most costly hole: without it, any edit is checked blind.

The minimal step is a seventh axis (text to paste into `criteria.md`):

```markdown
## Я — Русский язык (0–10)
- 9–10: живая идиоматика носителя; ни одной кальки, ни одного выдуманного оборота;
  падежи, вид глагола и согласование чисты.
- 6–7: грамматика чистая, но фразы звучат как подстрочник; один-два натянутых оборота.
- 3–5: калька с английского («держать голову», «вне процедуры»), выдуманный сленг,
  оборот, который рассыпается по смыслу.
- 0–2: смысл фразы не восстанавливается; грубые морфологические ошибки.
Проверка: переведи реплику обратно на английский. Если получается гладкий английский,
а русский звучит странно — это калька, выше 5 не ставить.
```

And the judge — to a model from another family (if a key is available), at least in the duels. Otherwise the rubric
will keep confirming itself.

### 2. Three lines about Russian in `icarus.md`

The edit was verified by a run (the `flash-off-ru` variant), it fits within the 90-line budget:

```markdown
# Русский
- Думаешь по-русски, а не переводишь с английского. Оборот, который звучит как подстрочник, — брак.
- Идиоматику берёшь только ту, в которой уверен. Сомневаешься в слове или обороте — берёшь простое.
- Перед отправкой проверяешь падежи, вид глагола и согласование: ошибка хуже пресной реплики.
```

The third line is not decoration: the persona's first rule («перечитай, что написал» [reread what you wrote]) already exists,
but there is not a word about language there.

### 3. Do not enable thinking on persona replies

Thinking on a Russian reply causes a cutoff and a fourfold bill. If escalation to
`deepseek-ai/DeepSeek-V4.1-Flash:medium` is needed for tools and analysis, then Icarus's final text is better
given to a model without thinking — or sharply raise the output ceiling.

### 4. Routing: don't send Icarus's reply to the cheapest tier

Replies are short (1–4 phrases), so the price difference between flash and pro on them is pennies,
while pro's Russian quality in the run is higher. The idea "keep persona text on pro and routine on flash"
is economically almost free. An alternative for those who specifically care about Russian is to keep
one Western model (GPT/Gemini/Claude) only for the final text, and DeepSeek for the tools.

### 5. Two-pass, if you want to squeeze out more

Draft — flash, edit — a stronger model with the instruction «убери кальки, проверь падежи» [remove the calques, check the cases].
Twice as expensive per reply, so only for long answers where the calque is more noticeable.

### What, conversely, will not help

- **Lowering the temperature by itself.** t=0.6 gave no qualitative leap, t=1.3 gave a clear
  regression. Turning the temperature knob is no substitute for editing the prompt and choosing the model.
- **Asking it to «думать по-русски» [think in Russian].** Reasoning goes into English anyway, and the visible text
  does not benefit from it — it benefits from banning calques and from checking before sending.
- **Fine-tuning/LoRA for Icarus's style.** Expensive, slow, and it treats the wrong disease: the model has a deficit
  of Russian idiom, not of knowledge about the character.

## Run artifacts

- `tools/persona-flywheel/probe-ru.mjs` — the probe itself, run as `node probe-ru.mjs [flash|pro]`.
- `tools/persona-flywheel/lib/api.mjs` — an optional `extra` was added to `chat()`
  (needed for `thinking: {type}`); the default behavior did not change.
- `tools/persona-flywheel/logs/ru-probe-2026-09-201405/` — the run with thinking (cutoffs).
- `tools/persona-flywheel/logs/ru-probe-2026-09-201407/` — production mode, five variants.

## A Chinese word in a Russian phrase (08.11.2026)

The occasion — a greeting in the panel: «Воскресенье, день —理论上 время для подвигов, а на деле
для дивана» [Sunday, a day — 理论上 [theoretically] a time for feats, but in reality for the couch]. This is neither a translation nor a calque: the Chinese 理论上 ("theoretically") took the place of
a Russian word, while the sentence itself remained Russian.

**Where it comes from.** The same root as the calques, only deeper: for DeepSeek Chinese is native, and
when there is no ready Russian word at hand, a Chinese one is substituted. It is not memory and not the
prompt: there is no Chinese in the persona, AGENTS.md, memory or the service logs — verified with `grep` over
CJK ranges. Nor is it a code bug: the text comes from the model as is.
Thinking is irrelevant — the reply is from the fast tier (`deepseek-v4-flash`), where it is off.

**What was done.** The ban was added in two places where the model will definitely see it: a line on the
reply (`language.ts`, `languageOverride`) and the persona's «Язык» [Language] section (`icarus.md`).
A direct request («переведи на китайский» [translate into Chinese]) remains an exception — it is described in the
«Язык» section of AGENTS.md, and the same is said by the tail «кроме прямой просьбы» [except for a direct request] on the reply.

**There is no guarantee.** The prompt lowers the probability but does not cancel sampling. The hard option —
a second pass (rewriting the reply with a model that does not know Chinese) or a filter over
CJK ranges on the output: both cost latency on every reply and hurt legitimate
translation, so they are worth enabling only if the leak repeats.

## Open questions

- A scenario with dense idiom and "smart" content (law, politics) is not set apart in the bench —
  and that is precisely where the calque crawls out. It seems worth adding a probe scenario like "legal advice".
- It has not been checked how escalation behaves in the service: if `deepseek-ai/DeepSeek-V4.1-Flash:medium` actually
  truncates the answer, that is caught only on a live container, not on the bench.
