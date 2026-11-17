layout: post
title: "Unreal plural forms (ICU/CLDR) explained for localizers"
description: "What plural categories like one, few and many mean, how Unreal text uses them, and how to review them in LocHub without a hand-made plural table."
---

If you localize an Unreal Engine game, sooner or later you meet a line like `{Count}|plural(one=item,other=items)` in the Localization Dashboard, and then a translator asks which plural forms their language needs. This guide explains what those form names mean, where they come from, and how to review them in LocHub so a string such as "You have 5 coins" reads correctly in Russian, Polish or Arabic as well as in English.

## What a plural form is

A plural form is a *category* of numbers that a language treats alike. It is not the same as "singular" and "plural". The categories come from the Unicode CLDR project, whose [plural rules specification](https://cldr.unicode.org/index/cldr-spec/plural-rules) defines six names: `zero`, `one`, `two`, `few`, `many` and `other`. A language uses only the subset it needs, and every language has `other`.

The [CLDR language plural rules chart](https://www.unicode.org/cldr/charts/latest/supplemental/language_plural_rules.html) lists the categories and the numbers that fall into each one. A few examples from that chart:

- **English** uses `one` and `other`. One coin, two coins.
- **Russian** and **Polish** use `one`, `few`, `many` and `other`. In Russian, 1 and 21 take `one`, 2 to 4 and 22 to 24 take `few`, and 5 to 20 take `many`; `other` covers fractions.
- **Chinese, Japanese and Korean** use only `other`. The noun does not change with the count.
- **Arabic** uses all six.

The practical consequence: a translation cannot be a word-for-word copy of the English pair. A Russian string needs more branches than English, and a Japanese string needs fewer. The ICU project describes the same model in its [message formatting guide](https://unicode-org.github.io/icu/userguide/format_parse/messages/).

## How it looks in Unreal text

In Unreal, a plural lives inside the string as a modifier on a format argument. The LocHub documentation writes it like this:

```
{Count}|plural(one=item,other=items)
```

The argument (`{Count}`) is filled in at runtime, and the branches after `|plural(` are the text for each form. Argument modifiers also come as `|ordinal(...)` and `|gender(...)`, which the LocHub documentation treats in the same way.

A Russian translation of that string needs a different set of names, for example `one`, `few`, `many` and `other`, each with its own word. Writing the English pair into a Russian string means that for 5 coins the game has no branch for `many`.

## Why AI translation trips on plurals

A language model translates the sentence it can see. It does not know which categories Unreal will ask for in the target language. Typical failures:

1. It keeps the English `one`/`other` pair in a language that needs more forms.
2. It adds a form the language does not use.
3. It rewrites the sentence so the count is no longer in a modifier, and the plural logic disappears.
4. It translates the form names themselves, so Unreal cannot read them.

LocHub checks for each of these. The check is described in the documentation's "Format checks" section.

## How LocHub checks plural forms

Every translation in LocHub, whether an AI draft, your edit or the text you are about to approve, goes through the same format check. Plural problems fall into two groups.

**Problems Unreal would reject.** Approve and Save stay disabled, with the hint "Fix the problems above first":

- `plural_forms_missing`: a plural form the language needs is missing.
- `plural_form_unused`: a form the language does not use is present.
- `plural_redundant`: a `|plural` or `|ordinal` modifier in a language that has only one form for it.
- `syntax`: a broken `|plural(...)`-style modifier, or a plural form name Unreal cannot read.

**Warnings.** Unreal accepts the text, but it looks wrong:

- `plural_dropped`: the source's `|plural(...)` modifier was dropped.
- `plural_unknown_form`: a plural form name Unreal does not know and simply ignores.

One detail matters if you compare LocHub with a CLDR chart. LocHub uses the plural forms *your version of Unreal itself* reports for each language, and sends them with every Push, because Unreal's language data can differ from newer tables. The README adds that plural forms are read from the engine on Push, so there is no hand-maintained plural table to keep in sync. If a chart and the check disagree, the check follows your engine.

## Step by step: reviewing a plural string

1. **Run a job.** In the **Jobs** tab, choose the culture, group or folder and check the estimate and the **Max USD** cap before you start.
2. **Let the job retry.** A draft with a problem or a warning goes back to the model for a fix. If it still has one, it is marked **Needs fix**.
3. **Open the Review queue.** It lists **Needs fix** cells first, then Red-band drafts, then Yellow, then a small sample of Green drafts. A draft that failed a format check lands in the Red band.
4. **Read the format check in the cell panel.** It runs when the panel opens and again as you type. The **Context** section lists the `{Argument}` placeholders found in the source.
5. **Fix or send back.** Edit the branches until the problem list clears, or use **Retranslate** with a note, for example "Russian needs one, few, many and other". Ticking **as a style rule** appends the note to the culture's style guide.
6. **Approve.** Press `A`. If only warnings remain and you decided they are intended, click **Approve anyway**; the confirmation is recorded in the string's history.
7. **Spot-check in the editor.** **Apply live** pushes one string to the editor for a preview without a full Pull.

In the Grid you can filter by **Status: Needs fix** or **Band: Red** to see every string that failed a check across the project.

![Cell panel with the format check](/LocHub/assets/14_cell_panel.png)

## Translating plural strings for an agency

If you send text to a vendor, LocHub exports XLIFF 1.2 or CSV. In XLIFF, format arguments without a modifier, such as `{Name}` or `{0}`, are written as protected `<ph>` placeholders so the CAT tool keeps them intact. An argument with a plural, ordinal or gender modifier stays plain text, because its branches need translating. When the vendor's work comes back, the same format check runs on import, with a preview, so a missing `few` or `many` branch is caught before the string is accepted.

## A short checklist for localizers

- Ask which categories each target language needs; do not assume `one` and `other`.
- Translate every branch of a modifier, and keep the form names exactly as Unreal reads them.
- Keep the argument (`{Count}`) in the sentence when the language needs it for the plural to work.
- Treat `plural_forms_missing` as a real bug: the player would meet a number with no matching text.
- Use CJK strings as the easy case: one form, so a `|plural` modifier is redundant there.

## Where to go next

LocHub is a source-available Unreal Engine editor plugin for AI-assisted localization: free for non-commercial use (personal projects, education, game jams, free games), with a commercial license on Fab. The code is on [GitHub](https://github.com/DmVergasov/LocHub), the plugin is on [Fab](https://www.fab.com/listings/aaf6a7ae-e02e-4975-91b4-129e2456e491), and the full reference is in the [documentation](https://app.notion.com/p/LocHub-3e7fed51161881b6be04fb732972cb38).

*Drafted by LocHub's AI assistant; every step and setting is checked against the LocHub documentation.*
