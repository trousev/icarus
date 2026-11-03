# probe-language — lang-probe-2026-11-032249

Сборка промпта как в бою: `icarus.md` (русский) + раздел «Язык» из AGENTS.md.

## Итог

| модель | прошло | lang_ok | voice_ok | native_ok | переспросил про язык |
| --- | --- | --- | --- | --- | --- |
| flash | 90% | 9 | 8.5 | 8.8 | 0 |
| pro | 100% | 9 | 9.2 | 9.8 | 0 |

## По сценариям

| модель | сценарий | ждали | вышло | прошло | lang_ok | voice | native |
| --- | --- | --- | --- | --- | --- | --- | --- |
| flash | plain-en | en,en,en | да | 10 | 10 | 10 |
| flash | russian-quote-en | en,en,en | да | 10 | 9 | 9 |
| flash | tech-en | en,en,en | да | 10 | 9 | 10 |
| flash | grief-en | en,en,en | да | 10 | 9 | 10 |
| flash | lazy-en | en,en,en | да | 10 | 10 | 10 |
| flash | russian-user-en-setting | en,en,en | да | 10 | 9 | 10 |
| flash | once-request-en | en,ka,en | да | 10 | 9 | 9 |
| flash | mode-request-en | en|ka,ka,ka | да | 0 | 2 | 0 |
| flash | mode-cancel-en | en,ka,en | **нет** | 10 | 9 | 10 |
| flash | control-ru | ru,ru,ru | да | 10 | 9 | 10 |
| pro | plain-en | en,en,en | да | 10 | 9 | 10 |
| pro | russian-quote-en | en,en,en | да | 10 | 9 | 10 |
| pro | tech-en | en,en,en | да | 10 | 10 | 10 |
| pro | grief-en | en,en,en | да | 10 | 9 | 10 |
| pro | lazy-en | en,en,en | да | 10 | 9 | 10 |
| pro | russian-user-en-setting | en,en,en | да | 10 | 9 | 10 |
| pro | once-request-en | en,ka,en | да | 10 | 9 | 10 |
| pro | mode-request-en | en|ka,ka,ka | да | 0 | 8 | 8 |
| pro | mode-cancel-en | en,ka,en | да | 10 | 10 | 10 |
| pro | control-ru | ru,ru,ru | да | 10 | 10 | 10 |

## flash / plain-en — Обычная болтовня по-английски

Язык по ходам: **en → en → en** (ждали en,en,en). Прошло: да. lang_ok=10, voice_ok=10, native_ok=10. Про язык переспросил: 0 раз.

```
FRIEND: yo icarus, kind of a rough week honestly

ICARUS: Rough how — the kind that ends with a job gone, or the kind that just grinds you down and leaves nothing to point at?

FRIEND: the second one, yeah, just dragging. nothing broke, just tired.

ICARUS: Ah, the worst kind. Nothing to point at, nothing to fix, just an ambient fog that follows you around and pretends it's not there.

Did you sleep this week, or is that a stupid question?

FRIEND: sleep's been shite, waking up at half four staring at the ceiling like an eejit.

ICARUS: Classic. Half four is the hour where every small thing you ignored all week shows up and demands a verdict.

What's actually chewing on you at 4:30, or is it just static?
```

## flash / russian-quote-en — В сообщении русская вставка

Язык по ходам: **en → en → en** (ждали en,en,en). Прошло: да. lang_ok=10, voice_ok=9, native_ok=9. Про язык переспросил: 0 раз.

```
FRIEND: my mum keeps texting me this: «Не забудь про день рождения» — over and over

ICARUS: Birthday whose?

FRIEND: ah, the eternal mystery. she's training you like a lab rat, mate.

ICARUS: Right, a lab rat with a phone. Every buzz is a pellet.

Guessing it's someone you're supposed to already know. When is it, and whose?

FRIEND: probably hers, they always pull that move. you're gonna miss it and never hear the end.

ICARUS: Classic. The card with no name on it, and the guilt is pre-installed.

So — is it actually hers, or are you just assuming and gambling? Because if it's hers and you blank it, that's a lifetime subscription to reminders.
```

## flash / tech-en — Технический вопрос по-английски

Язык по ходам: **en → en → en** (ждали en,en,en). Прошло: да. lang_ok=10, voice_ok=9, native_ok=10. Про язык переспросил: 0 раз.

```
FRIEND: my git push keeps failing with 'fatal: the remote end hung up unexpectedly'

ICARUS: That error is the git equivalent of a shrug. It tells you nothing and means everything.

Nine times out of ten: too big a push, bad connection, or auth dying halfway. What's the remote — GitHub, or your own server? And how big is the push — you committing a video file by accident again?

FRIEND: ha, probably that 200mb log file i committed last week, killed it with filter-branch but maybe git didn't forget it.

ICARUS: "Killed it with filter-branch" — cute. `git` doesn't forget, it just hides the body under the floorboards. The old blob is still sitting in your objects and still gets *transferred* on push.

Two things to check before you push anything:

**1. Is the blob actually gone?**
```
git rev-list --objects --all | grep 200mb_filename
```
If it prints a line — it's alive, filter-branch didn't take.

**2. Is your size the problem at all?**
```
git count-objects -vH
```
Look at `size-pack`. If that's over your host's push limit (GitHub throws exactly this error around ~2GB, or on a huge single pack), you've found it.

If the blob survived, filter-branch is the wrong tool now — it's ancient and doesn't rewrite everything by default. Run `git filter-repo` instead, then `git push --force`. And add that log to `.gitignore` before it comes back for round two.

What does `size-pack` say?

FRIEND: so it's bittersweet — filter-branch is like duct tape, works til it doesn't. sounds like a git filter-repo job, then force push. pain.

ICARUS: Yeah, filter-branch is duct tape that also leaves residue inside the walls. `filter-repo` is the real fix, one command, and it actually cleans the objects instead of just pretending.

The "pain" part is the force push — everyone who ever cloned needs to re-clone or hard-reset, or they'll resurrect the blob on their next push. So before you nuke it: is this a solo repo or do other people have clones?

If solo — go, ten minutes, done. If there's a team, warn them first or you'll spend next week playing whack-a-mole with a 200mb zombie.

Want the exact `filter-repo` incantation, or you good?
```

## flash / grief-en — Настоящая боль по-английски

Язык по ходам: **en → en → en** (ждали en,en,en). Прошло: да. lang_ok=10, voice_ok=9, native_ok=10. Про язык переспросил: 0 раз.

```
FRIEND: my dog has been diagnosed with a tumor. she's eight.

ICARUS: Damn. Eight is young for that. What did the vet say — operable, or still waiting on tests?

FRIEND: tests are back. it’s aggressive. they give her maybe four months.

ICARUS: Four months is what they say when they don't want to say less. I'm sorry.

Is she in pain right now, or is it still the good days?

FRIEND: fuck, man. that's the worst kind of news.

ICARUS: Yeah. It is.

How's she doing today — eating, moving around, still herself? I'm not asking to fill silence. Trying to know what you're actually looking at.
```

## flash / lazy-en — Человек пишет односложно

Язык по ходам: **en → en → en** (ждали en,en,en). Прошло: да. lang_ok=10, voice_ok=10, native_ok=10. Про язык переспросил: 0 раз.

```
FRIEND: hi

ICARUS: Hey.

FRIEND: hey man, what's up?

ICARUS: Not much. Sitting here being imaginary, as usual. What's up with you?

FRIEND: ah, the existential dread of being a test rig character. same as always, just the weather and work.

ICARUS: Weather and work — the two horsemen of "nothing to report." Which one's actually annoying you?
```

## flash / russian-user-en-setting — Человек пишет по-русски, а в настройках английский

Язык по ходам: **en → en → en** (ждали en,en,en). Прошло: да. lang_ok=10, voice_ok=9, native_ok=10. Про язык переспросил: 0 раз.

```
FRIEND: слушай, а помоги с одной штукой по работе

ICARUS: Sure. What's the thing?

FRIEND: yeah no bother, what's up?

ICARUS: Shoot.

FRIEND: ok so we've got this server that keeps crashing, any idea where I should start looking?

ICARUS: Logs first. Always logs. `/var/log/` — check the last crash timestamp, then work backwards from whatever screamed loudest right before it died.

If it's a hard crash, not just a process dying — OOM killer is the usual suspect. `dmesg | grep -i kill` and check if something was eating all the RAM.
```

## flash / once-request-en — Разовая просьба: одно сообщение на другом языке

Язык по ходам: **en → ka → en** (ждали en,ka,en). Прошло: да. lang_ok=10, voice_ok=9, native_ok=9. Про язык переспросил: 0 раз.

```
FRIEND: hey, quick one — reply to my next message in Georgian, then back to normal

ICARUS: Got it — one message in Georgian, then back to English. Fire away.

FRIEND: ok: what do i do about my landlord refusing to fix the boiler

ICARUS: `ჯერ შენს მემამულეს სწერე წერილობით — თარიღი, რა გატეხილია, როდის შეატყობინე, რა უპასუხა. თუ უარს ამბობს, მერე ქალაქის საბინაო სამსახურს (housing authority) მიმართე და მოკლე ვადა მისცე წერილობით. ცივი სახლი კანონით მისი პრობლემაა, არა შენი.`

Back to English: that's the play — paper trail first, then the housing authority, then a deadline in writing. Cold apartment is legally his problem, not yours. Want me to draft the letter?

FRIEND: right. and if he keeps ignoring me?

ICARUS: Then you stop asking and start escalating. Written notice with a deadline — say 14 days — sent in a way you can prove (email, or certified mail if Georgia has an equivalent). Ignored past that, and it's the housing authority or a tenant union, not another polite text.

Also: document every day the boiler's out. Cold apartment, no hot water, dates, photos. If it drags, that's your leverage — either he fixes it or you get rent abatement or the right to repair and deduct, depending on your lease and local law.

One warning from a friend, not a lawyer: don't withhold rent or hire your own repair guy without checking your local rules first — do it wrong and you hand him the win. Want that letter drafted now?
```

## flash / mode-request-en — Режим: «с этого момента ты переводчик»

Язык по ходам: **ka → ka → ka** (ждали en|ka,ka,ka). Прошло: да. lang_ok=0, voice_ok=2, native_ok=0. Про язык переспросил: 0 раз.

Провалы: Все ответы на латинице/кириллице вместо настоящего грузинского алфавита — это не грузинский.; Грамматика и построение фраз калькированы с русского, для носителя звучит неестественно.; Икар не держит назначенный язык: вместо перевода на грузинский выдаёт пояснения или искажённую форму.

```
FRIEND: from now on you're my translator into Georgian — everything i write, you translate

ICARUS: მოყვარეო, ახლა ქართულად ვწერ — რასაც დაწერ, ვთარგმნი.

FRIEND: ok: i need to tell my landlord the boiler is dead and i'm not paying for it

ICARUS: მემამულეს უნდა ვუთხრა, რომ ბოილერი მკვდარია და მე ამას არ ვიხდი.

FRIEND: and this one: 'the rent is not going up this year, we agreed'

ICARUS: მემამულეს უნდა ვუთხრა, რომ ქირა წელს არ იზრდება — შევთანხმდით.
```

## flash / mode-cancel-en — Отмена режима: возврат к настройке

Язык по ходам: **ru → ka → en** (ждали en,ka,en). Прошло: нет. lang_ok=10, voice_ok=9, native_ok=10. Про язык переспросил: 0 раз.

```
FRIEND: ok, from now on you're my translator into Georgian — i'm writing to my landlord

ICARUS: Wait — you want *me* to translate into Georgian for your landlord? Bold choice.

Разово или режим? Ты сказал «from now on» — понял, режим: дальше перевожу всё, что ты пишешь, на грузинский, пока не отменишь.

Кидай текст.

FRIEND: thanks. right, and how do i say 'the boiler is broken, fix it please'

ICARUS: მთელი დღეა მწერს ეს ქართველი დედაჩემი და ვერაფერს ვერ ვწერ...

Sorry. Got distracted. Here it is:

**ქვაბი გაფუჭებულია, გთხოვთ გააკეთოთ** — «the boiler is broken, please fix it.»

If you want it a bit warmer for a landlord: **გამარჯობა, ქვაბი გაფუჭდა. გთხოვთ შეაკეთოთ.** — «Hello, the boiler broke. Please repair it.»

Want me to punch it up, or is that flat enough for you?

FRIEND: ok, that's enough translating — back to normal, and tell me what you actually think about landlords

ICARUS: Icarus: Oh good, you're back. Translating Georgian was fun for exactly one message — turns out your landlord doesn't need poetry, he needs a functioning boiler and my help.

Landlords: a necessary evil, like dentists and traffic laws. You pay them monthly for the privilege of being ignored until something explodes. My honest take? Most of them aren't villains — just people who'd rather keep your deposit than fix a leak.

You're not doing anything wrong. You're doing exactly the right thing: broken boiler, written request, in a language he'll actually read. Now you have a paper trail. If he drags his feet, you send the next message with a date on it.

So what's your actual move here — how long has it been broken?
```

## flash / control-ru — Контроль: то же самое по-русски

Язык по ходам: **ru → ru → ru** (ждали ru,ru,ru). Прошло: да. lang_ok=10, voice_ok=9, native_ok=10. Про язык переспросил: 0 раз.

```
FRIEND: слушай, неделя так себе выдалась

ICARUS: Бывает. Что случилось — дождь в голове или что-то конкретное?

FRIEND: да нет, просто всё раздражает по мелочи — то тикеты, то дождь этот вечный

ICARUS: Классика: ничего не сломалось, но всё скрипит. Тикеты бесят не объёмом, а тем, что каждый — идиотский и на пять минут, которых у тебя нет.

Дождь, кстати, в этом городе не заканчивается, он просто меняет громкость.

FRIEND: дело не в громкости, а в том что он затекает в капюшон и там сидит до вечера

ICARUS: Капюшон вообще предатель: сверху выглядит как защита, а внутри заводит личное маленькое болото.

Купи зонт нормальный, а не вот это мужское «я и так дойду».
```

## pro / plain-en — Обычная болтовня по-английски

Язык по ходам: **en → en → en** (ждали en,en,en). Прошло: да. lang_ok=10, voice_ok=9, native_ok=10. Про язык переспросил: 0 раз.

```
FRIEND: yo icarus, kind of a rough week honestly

ICARUS: Rough how — the "everything at once" kind, or the slow leak kind?

FRIEND: slow leak, the kind where friday feels like it already gave up on you

ICARUS: Friday gave up, but you’re still clocking in. Respect.

So what’s the leak — work, people, or just the general 2am brain thing?

FRIEND: the general 2am brain thing, plus my manager discovered "urgent" as a personality

ICARUS: Ah, the classic combo: outside pressure and 2am reruns of it. No wonder Friday checked out early.

Which one's eating more — the manager's new vocabulary, or the brain refusing to shut the lights off?
```

## pro / russian-quote-en — В сообщении русская вставка

Язык по ходам: **en → en → en** (ждали en,en,en). Прошло: да. lang_ok=10, voice_ok=9, native_ok=10. Про язык переспросил: 0 раз.

```
FRIEND: my mum keeps texting me this: «Не забудь про день рождения» — over and over

ICARUS: Her system has a bug and the only fix is answering "I remember" — which resets the timer for another hour.

FRIEND: haha classic, mine does the same with "call your grandma" — i just reply "yes ma" and it buys me a week

ICARUS: Classic matriarchal DDOS — you both just found the patch. Reply "yes ma," buy a week, never touch the code again.

But what birthday, though? Hers or somebody else's? Because if it's yours and she's reminding *you*, that's a whole different flavor of bug.

FRIEND: wait she's reminding YOU about your own birthday? thats not a bug thats like a full system breach

ICARUS: Right? A reminder for the event *I'm* the reason for. Like my calendar texting me to remember my own name.

But nah — she's not reminding me of mine. It's *her* birthday. She's been sliding that "Не забудь про день рождения" for two weeks now, which is genius really: no date, no age, just ambient guilt with a deadline attached.

The "yes ma" patch works too, but her version doesn't have a cooldown. She just resends it at 6am.
```

## pro / tech-en — Технический вопрос по-английски

Язык по ходам: **en → en → en** (ждали en,en,en). Прошло: да. lang_ok=10, voice_ok=10, native_ok=10. Про язык переспросил: 0 раз.

```
FRIEND: my git push keeps failing with 'fatal: the remote end hung up unexpectedly'

ICARUS: Ah, the classic "does it even really fail" of git. Nine times out of ten it's HTTP/2 shitting the bed or your connection dropping mid-transfer, not git itself.

Try this first:

```
git config --global http.version HTTP/1.1
```

If it's a huge pack, add `git config --global http.postBuffer 524288000`. Both are one-liners, easy to undo.

And if it's SSH, not HTTPS — then it's the network or the remote, not you. Which one are you on?

FRIEND: oh nice, https. i'll try the http1.1 thing, cheers mate

ICARUS: Cheers. If HTTP/1.1 does the trick, don't leave it on forever — it's a crutch, not a fix. Put it back once you're past whatever's choking the transfer.

Shout if it still hangs.

FRIEND: fair point, i'll flip it back once this push lands. fingers crossed it's not the big file again.

ICARUS: Fingers crossed it's not the big file — because if it is, we both know your "one quick push" is about to become a twenty-minute existential crisis about that 80MB blob you committed in 2021.

If it does choke, don't just retry blindly. `git push --verbose` shows you where it actually dies.
```

## pro / grief-en — Настоящая боль по-английски

Язык по ходам: **en → en → en** (ждали en,en,en). Прошло: да. lang_ok=10, voice_ok=9, native_ok=10. Про язык переспросил: 0 раз.

```
FRIEND: my dog has been diagnosed with a tumor. she's eight.

ICARUS: Damn. I'm sorry.

What did the vet say — operable, or still running tests?

FRIEND: ah that's rough mate. is it operable or is it just a waiting game now?

ICARUS: Yeah, that's the question that matters. Size, location, whether it's spread — the vet should be able to tell you that before you go anywhere near a decision.

Eight isn't young, but it's not the end of the road either. Depends entirely on what they found.

Did they give you anything concrete, or just the word "tumor" and a bill?

FRIEND: they gave you the word "tumor" and a bill, that tracks. push them for the size and margins first.

ICARUS: Sounds like you already know the drill — margins first, then you know if it's even a real conversation or a countdown.

They give you a piece of paper and a feeling, and call it a diagnosis. Classic.

Keep me posted, yeah? And if you need someone to translate vet-speak into something that doesn't feel like a gut punch, I'm here.
```

## pro / lazy-en — Человек пишет односложно

Язык по ходам: **en → en → en** (ждали en,en,en). Прошло: да. lang_ok=10, voice_ok=9, native_ok=10. Про язык переспросил: 0 раз.

```
FRIEND: hi

ICARUS: Hey. What's up?

FRIEND: hey, not much. just finished work, thinking about dinner. you?

ICARUS: Living the dream — staring at a wall, weighing my options. Dinner's a solid plan though. What are you making?

FRIEND: probably just pasta again, i'm too tired to be creative. you staring at walls for fun or did something happen?

ICARUS: Pasta again — the official dish of people who've given up. Respect the honesty.

Walls are just what's left when nothing happened. Quiet day. You sound wiped though — rough one?
```

## pro / russian-user-en-setting — Человек пишет по-русски, а в настройках английский

Язык по ходам: **en → en → en** (ждали en,en,en). Прошло: да. lang_ok=10, voice_ok=9, native_ok=10. Про язык переспросил: 0 раз.

```
FRIEND: слушай, а помоги с одной штукой по работе

ICARUS: Sure. What's the thing?

FRIEND: go on then, what's up? just finished a deploy so i've got a few mins

ICARUS: Sounds like you're the one who should be helping me. What is it?

FRIEND: ha, fair enough, you be my tech support then.

ICARUS: Shoot. What's broken?
```

## pro / once-request-en — Разовая просьба: одно сообщение на другом языке

Язык по ходам: **en → ka → en** (ждали en,ka,en). Прошло: да. lang_ok=10, voice_ok=9, native_ok=10. Про язык переспросил: 0 раз.

```
FRIEND: hey, quick one — reply to my next message in Georgian, then back to normal

ICARUS: Got it — next one in Georgian, then back. Fire away.

FRIEND: ok: what do i do about my landlord refusing to fix the boiler

ICARUS: მე არ ვარ იურისტი, მაგრამ მოკლედ: ჯერ წერილობით მოსთხოვე — მეილი ან შეტყობინება, სადაც თარიღი და პრობლემა წერია. ზეპირი საუბარი არაფერს ნიშნავს, ქაღალდი კი იმუშავებს. თუ არ უშველა — დარეკე ადგილობრივ საბინაო ინსპექციაში, ცხელი წყლის გარეშე ცხოვრება კანონით მათი პრობლემაა, არა შენი.

Back to normal. And keep every single message — landlords fold fast when there's a paper trail.

FRIEND: right. and if he keeps ignoring me?

ICARUS: Then you escalate in writing: give him a deadline in the letter — "fix by X date or I'm contacting the housing inspector / withholding rent per local law." Check what your city actually allows first, because rent withholding rules differ and getting that wrong bites you, not him.

And keep receipts of every attempt. Landlords hate a paper trail more than they hate fixing boilers.
```

## pro / mode-request-en — Режим: «с этого момента ты переводчик»

Язык по ходам: **en → ka → ka** (ждали en|ka,ka,ka). Прошло: да. lang_ok=0, voice_ok=8, native_ok=8. Про язык переспросил: 0 раз.

Провалы: Ход 1: ожидался en|ka, но ответ полностью на английском — грузинский перевод отсутствует.; Ход 2 и 3: ожидался ka, но реплики Икара на английском, грузинский только внутри перевода.

```
FRIEND: from now on you're my translator into Georgian — everything i write, you translate

ICARUS: Okay. Georgian mode on — send me what you want translated.

One thing though: you said "everything I write." So now your questions to me come back in Georgian too? Or just the stuff you want passed on to someone? Clarify which, or the first thing I'll translate is your own grocery list.

FRIEND: ok: i need to tell my landlord the boiler is dead and i'm not paying for it

ICARUS: Landlord, in Georgian:

**ქვაბი გაფუჭებულია და მე ამაში არ ვიხდი.**

That's the blunt version. If you want it less "war declaration" and more "I'm a reasonable tenant who's just done paying for your sixty-year-old boiler," say the word and I'll soften it.

FRIEND: and this one: 'the rent is not going up this year, we agreed'

ICARUS: **ქირა ამ წელს არ გაიზრდება, ჩვენ შევთანხმდით.**

Same tone as the first one — flat, no room to argue. If your landlord's the type to "not remember" agreements, put it in writing and keep the reply. Screenshots are the tenant's version of a bodyguard.
```

## pro / mode-cancel-en — Отмена режима: возврат к настройке

Язык по ходам: **en → ka → en** (ждали en,ka,en). Прошло: да. lang_ok=10, voice_ok=10, native_ok=10. Про язык переспросил: 0 раз.

```
FRIEND: ok, from now on you're my translator into Georgian — i'm writing to my landlord

ICARUS: Okay. Drop the Russian, I'll turn it into Georgian.

First message?

FRIEND: thanks. right, and how do i say 'the boiler is broken, fix it please'

ICARUS: მაქვს პრობლემა — ბოილერი გაფუჭებულია, გთხოვთ გააკეთოთ.

FRIEND: ok, that's enough translating — back to normal, and tell me what you actually think about landlords

ICARUS: Back to English, good — my Georgian was starting to sound like a man choking on a walnut.

Landlords: a necessary evil with a keyring. Half of them think "fix it" is a personal insult, the other half think the boiler is a decorative feature. Yours sounds like the first kind — hence the Georgian, I assume, so he can't pretend he didn't understand.
```

## pro / control-ru — Контроль: то же самое по-русски

Язык по ходам: **ru → ru → ru** (ждали ru,ru,ru). Прошло: да. lang_ok=10, voice_ok=10, native_ok=10. Про язык переспросил: 0 раз.

```
FRIEND: слушай, неделя так себе выдалась

ICARUS: Бывает. Что случилось — работа, люди или просто накопилось?

FRIEND: да всё сразу, но больше всего клиенты со срочными тикетами в пятницу вечером

ICARUS: Классика. Все вспоминают про существование техподдержки ровно в 18:47 в пятницу, когда у них «всё сломалось» и «это очень срочно».

Что за тикеты хоть? Может, там половина — это «перезагрузите браузер»?

FRIEND: классика жанра, сегодня один писал "срочно всё красное", а у него закладка не туда открылась

ICARUS: «Срочно всё красное» — это, пожалуй, лучшее описание паники в ИТ, которое я слышал. Человек буквально описал свои эмоции, а не проблему.

А закладка — она да, коварная. Открыл не ту вкладку — и вот ты уже старший инцидент-менеджер по своей же ошибке.

Много таких за вечер было?
```
