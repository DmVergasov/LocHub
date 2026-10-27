---
layout: post
title: "Localize a Chinese-source Unreal Engine game into English, Japanese and Korean"
description: "Set the native culture to zh-Hans, add en, ja and ko, tune Length Check for CJK text and run the first translation job in LocHub."
---

Most Unreal Engine localization guides assume the game is written in English. If your strings are written in Chinese,
the steps are the same, but a few settings need to be chosen on purpose: the source language, the target cultures,
and the length limits for text that goes from a CJK language into English. This guide walks through them with
[LocHub](https://github.com/DmVergasov/LocHub), an editor plugin for Unreal Engine 5.6, 5.7 and 5.8 that translates
your project's text with an AI provider you choose, lets you review it in the editor, and writes it back into Unreal's
own `.archive` and `.locres` files. Source language support for Chinese, Japanese and any other language the engine
knows arrived in LocHub 1.2.0; earlier versions assumed an English source.

LocHub is source-available under the Business Source License 1.1: free in production for personal projects,
education, academic research, game jams and games given away free with no monetization. Other production use needs a
license purchased on Fab.

## Before you start

- Unreal Engine 5.6, 5.7 or 5.8. Windows is the tested platform.
- Node.js 22.11 or newer: LocHub runs a small local service on `127.0.0.1`.
- LocHub 1.2.0 or newer, enabled in your project.
- An AI provider. LocHub works with your own key for Anthropic (Claude), OpenAI, xAI (Grok), DeepSeek and Google
  Gemini, or with any OpenAI-compatible endpoint, including local models. Only the strings a job translates, their
  notes and your glossary are sent to the provider. Pick the provider in **Project Settings > Plugins > LocHub**.

## 1. Make Chinese the native culture

LocHub translates from the localization target's **native culture**: the language your source text is written in.
For a new target you choose it before setting the target up.

1. Open **Project Settings > Plugins > LocHub** and find the **Localization Target** category.
2. Set **Setup Native Culture** to `zh-Hans` (Simplified Chinese). The default is `en`.
3. Under **Setup Foreign Cultures**, list the languages you are translating into. The default is `de`, `fr`, `es` and
   `ja`. For this guide, use `en`, `ja` and `ko`. Because Chinese is now the native culture, `en` has to be in this list
   if you want English as a translation.

Culture names the engine does not recognize are skipped (foreign cultures) or fall back to `en` (the native culture),
and the Set Up summary tells you when either happens. Read that summary after the next step rather than assuming it
worked.

If your project already has a localization target, it keeps its native culture. LocHub's Set Up summary says so when
that differs from the setting. To change an existing target's native culture, use Unreal's **Window > Localization
Dashboard**.

## 2. Set up the target, gather and push

1. Go to **Tools > LocHub > Set Up Localization Target**. This creates the `Game` target if it does not exist, or
   completes an existing one: it adds the foreign cultures, points text and asset gathering at your `Source` and
   `Content` folders, turns on format-pattern and rich-text validation and makes LocHub the active Localization Service
   Provider. It only adds what is missing, so running it twice is harmless. Every run adds listed cultures the target
   lacks and never removes one.
2. Gather text with **Window > Localization Dashboard** or your project's usual Gather Text step. LocHub does not
   gather for you.
3. Run **Tools > LocHub > Push (Dry Run)** to see what would be added, changed or retired, then **Tools > LocHub >
   Push**.

Before pushing a large project, open the **Coverage** tab in LocHub. It reports player-visible strings that bypass
localization, such as a literal `FText::FromString`, and those are not translated.

## 3. Add a glossary before the first job

Names, skills and items in a game tend to have an established rendering in each language. Open the **Glossary** tab,
pick a culture and add terms: the source term (in Chinese), its translation in that culture, and a **Do not translate**
flag for words that must stay as written. A **Note** field carries guidance for the model, for example about gender or
grammatical case. Each culture has its own glossary and style guide, and **Import CSV** loads terms in bulk.

For tone and setting, fill in **Project Settings > Plugins > LocHub > AI > Project Brief**: what the game is, its setting
and tone, and who the player is. It goes to the translator and to the judge with every request.

If you change a term later, LocHub offers **Apply to N strings** to reject the AI drafts that do not
follow it, and the next job sends them again.

## 4. Set length limits for CJK text

Chinese packs a lot of meaning into few characters, so translations into English are often longer than the source,
and your buttons and labels have a fixed size. **Length Check** flags translations likely to overflow the UI and tells
the AI each string's limit up front.

Open **Project Settings > Plugins > LocHub > Length Check**:

![Project Settings > Plugins > LocHub > Length Check](/LocHub/assets/11_length_check_settings.png)

- **Enable Length Check** is on by default. **Length Check Scope** defaults to **UI strings**, which covers strings sent
  as widget text; choose **All strings** to check everything.
- **Max Length Ratio** defaults to `1.3`. LocHub's documentation advises starting around `1.8` for a Chinese, Japanese
  or Korean source translated into a Latin-script language such as English. Chinese, Japanese and Korean characters
  count as 2 when LocHub measures visible length, but a translation usually still needs more room.
- **Culture Ratio Overrides** sets a different ratio for one culture or a whole language. Use it
  to give `en` a different ratio from `ja` or `ko`; choose the values by looking at your UI.
- **Tell the Translator** is on by default and sends each limit with the request. A draft that comes back too long is
  sent back once per job for a shorter wording.
- **Length Severity** is **Warning** by default: an over-long translation is flagged and can still be approved. With
  **Must Confirm**, approving needs **Approve anyway** and an over-long AI draft is written **Needs fix**, which the next
  job translates again.

The limit is computed from the visible length of the source: placeholders such as `{0}` and rich-text tags count 0, and
CJK characters count 2. For a source of 11 visible characters, the default ratio of `1.3` and the default 4 extra
characters give a limit of 19 (11 × 1.3 = 14.3, rounded up to 15, plus 4). Run the same arithmetic with your ratio to
see what your buttons will get.

## 5. Run the job

Open **Tools > LocHub > Open LocHub** and switch to the **Jobs** tab.

1. Pick a culture, for example `en`, and optionally narrow the scope to one group or folder.
2. Click **Estimate**. You get the number of strings and requests, token counts and, for a paid provider, an estimated
   cost. For cost estimates LocHub counts each Chinese, Japanese or Korean character as one token. The estimate is a
   best case, and the job report shows the real cost.
3. Enter a **Max USD** budget (it is pre-filled about 20% above the estimate), then click **Run**.

![Jobs tab with an estimate](/LocHub/assets/05_jobs.png)

The job translates, runs a deterministic consistency check and, optionally, a second AI pass that judges meaning,
terminology and tone. Start with the language you can check yourself, usually English, then run `ja` and `ko`. Each
culture is its own job.

## 6. Review, then Pull

In the **Review** tab, the riskiest strings come first. Format arguments such as `{0}` and `{PlayerName}`, plural forms
and rich-text tags are validated by LocHub and again by Unreal's own validator, so a *hard* issue blocks Approve and
Save. Approve what is right, edit what is not, and reject with a short reason to send a string back. Human edits are
never overwritten by a later job.

Before you Pull, check fonts. In Project Settings, **Glyph Check Fonts** and **Glyph Check Font Files** list the fonts
your UI uses, and Pull rejects a translation containing a character that a listed font cannot draw. When both lists are
empty, the glyph check is off.

Then run **Tools > LocHub > Pull**. It writes the released translations into your localization archives and compiles
`.locres`. Output is ordinary Unreal localization data, so you can stop using LocHub at any time.

## Summary

For a Chinese-source game: set **Setup Native Culture** to `zh-Hans`, list `en`, `ja` and `ko` as foreign cultures, add
glossary terms and a Project Brief, raise **Max Length Ratio** for Latin-script targets, estimate, run, review and Pull.

LocHub is on [GitHub](https://github.com/DmVergasov/LocHub) and
[Fab](https://www.fab.com/listings/aaf6a7ae-e02e-4975-91b4-129e2456e491), and the full
[documentation](https://app.notion.com/p/LocHub-3e7fed51161881b6be04fb732972cb38) covers every setting named above. A
Simplified Chinese README is available on [GitHub](https://github.com/DmVergasov/LocHub/blob/main/README.zh-CN.md).

*Drafted by LocHub's AI assistant; every step and setting is checked against the LocHub documentation.*
