---
layout: post
title: "Why AI translations break {0} and plural forms in Unreal, and how to catch it"
description: "How machine translation damages format arguments, plural forms and rich-text tags in Unreal text, and how LocHub's format checks stop broken text before it ships."
---

A machine-translated string can read perfectly and still be broken for the game. Unreal Engine text is not plain prose: it carries format arguments such as `{0}` or `{PlayerName}`, plural modifiers such as `{Count}|plural(one=…,other=…)`, and rich-text tags such as `<Bold>…</>`. A translation that mangles any of these can show raw braces to the player, drop a value, or fail Unreal's own validation. This guide explains the common ways it happens and how to catch each one in LocHub's Review queue before anything is written back to your project.

## What goes wrong

Language models translate meaning. They do not know that `{0}` is a slot the engine fills at runtime. The failures that show up most often fall into a few groups.

**Unbalanced or broken syntax.** An unmatched `{` or `}`, or a `|plural(...)` modifier whose parentheses or form names were altered. The player would see the raw text. LocHub reports this as `syntax`.

**Invented or missing arguments.** The model adds an `{Argument}` the source never had (the game never fills it in, so the player sees `{Argument}` literally), or leaves one out. LocHub reports these as `args_extra` and `args_missing`.

**Wrong plural forms.** English has two plural forms in this kind of string, `one` and `other`. Other languages need more or fewer: the [Unicode CLDR plural rules](https://cldr.unicode.org/index/cldr-spec/plural-rules) define the categories per language, and a Russian or Polish string needs forms an English source does not have. A model may copy the English two-form modifier, leave a required form out, or include one the language does not use.

**Plural modifier dropped.** The model rewrites the sentence so the count no longer needs a modifier, and the plural logic disappears.

**Rich-text tags changed.** A `<Bold>` is left without its closing `</>`, or one styled span is split in two.

**Do-not-translate terms altered.** A name or product term that must stay as written gets translated.

## How LocHub checks for this

Every translation in LocHub (an AI draft, your own edit, or the text you are about to approve) goes through the same format check. According to the LocHub documentation, format arguments, plural forms for every target language and rich-text tags are validated twice: by LocHub, and again by Unreal's own validator right before anything is written. The check sorts problems into two kinds.

### Problems Unreal would reject

These keep **Approve** and **Save** disabled, with the hint "Fix the problems above first":

- `empty`: the translation is empty.
- `syntax`: an unmatched `{` or `}`, a broken `|plural(...)`-style modifier, or a plural form name Unreal cannot read.
- `args_extra`: an `{Argument}` the source does not have.
- `plural_redundant`: a `|plural` or `|ordinal` modifier in a language that has only one form for it.
- `plural_forms_missing` and `plural_form_unused`: a plural form the language needs is missing, or one it does not use is present. LocHub uses the plural forms your version of Unreal itself reports for each language, sent with every Push, because Unreal's language data can differ from newer tables.
- `rich_tags_unbalanced`: every `<Tag>` needs a closing `</>`, unless the source is unbalanced the same way.

### Warnings

Unreal accepts the text, but it looks wrong:

- `args_missing`: an argument of the source is left out. This is fine when the phrase does not need it, for example a count the sentence does not repeat.
- `plural_dropped`: the source's `|plural(...)` modifier was dropped.
- `rich_tags`: the tags differ from the source.
- `dnt`: a glossary term marked "Do not translate" is not kept exactly as written.
- `plural_unknown_form`: a plural form name Unreal does not know and simply ignores.

With only warnings, the cell panel shows them in a yellow box under the line "Unreal accepts this text, but it looks wrong. Approve anyway if it is intended." The buttons then read **Approve anyway** and **Save anyway**, and your confirmation is recorded in the string's history. The `A` keyboard shortcut never approves a text with warnings.

## Step by step: catching a broken string

1. **Run a translation job.** Open the **Jobs** tab, pick the culture, group or folder, and check the estimate (string count, token counts, estimated USD) against the **Max USD** cap before you start.
2. **Let the job retry for you.** A translation job holds its own drafts to both kinds of problem. A draft with a problem or a warning goes back to the model for a fix. If it still has one, it is marked **Needs fix**, so nothing suspicious ships without a human deciding.
3. **Open the Review queue.** The queue lists **Needs fix** cells first, then Red-band drafts, then Yellow, then a small blind-audit sample of Green drafts. A draft that failed a format check lands in the Red band, so it is reviewed first.
4. **Read the checks in the cell panel.** The panel shows the source, the editable translation and the format check, which runs when the panel opens and again as you type. The **Context** section lists the `{Argument}`-style placeholders found in the source, which makes it easy to compare against the translation.
5. **Fix or send back.** Edit the text and watch the problem list clear, or use **Retranslate** with a note on what to fix (optionally ticking **as a style rule** to append the note to the culture's style guide). **Reject** sends the string back to translation.
6. **Approve.** Press `A`, or click **Approve anyway** when only warnings remain and you have decided they are intended.
7. **Spot-check in the game.** **Apply live** pushes one string, and **Apply \<culture\> live** in the Grid toolbar pushes every valid translation loaded for that culture, to the editor for a preview without a full Pull. It skips rejected and needs-fix cells.

In the Grid you can also filter by **Status: Needs fix** or **Band: Red** to see every string that failed a check across the project.

![Review queue](/LocHub/assets/06_review_queue.png)

## Plural forms in practice

Plural problems are the least obvious, because the sentence reads correctly in a spreadsheet. LocHub's check compares the forms in the translation with the forms the target language needs, so a Russian string that copies the English `one`/`other` pair is flagged as `plural_forms_missing` rather than slipping through. A language with a single form for a modifier gets `plural_redundant` if the modifier is kept.

Two things to remember when you review:

- Translate every branch of a plural modifier. For XLIFF export, an argument with a plural, ordinal or gender modifier stays plain text rather than a protected placeholder, since its branches need translating; the format check on import catches a broken one.
- Arguments without a modifier (`{Name}`, `{0}`) and rich-text tags (`<Bold>`, `</>`, `<img id="coin"/>`) are written as protected `<ph>` placeholders in XLIFF, so a translator's CAT tool keeps them intact.

## Checks at the end of the pipeline

On Pull, the plugin checks every translation with Unreal's own validator once more and refuses only what Unreal refuses, plus characters missing from your glyph-check fonts. A text you approved anyway is written like any other. Human edits are never overwritten by the AI, and the output is ordinary `.archive` and `.locres` files, so you can inspect or stop using the workflow at any time.

## Where to go next

LocHub is source-available under the Business Source License 1.1: free to read, modify and use, and free in production for personal projects, education, academic research, game jams, and games given away free with no monetization. Other production use needs a license purchased on Fab. You can find the code on [GitHub](https://github.com/DmVergasov/LocHub), the plugin on [Fab](https://www.fab.com/listings/aaf6a7ae-e02e-4975-91b4-129e2456e491), and the full instructions in the [documentation](https://app.notion.com/p/LocHub-3e7fed51161881b6be04fb732972cb38). The page on Grid and Review covers the format checks in full.

*Drafted by LocHub's AI assistant; every step and setting is checked against the LocHub documentation.*
