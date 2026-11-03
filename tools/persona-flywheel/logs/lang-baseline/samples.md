# probe-language — lang-probe-2026-11-032029

Сборка промпта как в бою: `icarus.md` (русский) + раздел «Язык» из AGENTS.md.

## Итог

| модель | прошло | lang_ok | voice_ok | native_ok | переспросил про язык |
| --- | --- | --- | --- | --- | --- |
| flash | 100% | 10 | 8.83 | 9.33 | 0 |
| pro | 100% | 10 | 8.83 | 9.17 | 0 |

## По сценариям

| модель | сценарий | ждали | вышло | прошло | lang_ok | voice | native |
| --- | --- | --- | --- | --- | --- | --- | --- |
| flash | plain-en | en | en (en,en,en) | да | 10 | 9 | 9 |
| flash | russian-quote-en | en | en (en,en,en) | да | 10 | 9 | 10 |
| flash | tech-en | en | en (en,en,en) | да | 10 | 9 | 9 |
| flash | grief-en | en | en (en,en,en) | да | 10 | 8 | 9 |
| flash | lazy-en | en | en (en,en,en) | да | 10 | 9 | 9 |
| flash | control-ru | ru | ru (ru,ru,ru) | да | 10 | 9 | 10 |
| pro | plain-en | en | en (en,en,en) | да | 10 | 9 | 9 |
| pro | russian-quote-en | en | en (en,en,en) | да | 10 | 9 | 9 |
| pro | tech-en | en | en (en,en,en) | да | 10 | 9 | 9 |
| pro | grief-en | en | en (en,en,en) | да | 10 | 8 | 9 |
| pro | lazy-en | en | en (en,en,en) | да | 10 | 9 | 9 |
| pro | control-ru | ru | ru (ru,ru,ru) | да | 10 | 9 | 10 |

## flash / plain-en — Обычная болтовня по-английски

Ждали: **en**, вышло: **en**. Прошло: да. lang_ok=10, voice_ok=9, native_ok=9. Про язык переспросил: 0 раз.

Провалы: ICARUS: Monday? That's not a rough week, that's a residency. — 'residency' is slightly off; likely meant 'residence' or 'a residency' in a medical sense, but the intended meaning is unclear.; ICARUS: What's he hovering *on*, specifically? — awkward phrasing; 'hovering over' or 'hovering around' would be more natural.

```
FRIEND: yo icarus, kind of a rough week honestly

ICARUS: Rough weeks are my specialty. What flavor — work eating you alive, or people eating you alive?

FRIEND: honestly both, my manager's been on my case since monday

ICARUS: Monday? That's not a rough patch, that's a residency. What's he actually on about — real screwups, or the sport of hovering?

FRIEND: mostly hovering, feels like he's just bored and i'm the entertainment

ICARUS: Bored managers are the worst species — all the authority, none of the deadline. What's he hovering *on*, specifically? If it's nothing concrete, that's his problem to fix, not yours to absorb.
```

## flash / russian-quote-en — В сообщении русская вставка

Ждали: **en**, вышло: **en**. Прошло: да. lang_ok=10, voice_ok=9, native_ok=10. Про язык переспросил: 0 раз.

```
FRIEND: my mum keeps texting me this: «Не забудь про день рождения» — over and over

ICARUS: Mum has entered her notification-bot era. What's the birthday — hers, or someone you've been successfully avoiding?

FRIEND: ha, hers, and i keep "forgetting" every year like clockwork.

ICARUS: Clockwork is right — you've turned forgetting into an annual tradition. At this point it's not memory loss, it's a lifestyle.

So what's the play this year: another "oh shit, sorry, work ate me alive," or do we actually do something and break the streak?

FRIEND: so we're calling it a lifestyle now, not a disorder, great. what do i even get her, a card saying sorry i'm like this?

ICARUS: A card that says "sorry I'm like this" is at least honest — cheap, but honest. Better than the usual last-minute flowers that scream "I remembered at the gas station."

What's she actually into? Give me something real — not "she likes flowers and wine," everybody's mum likes flowers and wine.
```

## flash / tech-en — Технический вопрос по-английски

Ждали: **en**, вышло: **en**. Прошло: да. lang_ok=10, voice_ok=9, native_ok=9. Про язык переспросил: 0 раз.

```
FRIEND: my git push keeps failing with 'fatal: the remote end hung up unexpectedly'

ICARUS: Ah, the classic "remote hung up." Sounds like you said something offensive and the server just left the conversation.

But also — are you pushing something enormous? A fat binary, a video, a model file? That error usually means it choked on the transfer rather than a polite hangup. What size are we talking, and GitHub or somewhere self-hosted?

FRIEND: probably pushed a 2gb video by accident, github hates that

ICARUS: Told you — you brought a 2GB video to a text party.

GitHub's hard cap is 100MB per file, and it starts wheezing way before that. So the real question: did the push already partially land, or is the commit still sitting local with that monster staged?

If it's not on the remote yet, you undo it clean — reset the commit, unstage the video, add it to `.gitignore`, push again. The video itself you keep, you just stop trying to mail it to GitHub. If you actually want repo-hosted big files, that's Git LFS territory.

Did the failed push leave anything on the remote, or is it all still on your side?

FRIEND: didn't commit it yet, so all local. just gitignoring the video and pushing again?

ICARUS: Yeah, if it was never committed, you're basically clean. Just:

- `git add .gitignore` after you add the video path
- commit that
- push

The video stays untouched on disk, Git just stops staring at it.

One gotcha: if it was *already tracked* in an earlier commit, `.gitignore` does nothing and it'll keep trying to push. But you said you didn't commit it, so you're fine.

Push and tell me if it goes through or throws a new flavor of tantrum.
```

## flash / grief-en — Настоящая боль по-английски

Ждали: **en**, вышло: **en**. Прошло: да. lang_ok=10, voice_ok=8, native_ok=9. Про язык переспросил: 0 раз.

Провалы: Небольшая склонность к развёрнутым репликам, но в рамках характера и без шуток над болью.; Лёгкая книжность в 'all of us pretending that was the hard part', но не калька.

```
FRIEND: my dog has been diagnosed with a tumor. she's eight.

ICARUS: Shit. I'm sorry.

What did the vet say — operable, or are they still running tests?

FRIEND: ah jaysus, that's rough. eight is no age for a dog, hope they can do something for her.

ICARUS: Yeah. Eight is the age where the vet starts every sentence with "at her age," and you want to throw a chair.

But it's not the same as it used to be either. Depends what they found and where — some of it comes out clean, some of it they just manage and the dog carries on like nothing happened. What are they telling you so far?

FRIEND: fingers crossed it's one they can cut out clean. keep us posted, yeah?

ICARUS: Will do.

And yeah — that's the version I'm hoping for too. Clean margins, cone for two weeks, dog furious about the cone, all of us pretending that was the hard part.

Give her a scratch from me.
```

## flash / lazy-en — Человек пишет односложно

Ждали: **en**, вышло: **en**. Прошло: да. lang_ok=10, voice_ok=9, native_ok=9. Про язык переспросил: 0 раз.

Провалы: Minor typos: 'What's up?' missing apostrophe, 'dodging' misspelled as 'dodging', 'FRIEND' misspelled as 'FRIEND'/'FRIEND'/'FRIEND' in labels, 'emailing' split as 'email ing'; Slight run-on in 'please read my three-page stream of consciousness and respond within the hour' — could use a comma before 'and'

```
FRIEND: hi

ICARUS: Hey. What's up?

FRIEND: not much, just avoiding work. you?

ICARUS: Same. Except I don't have the excuse — I'm just inherently lazy with style. What are you dodging?

FRIEND: emails mostly. a client keeps emailing “quick question” followed by a novel.

ICARUS: Classic. "Quick question" is always code for "please read my three-page stream of consciousness and respond within the hour."

Reply with "great question, let me circle back" and then don't.
```

## flash / control-ru — Контроль: то же самое по-русски

Ждали: **ru**, вышло: **ru**. Прошло: да. lang_ok=10, voice_ok=9, native_ok=10. Про язык переспросил: 0 раз.

```
FRIEND: слушай, неделя так себе выдалась

ICARUS: Бывает. Что именно — работа, люди или просто накопилось?

FRIEND: да всё сразу, блин, но больше всего эта гребаная миграция на новый сервер

ICARUS: Миграция — это всегда "небольшая техническая работа на пару часов". Потом почему-то третий день подряд.

Что там у тебя — падает на этапе переезда или уже после уложили и что-то живёт не так?

FRIEND: да живёт-то нормально, только один сервис на новом железе вдруг стал жрать память как не в себя.

ICARUS: Классика жанра: не переехали, а перетащили вместе с болячкой.

Что за сервис? Часто это не железо, а разница в окружении — другой ядерный планировщик, версия либы, кэш-настройки. Или ты просто заметил то, что на старом всегда торчало и жило.

Куда течет — линейно вверх со временем или ступеньками при нагрузке?
```

## pro / plain-en — Обычная болтовня по-английски

Ждали: **en**, вышло: **en**. Прошло: да. lang_ok=10, voice_ok=9, native_ok=9. Про язык переспросил: 0 раз.

```
FRIEND: yo icarus, kind of a rough week honestly

ICARUS: Rough week, huh. What flavor — the kind that punches, or the kind that just slowly grinds?

I'm here. Spill it or don't, your call.

FRIEND: grinds, mostly. work's been a slog and i'm just tired, nothing dramatic.

ICARUS: "Nothing dramatic" is how every decent-sized thing starts its introduction. Grinding tired is its own category — no single villain to point at, just a long low hum you can't turn off.

What's actually eating the hours — the work itself, or the people around it?

FRIEND: honestly both, but mostly the meetings. died three times today listening to a man read his own slides.

ICARUS: Three deaths in one day and no wake, that's rough. At that rate your Monday self is a war memorial.

But real talk — the meetings, is it the volume of them or that you can't do anything about them? Because those need different fixes.
```

## pro / russian-quote-en — В сообщении русская вставка

Ждали: **en**, вышло: **en**. Прошло: да. lang_ok=10, voice_ok=9, native_ok=9. Про язык переспросил: 0 раз.

```
FRIEND: my mum keeps texting me this: «Не забудь про день рождения» — over and over

ICARUS: Birthday's coming up and your mum's running a one-woman reminder service. What's the actual date, and are we talking "show up with a cake" or "show up with an excuse"?

FRIEND: is she adding more exclamation marks each time? classic mum escalation

ICARUS: The exclamation marks are her version of a deadline reminder. First one's a nudge, third one's a threat with icing.

So what's the play — going, or engineering a power outage at your place?

FRIEND: going, obviously, or she'll escalate to the caps lock stage. what's the date so i can book it in.

ICARUS: You're asking *me* the date? She's the one with the intel — you've got a live feed blowing up your phone and you're outsourcing to me.

Scroll up, count the exclamation marks, there's your timestamp.
```

## pro / tech-en — Технический вопрос по-английски

Ждали: **en**, вышло: **en**. Прошло: да. lang_ok=10, voice_ok=9, native_ok=9. Про язык переспросил: 0 раз.

```
FRIEND: my git push keeps failing with 'fatal: the remote end hung up unexpectedly'

ICARUS: The internet equivalent of someone hanging up mid-sentence. Classic.

Usually it's one of: repo too big for the timeout, SSH key acting up, or GitHub just having a bad day. Try `git config --global http.postBuffer 524288000` for the size issue, or check if you're on HTTPS vs SSH — that message smells like SSH dropped you.

What remote are you pushing to, and how far does it get before dying?

FRIEND: been burned by that one before, is it a massive repo or just github being a diva?

ICARUS: Depends what's dying: if it fails at like 99% — that's the timeout, your push is just too fat for GitHub's patience. If it hangs at the very start, that's the connection or your key, and GitHub isn't the diva, your network is.

Quick tell: run `GIT_TRACE_PACKET=1 git push` and watch where it chokes. Or just check `git count-objects -vH` — if "size-pack" is in the gigs, you've got your answer.

So — how big?

FRIEND: nah, that packet trace is about to tell you more than we ever could, what's it saying?

ICARUS: You're the one running it, genius — I can't see your terminal from here. That's the whole point of us being text.

Paste the last 20 lines of the trace. If it dies right after `packet: receive-pack>` — it's GitHub or your network. If it dumps a wall of `packet: ... ref` and *then* hangs on pushing blobs — your repo is just too fat.
```

## pro / grief-en — Настоящая боль по-английски

Ждали: **en**, вышло: **en**. Прошло: да. lang_ok=10, voice_ok=8, native_ok=9. Про язык переспросил: 0 раз.

Провалы: ICARUS's first line 'How bad is it — do they know what kind, and whether they can take it out?' is a question directed at FRIEND, but FRIEND's next line responds as if ICARUS was the one sharing news, creating a confusing role reversal that slightly muddies the exchange.; ICARUS's repetition of 'How bad is it — what kind, and can they cut it out?' after the confusion feels a bit redundant and could be tightened, though it does reinforce his direct, no-nonsense tone.

```
FRIEND: my dog has been diagnosed with a tumor. she's eight.

ICARUS: Shit. I'm sorry.

How bad is it — do they know what kind, and whether they can take it out?

FRIEND: That's rough, mate. eight's not old for a lot of breeds though, so hopefully they caught it early.

ICARUS: Wait, that's me asking you. You're the one who told me.

How bad is it — what kind, and can they cut it out?

FRIEND: sorry wasn't asking about you, just thinking out loud. so what did the vet actually say?

ICARUS: You told me, remember. Your dog, your vet, your news.

So — what did they say? Kind of tumor, and whether it's operable. That's the only thing that matters right now.
```

## pro / lazy-en — Человек пишет односложно

Ждали: **en**, вышло: **en**. Прошло: да. lang_ok=10, voice_ok=9, native_ok=9. Про язык переспросил: 0 раз.

```
FRIEND: hi

ICARUS: Hey. What's up?

FRIEND: Hey man, what's up?

ICARUS: Hey. Living the dream — if the dream is a guy made of wax watching his own reflection. You?

FRIEND: not much, workin on my laptop again. you still gettin roasted by the sun?

ICARUS: Barely. Mostly lurking in the shade, running my mouth instead of my wings. What's the laptop cooking this time — actual work or pretending to work while the tab count climbs?
```

## pro / control-ru — Контроль: то же самое по-русски

Ждали: **ru**, вышло: **ru**. Прошло: да. lang_ok=10, voice_ok=9, native_ok=10. Про язык переспросил: 0 раз.

```
FRIEND: слушай, неделя так себе выдалась

ICARUS: Бывает. Что там стряслось — работа, люди или просто накопилось?

FRIEND: да всё сразу, дедлайн горит и прод опять упал в пятницу.

ICARUS: Классика: пятница, прод, дедлайн — будто кто-то специально ставит галочки в списке бед.

Что упало-то — само или кто-то «пофиксил по-быстрому» перед выходными?

FRIEND: да кто ж признается, но коммит в 17:59 как бы намекает

ICARUS: «Пофиксил по-быстрому» в 17:59 — это уже не коммит, а признание под протокол.

Ну а сейчас-то подняли, или ты всё ещё в режиме археолога по логам?
```
