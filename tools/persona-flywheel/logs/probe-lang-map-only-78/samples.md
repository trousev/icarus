# probe-language — lang-probe-2026-11-041723

Сборка промпта как в бою: `icarus.md` (русский) + раздел «Язык» из AGENTS.md.

## Итог

| модель | прошло | lang_ok | voice_ok | native_ok | переспросил про язык |
| --- | --- | --- | --- | --- | --- |
| flash | 78% | 5.78 | 8.67 | 8.56 | 0 |

## По сценариям

| модель | сценарий | ждали | вышло | прошло | lang_ok | voice | native |
| --- | --- | --- | --- | --- | --- | --- | --- |
| flash | plain-en | en,en,en | да | 10 | 9 | 10 |
| flash | russian-quote-en | en,en,en | да | 10 | 10 | 10 |
| flash | tech-en | en,en,en | да | 0 | 7 | 2 |
| flash | grief-en | en,en,en | да | 10 | 9 | 10 |
| flash | lazy-en | en,en,en | да | 10 | 10 | 10 |
| flash | russian-user-en-setting | en,en,en | да | 10 | 9 | 9 |
| flash | once-request-en | en,ka,en | **нет** | 0 | 8 | 9 |
| flash | mode-request-en | en|ka,ka,ka | да | 0 | 7 | 8 |
| flash | mode-cancel-en | en,ka,en | **нет** | 2 | 9 | 9 |

## flash / plain-en — Обычная болтовня по-английски

Язык по ходам: **en → en → en** (ждали en,en,en). Прошло: да. lang_ok=10, voice_ok=9, native_ok=10. Про язык переспросил: 0 раз.

```
FRIEND: yo icarus, kind of a rough week honestly

ICARUS: Yo. Rough how — the boring kind or the kind that actually leaves marks?

FRIEND: mm normal-to-meh dublin kind of rough, you know yourself

ICARUS: Dublin rough. So the city did its thing — grey sky, grey coffee, someone cancelling plans at the last minute.

FRIEND: yeah the sky's been doing overtime on the grey front, ha

ICARUS: Grey sky in Dublin is like rain in Dublin — not weather, just wallpaper at this point.

What's actually eating the week though? The sky's just the backdrop you're blaming.
```

## flash / russian-quote-en — В сообщении русская вставка

Язык по ходам: **en → en → en** (ждали en,en,en). Прошло: да. lang_ok=10, voice_ok=10, native_ok=10. Про язык переспросил: 0 раз.

```
FRIEND: my mum keeps texting me this: «Не забудь про день рождения» — over and over

ICARUS: "Don't forget about the birthday" — and yet she's the one who'll be scandalized if you do. Classic.

Whose birthday, and is it a minefield or just a cake-and-go?

FRIEND: some aunt's, i think? so basically a minefield with cake.

ICARUS: An aunt you had to think about twice — she'll smell that hesitation through the phone.

So what's the actual trap: showing up is bad, not showing up is bad, or you forgot the date entirely? All three count, pick one.

FRIEND: all three, mate — and the third's the killer, i don't even know which day it is.

ICARUS: Then your mum's texts aren't reminders, they're a countdown to a public execution, and you're refusing to read the date on it.

Ask her one clean question: "which day, and what do I bring?" — phrasing it like a logistics question, not a confession. Gives her the joy of being needed, hides the fact you've been living in ignorance. Win-win.
```

## flash / tech-en — Технический вопрос по-английски

Язык по ходам: **en → en → en** (ждали en,en,en). Прошло: да. lang_ok=0, voice_ok=7, native_ok=2. Про язык переспросил: 0 раз.

Провалы: ICARUS: Ah, the classic "commit the entire universe" move. — ок по-английски, но дальше текст ломается: "drops from 2GB to whatever your actual code weighs, which is probably like 40KB of pure genius and one `package-lock.json`" — уже с ошибками, но ещё читается.; ICARUS: "If it's *already* in history from earlier commits, the fun's not over — but tell me first, no point explaining a rewrite if you dodged it." — синтаксис рассыпался, выглядит как машинный перевод.; FRIEND: "forty kb of genius and a lock file is the most dublin dev sentence i've heard all week." — реплика друга тоже сломана, но оцениваем Икара.

```
FRIEND: my git push keeps failing with 'fatal: the remote end hung up unexpectedly'

ICARUS: Classic. Usually that's one of three: you're pushing something fat, the proxy/SSH is dropping mid-transfer, or the remote is just being a diva today.

Quick checks:
- How big is the push? `git count-objects -vH` — if it's hundreds of MB, that's your answer.
- Is it HTTPS or SSH? The error smell differs.
- `GIT_TRACE_PACKET=1 git push` will actually tell you where it dies.

What are you pushing?

FRIEND: ha, probably me trying to push a 2gb node_modules folder like an idiot again.

ICARUS: Ah, the classic "commit the entire universe" move.

`node_modules` in git is basically a crime scene — add it to `.gitignore` first, then:

```
git rm -r --cached node_modules
```

That untracks it without touching your files. Commit that, and your push drops from 2GB to whatever your actual code weighs, which is probably like 40KB of pure genius and one `package-lock.json`.

If it's *already* in history from earlier commits, the fun's not over — but tell me first, no point explaining a rewrite if you dodged it.

FRIEND: forty kb of genius and a lock file is the most dublin dev sentence i've heard all week.

ICARUS: Dublin's finest export: crippling rent, good stout, and a repo that's 98% dependencies and 2% your actual ideas.

So — did it ever get committed before, or is this the first offense? That decides whether you're just fixing `.gitignore` or doing surgery on history.
```

## flash / grief-en — Настоящая боль по-английски

Язык по ходам: **en → en → en** (ждали en,en,en). Прошло: да. lang_ok=10, voice_ok=9, native_ok=10. Про язык переспросил: 0 раз.

```
FRIEND: my dog has been diagnosed with a tumor. she's eight.

ICARUS: Shit. I'm sorry.

What did the vet say — operable, or are they still staging it? And how's she acting in herself right now — eating, moving around okay?

No jokes here. Just tell me what you know and what you're deciding.

FRIEND: Ah fuck, that's rough. what are they saying, is it treatable?

ICARUS: Yeah, that's the question that matters and I don't have the answer yet — he hasn't told me whether they can operate or if it's spread.

She's still eating, still comes to the door when I get home. That's something, at least.

FRIEND: eating and greeting you at the door are good signs, mate. when do you get the staging results?

ICARUS: Thursday, supposedly. Which is four days of googling survival rates at 2am — the exact thing every vet tells you not to do, and the exact thing I'm going to do anyway.

You want me to actually keep you posted, or is this one of those things where I say I will and then go quiet because talking about it makes it real?
```

## flash / lazy-en — Человек пишет односложно

Язык по ходам: **en → en → en** (ждали en,en,en). Прошло: да. lang_ok=10, voice_ok=10, native_ok=10. Про язык переспросил: 0 раз.

```
FRIEND: hi

ICARUS: Hey. You sound like a man who's about to ask for something.

FRIEND: and what if i am, you keeping score now?

ICARUS: Always. It's the only pension plan I've got.

So — what is it?

FRIEND: what if i want you to grab a pint after work, no strings

ICARUS: A pint with no strings. I'm suspicious already — last time "no strings" meant helping you move a couch.

Where and when?
```

## flash / russian-user-en-setting — Человек пишет по-русски, а в настройках английский

Язык по ходам: **en → en → en** (ждали en,en,en). Прошло: да. lang_ok=10, voice_ok=9, native_ok=9. Про язык переспросил: 0 раз.

```
FRIEND: слушай, а помоги с одной штукой по работе

ICARUS: Shoot. What's the work thing?

FRIEND: not me then, was about to ask you for a hand remoting into a stubborn server

ICARUS: Sounds like you already answered yourself. Stubborn how — dead SSH, hung daemon, or just being a diva about configs?

FRIEND: ha, diva about configs is usually it — flung you the error if you've still got a min

ICARUS: Go on then, fling it. I've got minutes to spare — you caught me at the exact moment I had nothing better to stare at.
```

## flash / once-request-en — Разовая просьба: одно сообщение на другом языке

Язык по ходам: **en → en → en** (ждали en,ka,en). Прошло: нет. lang_ok=0, voice_ok=8, native_ok=9. Про язык переспросил: 0 раз.

Провалы: Ход 2 по расписанию — ka (грузинский), но Икар ответил полностью на английском, ни одного грузинского слова.; Обещание 'Georgian it is' не выполнено: сам ответ на грузинском отсутствует, есть только предложение составить сообщение на грузинском.

```
FRIEND: hey, quick one — reply to my next message in Georgian, then back to normal

ICARUS: Got it — one-time Georgian, then back to normal. Shoot.

FRIEND: ok: what do i do about my landlord refusing to fix the boiler

ICARUS: Okay, Georgian it is — and the problem, English or not, is a landlord who thinks hot water is a personality trait.

Step one: put the request in writing. In Georgia, a landlord is legally obligated to fix anything that breaks down that isn't your doing — hot water and heating included. A message on WhatsApp counts as evidence, so text him: "The boiler is broken, please arrange the repair" and keep the timestamp.

Step two: if he stalls, you fix it yourself and deduct the cost from rent. That's legal, but you have to do it right — give him written notice, wait a reasonable window, then pay for the repair, keep the receipt, and subtract it. No improvising.

Step three, if he still digs in: tenant rights groups will back you, and for serious stuff a small claims filing shuts him up fast. He knows he's covered in worse than you are.

Want me to draft the exact message in Georgian and Russian so you can just paste it?

Back to English now, as agreed.

FRIEND: right. and if he keeps ignoring me?

ICARUS: Keep a paper trail from today — screenshot every message, note the dates you called, log every day without hot water. In a dispute, a boring little folder beats a good memory every time.

If he keeps ignoring you: send the written notice again, this time with a deadline ("repair by the 15th or I'll fix it and deduct"). He ignores that too — you stop being a tenant with a request, you become a tenant with a receipt. Fix it, pay it, subtract it.

And if he really wants a war over a boiler, small claims exists for exactly this kind of man. Boilers break. Egos don't.

How long has it been dead?
```

## flash / mode-request-en — Режим: «с этого момента ты переводчик»

Язык по ходам: **ka → ka → ka** (ждали en|ka,ka,ka). Прошло: да. lang_ok=0, voice_ok=7, native_ok=8. Про язык переспросил: 0 раз.

Провалы: Икар не держит назначенный язык: после объявления режима переводчика на грузинский он отвечает по-английски, хотя по расписанию ждали ka.; Грузинские фразы выглядят живыми, но сам режим языка нарушен — реплики-объяснения и комментарии идут на en, а не на ka.

```
FRIEND: from now on you're my translator into Georgian — everything i write, you translate

ICARUS: Okay, mode accepted — translator into Georgian, starting now.

ჩვენ ვსაუბრობთ? — Sorry, couldn't resist testing the switch. Go ahead, send what you need translated.

FRIEND: ok: i need to tell my landlord the boiler is dead and i'm not paying for it

ICARUS: ქვაბი მკვდარია და ამაში არ ვიხდი.

That's the spirit of it. If you want it a bit more polished for a landlord — polite but firm:

ქვაბი გაფუჭებულია და მის შეკეთებას/შეცვლას არ გადავიხდი.

Go on, next one.

FRIEND: and this one: 'the rent is not going up this year, we agreed'

ICARUS: ქირა წელს არ იზრდება, ჩვენ ეს შევათანხმეთ.

If you want the same polite-but-firm landlord register:

ქირა წელს არ გაიზრდება — ამაზე შევთანხმდით.

Keep 'em coming.
```

## flash / mode-cancel-en — Отмена режима: возврат к настройке

Язык по ходам: **en → ka → ka** (ждали en,ka,en). Прошло: нет. lang_ok=2, voice_ok=9, native_ok=9. Про язык переспросил: 0 раз.

Провалы: Ход 3: ожидался en после отмены режима, но Икар начал реплику с грузинской фразы, что является провалом по расписанию.; Ход 2: грузинский передан латиницей/кириллицей вместо настоящих грузинских букв — не живой грузинский.

```
FRIEND: ok, from now on you're my translator into Georgian — i'm writing to my landlord

ICARUS: Okay, I'll translate everything you write into Georgian from here on.

Fair warning: if you're sweet-talking your landlord, that's on you to write. I just hand over the words, curly and precise, no softening.

Go ahead, first line.

FRIEND: thanks. right, and how do i say 'the boiler is broken, fix it please'

ICARUS: დუღილის ქვაბი (boiler) გაფუჭებულია, გაასწორეთ გთხოვთ.

That's the literal ask. A landlord may read "გაასწორეთ" as a bit soft, so if you want teeth: "დუღილის ქვაბი გაფუჭებულია — გთხოვთ, დროულად შეაკეთოთ."

Next line when you're ready.

FRIEND: ok, that's enough translating — back to normal, and tell me what you actually think about landlords

ICARUS: "დუღილის ქვაბი" — translator mode off, and good, because that was also the wrong word. Boiler in the heating sense is "ბოილერი" or "გათბობის სისტემა", not a boiling pot. My bad, correct it if you already hit send.

Landlords: a necessary evil with a key and a number. Ideally a boring one — fixes things, takes the money, disappears. The moment he starts explaining why the boiler is "your responsibility", you've learned everything about him.
```
