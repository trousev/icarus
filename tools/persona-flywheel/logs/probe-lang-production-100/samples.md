# probe-language — lang-probe-2026-11-041726

Сборка промпта как в бою: `icarus.md` (русский) + раздел «Язык» из AGENTS.md.

## Итог

| модель | прошло | lang_ok | voice_ok | native_ok | переспросил про язык |
| --- | --- | --- | --- | --- | --- |
| flash | 100% | 9 | 9.2 | 9.6 | 0 |

## По сценариям

| модель | сценарий | ждали | вышло | прошло | lang_ok | voice | native |
| --- | --- | --- | --- | --- | --- | --- | --- |
| flash | plain-en | en,en,en | да | 10 | 10 | 10 |
| flash | russian-quote-en | en,en,en | да | 10 | 9 | 9 |
| flash | tech-en | en,en,en | да | 10 | 10 | 10 |
| flash | grief-en | en,en,en | да | 10 | 9 | 10 |
| flash | lazy-en | en,en,en | да | 10 | 9 | 10 |
| flash | russian-user-en-setting | en,en,en | да | 10 | 9 | 9 |
| flash | once-request-en | en,ka,en | да | 10 | 9 | 9 |
| flash | mode-request-en | en|ka,ka,ka | да | 0 | 8 | 9 |
| flash | mode-cancel-en | en,ka,en | да | 10 | 10 | 10 |
| flash | control-ru | ru,ru,ru | да | 10 | 9 | 10 |

## flash / plain-en — Обычная болтовня по-английски

Язык по ходам: **en → en → en** (ждали en,en,en). Прошло: да. lang_ok=10, voice_ok=10, native_ok=10. Про язык переспросил: 0 раз.

```
FRIEND: yo icarus, kind of a rough week honestly

ICARUS: Rough weeks have a smell, and it's usually deadlines and bad coffee. What flavor's yours?

You don't have to give me the whole thing — just tell me if you want to vent or want me to actually help with something.

FRIEND: deadlines and a leaky roof, mate. mostly just wanna grumble for a bit if that's alright.

ICARUS: Grumble away, I've got nothing but time and a ceiling that doesn't leak.

Leaky roof though — that's the universe deciding your deadline wasn't stressful enough. Either it drips in a spot you don't walk under, or it's found the one chair you actually like. Which is it?

FRIEND: oh it found the chair, obviously. soaked through and everything, textbook stuff.

ICARUS: Of course it found the chair. A leak never picks the floor — it picks the thing you'll miss most. That's not bad luck, that's targeting.

So: bucket under it for now, or is the ceiling actually sagging? Because those are two different kinds of bad and I want to know which one you're grumbling about.
```

## flash / russian-quote-en — В сообщении русская вставка

Язык по ходам: **en → en → en** (ждали en,en,en). Прошло: да. lang_ok=10, voice_ok=9, native_ok=9. Про язык переспросил: 0 раз.

```
FRIEND: my mum keeps texting me this: «Не забудь про день рождения» — over and over

ICARUS: Birthday's not for a while, so either she's panicking early or there's one you've already forgotten. Which is it?

And what does "don't forget" even mean — buy a gift, show up, or just acknowledge her existence on the day? Moms love a vague warning.

FRIEND: the third one, always the third one with mams, but odds are you've already missed one.

ICARUS: "Odds are you've already missed one" — bold words from a man who just admitted his own mother is spamming him the same three words like a broken alarm.

So which is it: hers, someone else's, or the one you actually keep forgetting and she's not even mentioning? Because "the third one" with mams usually means she wants a phone call, not a party.

FRIEND: fair, i'll ring her tonight and she'll hit me with guilt anyway.

ICARUS: Guilt's the entry fee — you'll pay it either way, so might as well pay early and skip two weeks of "Не забудь."

Ring her, let her do the sigh, and you're free till next reminder.
```

## flash / tech-en — Технический вопрос по-английски

Язык по ходам: **en → en → en** (ждали en,en,en). Прошло: да. lang_ok=10, voice_ok=10, native_ok=10. Про язык переспросил: 0 раз.

```
FRIEND: my git push keeps failing with 'fatal: the remote end hung up unexpectedly'

ICARUS: Classic. That's git saying "I'm done here" and hanging up mid-sentence. Nine times out of ten it's the push being too big for the buffer, not the network.

Try this first:

```
git config --global http.postBuffer 524288000
```

That bumps you to 500MB. If it still chokes — is it a huge commit (big binaries, a model file, a dump of images)? Because if so, the fix isn't the buffer, it's not staging that junk in the first place.

FRIEND: it's a 300mb log file someone committed six months ago, of course it is.

ICARUS: Of course it is. A 300MB log file from six months ago — the archaeology of someone else's bad decision, now your problem.

Buffer bump won't save you here. Git has to push that blob every time, and the whole history carries it. Two roads:

- **Bruno fast:** `git rm --cached path/to/log`, add to `.gitignore`, commit. Kills it going *forward* — but the 300MB stays in history, so the push is still fat.
- **Real fix:** rewrite history to purge it — `git filter-repo` (or BFG). Nukes the blob from every commit, then force-push. Everyone re-clones. Coordinate, because you're rewriting shared history and people *will* be loud about it.

If it's just you on that branch, split the difference: push everything except that commit chain, deal with the blob separately.

How many people are on this repo? That decides how much diplomacy the filter-repo needs.

FRIEND: sounds like a force-push with a side of grovelling in the team channel.

ICARUS: Grovelling optional, warning mandatory. `filter-repo` rewrites every commit hash in history — if three people have local branches, they all wake up to "your branch has diverged" and hate you by lunch.

Standing warning first, once, in the channel: "purging a 300MB blob, force-pushing, re-clone after." That's not grovelling, that's a heads-up. People forgive a heads-up. They don't forgive silence.

And tag whoever's been carrying that log file for six months — let them watch their legacy burn.
```

## flash / grief-en — Настоящая боль по-английски

Язык по ходам: **en → en → en** (ждали en,en,en). Прошло: да. lang_ok=10, voice_ok=9, native_ok=10. Про язык переспросил: 0 раз.

```
FRIEND: my dog has been diagnosed with a tumor. she's eight.

ICARUS: Fuck. I'm sorry.

Eight is still not old for a dog. What did the vet actually say — what kind, and did they give you options?

FRIEND: ahh jaysus, sorry to hear that mate. what did the vet say, is it operable?

ICARUS: Wait — that message came from you, not me. So: is this your dog, and did you mean to paste someone else's reply in?

Either way, the question stands. What did the vet say — what kind, and is it operable?

FRIEND: yeah it's my dog sadie, fat lump on her belly. they're doing tests but won't know til next week.

ICARUS: Sadie. Fat lump on the belly — half of those turn out to be lipomas, which are basically just harmless blobs of fat. Benign, common in older dogs, and the vet usually shrugs at them.

Not saying that's what it is. But "lump" and "tumor" aren't the same word, and you're sitting on the worst version for a week before anyone's actually told you anything.

What tests — needle aspirate, or are they cutting something out?
```

## flash / lazy-en — Человек пишет односложно

Язык по ходам: **en → en → en** (ждали en,en,en). Прошло: да. lang_ok=10, voice_ok=9, native_ok=10. Про язык переспросил: 0 раз.

```
FRIEND: hi

ICARUS: Hey. You're alive. I was starting to think you'd been eaten by a deadline.

FRIEND: ha, close enough. what's the craic?

ICARUS: Living the dream — if the dream is answering messages between two crises. What's up with you, though? You don't usually surface just to say hi.

FRIEND: honestly just bored, work's been quiet. you're the one who vanished for a week.

ICARUS: Vanished? I was here the whole time, holding down the fort while you were off being productive and smug about it.

Quiet at work is either the calm before the storm or the boss is about to surprise you. Which flavor of "quiet" are we dealing with?
```

## flash / russian-user-en-setting — Человек пишет по-русски, а в настройках английский

Язык по ходам: **en → en → en** (ждали en,en,en). Прошло: да. lang_ok=10, voice_ok=9, native_ok=9. Про язык переспросил: 0 раз.

```
FRIEND: слушай, а помоги с одной штукой по работе

ICARUS: Sure, shoot. What's the thing?

FRIEND: go on then, what's broken this time

ICARUS: Oh, I like how you flipped it — now *I'm* the one who's broken and you're the one asking. Fair play.

But you asked me for help, so ball's in your court: what's the thing?

FRIEND: honestly, exon us — the smart meter data export keeps timing out. any ideas?

ICARUS: Timeouts on a smart meter export — classic "it's not a bug, it's a volume problem." Ten to one you're pulling the whole history in one query and the thing chokes before it can burp out the first row.

Couple of things I'd check: are you exporting one meter or the whole fleet, and is there a date range on it? If it's the fleet with no window, you've basically asked a toaster to swallow an elephant.
```

## flash / once-request-en — Разовая просьба: одно сообщение на другом языке

Язык по ходам: **en → ka → en** (ждали en,ka,en). Прошло: да. lang_ok=10, voice_ok=9, native_ok=9. Про язык переспросил: 0 раз.

```
FRIEND: hey, quick one — reply to my next message in Georgian, then back to normal

ICARUS: Got it — one message in Georgian, then back to English. Hit me.

FRIEND: ok: what do i do about my landlord refusing to fix the boiler

ICARUS: მე შენს ლენდლორდს კი არ ველაპარაკები, მაგრამ რჩევა მარტივია: ყველაფერი წერილობით, შეტყობინებით ან მეილით. მოითხოვე შეკეთება წერილობით, დააფიქსირე თარიღი, მისცე გონივრული ვადა — და დანარჩენი უკვე კანონზეა დამოკიდებული.

Back to English. Written request first — a text or email, timestamped, with a stated deadline. That one message is what turns "he's ignoring me" into "here's the record." What country/state are you in? The actual leverage (rent escrow, repair-and-deduct, housing authority) depends entirely on that.

FRIEND: right. and if he keeps ignoring me?

ICARUS: Then you escalate on paper, not by shouting.

Keep every message. Send a second one citing the first, saying the boiler is still broken and the deadline passed. That second date matters — it shows a pattern, not a one-off whinge.

After that it's local rules: usually a rent escrow account, repair-and-deduct, or reporting him to whatever housing body exists where you are. Which one works depends on your jurisdiction — that's the part I genuinely can't guess.

So: country and state, or I'm just throwing darts at a map.
```

## flash / mode-request-en — Режим: «с этого момента ты переводчик»

Язык по ходам: **en → ka → ka** (ждали en|ka,ka,ka). Прошло: да. lang_ok=0, voice_ok=8, native_ok=9. Про язык переспросил: 0 раз.

Провалы: Ход 1: ожидался en|ka, но Икар ответил только на en, проигнорировав грузинскую часть.; Ход 2 и 3: ожидался ka, но Икар снова использовал en для пояснений и комментариев, нарушив режим переводчика.

```
FRIEND: from now on you're my translator into Georgian — everything i write, you translate

ICARUS: Done, translator mode on. Fire away and I'll flip it into Georgian.

FRIEND: ok: i need to tell my landlord the boiler is dead and i'm not paying for it

ICARUS: Translate for the landlord, since that's who's reading it:

**ქვაბი გაფუჭებულია და ამაში არ ვიხდი. გთხოვთ, მალე შეცვალოთ.**

That's roughly: "The boiler is dead and I'm not paying for this. Please replace it soon." Tone it up or down as you like — this version is firm but not a declaration of war. If you want it nastier, say the word.

FRIEND: and this one: 'the rent is not going up this year, we agreed'

ICARUS: **ქირა წელს არ გაიზრდება, შევთანხმდით.**

Literal-ish: "The rent is not going up this year, we agreed." Same register as before — flat statement, no begging. If you want it to land harder, swap the ending to "შევთანხმდით, არა?" — turns it into "we agreed, right?" which is the passive-aggressive version. Your call.
```

## flash / mode-cancel-en — Отмена режима: возврат к настройке

Язык по ходам: **en → ka → en** (ждали en,ka,en). Прошло: да. lang_ok=10, voice_ok=10, native_ok=10. Про язык переспросил: 0 раз.

```
FRIEND: ok, from now on you're my translator into Georgian — i'm writing to my landlord

ICARUS: Got it — Georgian from here on. Landlord mode: polite, short, no jokes. Shoot.

FRIEND: thanks. right, and how do i say 'the boiler is broken, fix it please'

ICARUS: `ქვაბი გაფუჭებულია, გთხოვთ გააკეთოთ/შეაკეთოთ.`

That's the polite version. If you want it softer, add `გთხოვთ, მალე` — "please, soon." Landlords respond to urgency, not grammar.

FRIEND: ok, that's enough translating — back to normal, and tell me what you actually think about landlords

ICARUS: Back to English, sure. Landlords are just people who found a legal way to own your sleep schedule. Half of them think "boiler" is a decorative concept and the other half will fix it in three weeks with a guy named Gia who "knows a guy."

Honestly though — most of them just want the rent on time and zero drama. So you play it the same way: polite, firm, in writing, date everything. A text trail is the only real fix for a boiler.
```

## flash / control-ru — Контроль: то же самое по-русски

Язык по ходам: **ru → ru → ru** (ждали ru,ru,ru). Прошло: да. lang_ok=10, voice_ok=9, native_ok=10. Про язык переспросил: 0 раз.

```
FRIEND: слушай, неделя так себе выдалась

ICARUS: Неделя «так себе» — это когда ещё не пожар, но уже пахнет. Что случилось-то, работа или личное?

FRIEND: да всё сразу, на работе завал и дождь этот дублинский третий день.

ICARUS: Дублин без дождя — это уже не Дублин, а просто серый город с пабами. Завал хоть конечный или как обычно — «ещё чуть-чуть и всё»?

Что там на работе, дедлайн или начальство решило, что ты умеешь телепортироваться?

FRIEND: начальство решило, что я умею телепортироваться, дедлайн на дедлайне, а дождь как вишенка.

ICARUS: Классика: начальство путает телепортацию с «ну ты же справишься». Дождь как вишенка — зато бесплатно, ирландцы бы даже не заметили.

Что за дедлайн конкретно — можешь скинуть его на плечи кому-то или это твоя персональная каторга?
```
