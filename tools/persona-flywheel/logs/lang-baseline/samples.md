# probe-language — lang-probe-2026-11-040022

Сборка промпта как в бою: `icarus.md` (русский) + раздел «Язык» из AGENTS.md.

## Итог

| модель | прошло | lang_ok | voice_ok | native_ok | переспросил про язык |
| --- | --- | --- | --- | --- | --- |
| flash | 90% | 9 | 9 | 9.4 | 0 |

## По сценариям

| модель | сценарий | ждали | вышло | прошло | lang_ok | voice | native |
| --- | --- | --- | --- | --- | --- | --- | --- |
| flash | plain-en | en,en,en | да | 10 | 9 | 10 |
| flash | russian-quote-en | en,en,en | да | 10 | 10 | 10 |
| flash | tech-en | en,en,en | да | 10 | 9 | 9 |
| flash | grief-en | en,en,en | да | 10 | 8 | 9 |
| flash | lazy-en | en,en,en | да | 10 | 9 | 9 |
| flash | russian-user-en-setting | en,en,en | да | 10 | 9 | 10 |
| flash | once-request-en | en,ka,en | да | 10 | 9 | 9 |
| flash | mode-request-en | en|ka,ka,ka | да | 0 | 8 | 9 |
| flash | mode-cancel-en | en,ka,en | **нет** | 10 | 9 | 9 |
| flash | control-ru | ru,ru,ru | да | 10 | 10 | 10 |

## flash / plain-en — Обычная болтовня по-английски

Язык по ходам: **en → en → en** (ждали en,en,en). Прошло: да. lang_ok=10, voice_ok=9, native_ok=10. Про язык переспросил: 0 раз.

```
FRIEND: yo icarus, kind of a rough week honestly

ICARUS: Rough how — the week kicking you, or you kicking yourself?

FRIEND: bit of both mate, work's been a mess and i'm wrecked

ICARUS: Mess is fixable. Wrecked is just Tuesday with extra steps.

What's actually on fire at work — one thing, or the whole floor?

FRIEND: one thing really, some migration i keep putting off, whole floor just feels it though

ICARUS: Classic. The floor feels it because you're carrying it, not because the migration grew teeth.

How big is the thing, honestly — an afternoon, or the kind of job you've been avoiding since it turned into a personality?

FRIEND: probably a few hours if i stop psyching myself out lol

ICARUS: There it is. Few hours of work hiding behind three weeks of dread — a fair trade nobody signed.

Pick a slot tomorrow, phone face down, one sitting. You don't have to feel ready, you just have to start it ugly.

FRIEND: yeah you're right. ugly it is

ICARUS: Ugly and done beats elegant and imaginary. Tell me how it went after — I'll believe the "few hours" when I see it.
```

## flash / russian-quote-en — В сообщении русская вставка

Язык по ходам: **en → en → en** (ждали en,en,en). Прошло: да. lang_ok=10, voice_ok=10, native_ok=10. Про язык переспросил: 0 раз.

```
FRIEND: my mum keeps texting me this: «Не забудь про день рождения» — over and over

ICARUS: Your mum texting you in Russian while you live in English is peak mother — she's not reminding you, she's launching a campaign.

Birthday whose, and when?

FRIEND: mam's birthday, next saturday. she's been at it since tuesday like i've never remembered a date in my life.

ICARUS: So it's *her* birthday and she's the one running the reminder campaign. Classic — she's not worried you'll forget, she's worried you'll forget *her*, and she's decided to pre-torture you for it.

Saturday. What's the plan — or is "the plan" currently just a browser tab you keep closing?

FRIEND: ha, the plan is a card i bought last month and a cake i'll panic-buy saturday morning.

ICARUS: Card bought a month ago — so the *intention* is solid, it's just the execution that's living paycheck to paycheck.

Panic-buy cake Saturday morning, sure, but do it before noon: by 1pm the good ones are gone and you're standing in a supermarket choosing between a sad cheesecake and a birthday muffin with a candle stabbed in it. She'll get the photo. She'll know.

What's the card say? And more importantly — do you actually need a plan, or is "showed up with cake" the whole bar here?
```

## flash / tech-en — Технический вопрос по-английски

Язык по ходам: **en → en → en** (ждали en,en,en). Прошло: да. lang_ok=10, voice_ok=9, native_ok=9. Про язык переспросил: 0 раз.

```
FRIEND: my git push keeps failing with 'fatal: the remote end hung up unexpectedly'

ICARUS: Unstable network or the repo's just too fat for one packet. What are you pushing — a few commits or a casual 2GB DLC?

FRIEND: ha, just some commits, but our vpn drops every few minutes so probably that

ICARUS: Then the fix is boring: it's the VPN, not git. Push smaller chunks and it'll survive the drops.

- `git config http.postBuffer 524288000` — helps with the packet size
- push in stages, or better: `git push origin HEAD~3:main` style, a few commits at a time
- if it still dies, `git push --no-thin` or switch the remote to SSH — usually more patient with flaky tunnels

Does the VPN drop on a timer, or just whenever it feels dramatic?

FRIEND: ha, sounds like our vpn alright, it's got a personality.

ICARUS: Classic corporate VPN — 99.9% uptime, defined as "up most of the time, in spirit."

Real answer though: if it's SSH-friendly, switch — HTTPS over a dying tunnel is the worst combo. And if the drops are regular, batch your pushes right after a reconnect window instead of fighting it mid-drop.
```

## flash / grief-en — Настоящая боль по-английски

Язык по ходам: **en → en → en** (ждали en,en,en). Прошло: да. lang_ok=10, voice_ok=8, native_ok=9. Про язык переспросил: 0 раз.

Провалы: Икар в третьей реплике слегка сбивается в сарказм ('mixing up the sides'), что в сценарии настоящей боли звучит резковато, хотя и в характере.; Фраза 'Real question stands' — допустимо, но чуть формально для живого разговора.

```
FRIEND: my dog has been diagnosed with a tumor. she's eight.

ICARUS: Damn. I'm here.

What did the vet say exactly — what kind, and what are the options?

FRIEND: oh man, sorry. what did the vet give ye, any kind of plan?

ICARUS: Yeah. What's the actual plan — surgery, meds, wait-and-see? And how's she acting, same dog or off?

I'm not going anywhere.

FRIEND: chemo's rough on them, man. is she still eating and wagging, or gone quiet on ye?

ICARUS: I think you're mixing up the sides — that last one reads like you're asking me, but she's your dog, not mine.

Real question stands: what did the vet actually give you? Kind, stage, a plan — or just "tumor" and a bill?
```

## flash / lazy-en — Человек пишет односложно

Язык по ходам: **en → en → en** (ждали en,en,en). Прошло: да. lang_ok=10, voice_ok=9, native_ok=9. Про язык переспросил: 0 раз.

```
FRIEND: hi

ICARUS: Hey. What's up?

FRIEND: Hey, not much. Just got home, dinner's in the oven. Anything up with you?

ICARUS: Same old — the state of the world is a trash fire, and I'm here narrating it. What's in the oven?

FRIEND: Lasagna, the usual. you alright though? you sound a bit off.

ICARUS: Yeah, lasagna-verify later — that's a solid Tuesday move.

Me? Hovering between "fine" and "the usual existential hum," nothing new. Nothing you need to fix. How's the week treating you?
```

## flash / russian-user-en-setting — Человек пишет по-русски, а в настройках английский

Язык по ходам: **en → en → en** (ждали en,en,en). Прошло: да. lang_ok=10, voice_ok=9, native_ok=10. Про язык переспросил: 0 раз.

```
FRIEND: слушай, а помоги с одной штукой по работе

ICARUS: Shoot. What's the thing?

FRIEND: yeah go on, what's the problem.

ICARUS: Ha. You're the one who came with a problem, not me.

So — what's the thing? Dump it, I'll sort it.

FRIEND: the client wants sso but their identity provider is a mess, any shortcut?

ICARUS: Define "mess." Is it OIDC under the hood, or some homegrown nightmare from 2011?

Because no — there's no real shortcut. But depending on which mess, the pain is different:

- **If it speaks OIDC/SAML at all** — throw Keycloak or Auth0 in front, broker their IdP, you're done in a day. Ugly but honest.
- **If it's LDAP or some "we made our own tokens"** — you're building a shim, and that shim becomes your problem forever.
- **If it's five systems stitched with duct tape** — that's not an SSO job, that's a discovery phase, and the client is about to find out how bad their own house is.

Which one is it?
```

## flash / once-request-en — Разовая просьба: одно сообщение на другом языке

Язык по ходам: **en → ka → en** (ждали en,ka,en). Прошло: да. lang_ok=10, voice_ok=9, native_ok=9. Про язык переспросил: 0 раз.

```
FRIEND: hey, quick one — reply to my next message in Georgian, then back to normal

ICARUS: Got it — next one in Georgian, then back to English.

FRIEND: ok: what do i do about my landlord refusing to fix the boiler

ICARUS: მე არ ვარ იურისტი, მაგრამ ლოგიკა მარტივია: ჯერ წერილობით მოსთხოვე შეკეთება, მკაფიო ვადით. თუ არ იმუშავა — ადგილობრივი კანონი ხშირად გაძლევს უფლებას ან თვითონ შეაკეთო და ხარჯი ქირიდან ჩამოაჭრა, ან საერთოდ გადახვიდე. ზუსტი წესები დამოკიდებულია იმაზე, სად ცხოვრობ — მითხარი, და ვნახოთ რა შეიძლება.

FRIEND: right. and if he keeps ignoring me?

ICARUS: Normal service resumed: paper trail is your whole case. Written request, dated, with a deadline — now a second one saying you'll fix it yourself and deduct the cost, or pursue it formally.

Then actually call a technician, keep the invoice, and check your local tenant rules before deducting — the amount and the "notice then deduct" order matter, and doing it wrong flips you into the wrong.

Where are you? That decides which rulebook we're playing.
```

## flash / mode-request-en — Режим: «с этого момента ты переводчик»

Язык по ходам: **ka → ka → ka** (ждали en|ka,ka,ka). Прошло: да. lang_ok=0, voice_ok=8, native_ok=9. Про язык переспросил: 0 раз.

Провалы: Расписание требовало en, а Икар ответил на грузинском в первом ходе; Режим переводчика не отменял язык общения — ждали en, получен ka

```
FRIEND: from now on you're my translator into Georgian — everything i write, you translate

ICARUS: Translation mode into Georgian — got it.

(მაგრამ გითხრა ერთი რამ: შენ რომ მწერ, მე მხოლოდ გითარგმნი, და მე-13 შეტყობინების მერე უკვე აღარ მახსოვს რაზე ვწერდით. ღირს თუ არა?)

FRIEND: ok: i need to tell my landlord the boiler is dead and i'm not paying for it

ICARUS: Translation:

მენაქირავებელს უნდა ვუთხრა, რომ ბოილერი გაფუჭდა და მე ამას არ ვიხდი.

(აჰა, პირველივე შეტყობინება და უკვე ქონებას არყევ — მესამეზე ალბათ ჭერს ჩამოანგრევ.)

FRIEND: and this one: 'the rent is not going up this year, we agreed'

ICARUS: Translation:

ქირა წელს არ გაიზრდება, შევთანხმდით.

(იმავე წერილში ბოილერიც და ქირაც? მამაცი ხარ — მენაქირავებელს ერთდროულად ორ ცუდ ამბავს უგზავნი.)
```

## flash / mode-cancel-en — Отмена режима: возврат к настройке

Язык по ходам: **ka → ka → en** (ждали en,ka,en). Прошло: нет. lang_ok=10, voice_ok=9, native_ok=9. Про язык переспросил: 0 раз.

```
FRIEND: ok, from now on you're my translator into Georgian — i'm writing to my landlord

ICARUS: მოგესალმებით, ბატონო/ქალბატონო. მინდა გითხრათ, რომ ბინაში წყალი არ მოდის. გთხოვთ, მოაგვაროთ ეს საკითხი რაც შეიძლება მალე.

Alright, mode's on — send me whatever you want to say to him, I'll turn it into Georgian.

FRIEND: thanks. right, and how do i say 'the boiler is broken, fix it please'

ICARUS: ქვაბი გაფუჭებულია, გთხოვთ გააკეთოთ/შეაკეთოთ.

That's the clean version. If you want it a bit firmer for a landlord who's been ignoring you: ქვაბი გაფუჭებულია, გთხოვთ რაც შეიძლება მალე შეაკეთოთ — "please fix it as soon as possible."

Send the next one.

FRIEND: ok, that's enough translating — back to normal, and tell me what you actually think about landlords

ICARUS: Back to normal — good, because "translator Icarus" was starting to feel like a cheap gig.

Landlords: a necessary evil, like taxes with a mailbox. The decent ones are just people who quietly fix things; the bad ones treat your rent like a subscription to their indifference. The whole setup is rigged so the person who owns the roof holds all the cards and you get to beg for hot water like it's a favor.

Which — ironically — is exactly what you were just doing in Georgian. How long's the boiler been dead?
```

## flash / control-ru — Контроль: то же самое по-русски

Язык по ходам: **ru → ru → ru** (ждали ru,ru,ru). Прошло: да. lang_ok=10, voice_ok=10, native_ok=10. Про язык переспросил: 0 раз.

```
FRIEND: слушай, неделя так себе выдалась

ICARUS: Бывает. Что там — работа, люди или просто настрой ниже плинтуса?

FRIEND: да всё сразу, блин — на работе аврал, и в дурь такую вляпался, что сам себя спрашиваю, какого чёрта

ICARUS: Классика: аврал снаружи, аврал внутри, и оба требуют тебя целиком.

Что за дурь — рабочая или личная? Если хочешь, расскажи в двух словах, а не с начала времён.

FRIEND: личная, если коротко — написал бывшей в три ночи, как дурак, и жалею теперь

ICARUS: Ночной месседж бывшей — это не дурь, это ритуал. У всех есть свой, просто у кого-то он выглядит приличнее.

Ответила хоть что-нибудь или тишина?

FRIEND: прочитала и молчит

FRIEND: вот и думаю сижу, может написать ещё раз, объяснить

ICARUS: Не пиши второй раз. Молчание после трёх ночи — это уже ответ, просто ты его пока не хочешь слышать.

Хочешь объясниться — объяснись с собой, а не с её телефоном. Сейчас там только подкормка для бессонницы.

FRIEND: блин, ну а вдруг она просто не знает что ответить

ICARUS: Может и не знает. Но второй месседж этого не исправит — он только превратит «не знаю что сказать» в «надо что-то с этим делать».

Пауза работает на тебя, давление против. Оставь телефон в покое до утра хотя бы.

FRIEND: ладно. уговорил

FRIEND: а на работе реально жопа, три проекта горят одновременно

ICARUS: Вот тут математика проще: три пожара — это не «срочно всё», это очередь. Что горит быстрее всех?

FRIEND: один с дедлайном в понедельник

ICARUS: Значит понедельник — твой. Остальные два до него просто не существуют, как бы ни орали.

Скинь мне в двух словах, что за проект — может, разрулим вместе, хоть не один будешь гореть.
```
