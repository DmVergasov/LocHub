---
layout: post
title: "Export Unreal Engine localization to XLIFF for a translation agency"
description: "How to hand Unreal strings to a vendor's CAT tool as XLIFF 1.2 with LocHub, and bring the translations back through the same format checks."
---

Not every string in a game should be translated by an AI. Story text, marketing copy or a language you ship for a
key market often goes to a human translator or an agency, and agencies usually work in a CAT tool (Trados, memoQ,
Phrase, Crowdin) that speaks [XLIFF](https://docs.oasis-open.org/xliff/xliff-core/xliff-core.html). You also want to know what happens to `{0}` placeholders and rich-text tags on the way there and back.

This guide walks through LocHub's translation exchange: export a culture to XLIFF 1.2, send it, and import the
result with a preview, conflict detection and the same format checks that your own edits go through. LocHub is an
Unreal Engine editor plugin for AI-assisted localization. It does not replace Unreal's localization system; the
output is still ordinary archives and `.locres`, so using it for the exchange step commits you to nothing else.

## Before you export: Push once

The XLIFF file names a source language. LocHub takes it from the localization target's native culture, as reported
by Push. Until LocHub has had a Push, XLIFF export is unavailable. This catches people who have just updated from
LocHub 1.1.

1. Run **Tools > LocHub > Push (Dry Run)** to see what would be added, changed or retired without changing anything.
2. When it looks right, run **Tools > LocHub > Push**.
3. In the LocHub tab, click Refresh.

If the native culture is wrong for a new target, set it under **Project Settings > Plugins > LocHub > Localization
Target > Setup Native Culture** (`en` by default, for example `zh-Hans` for a game written in Chinese). An existing
target keeps its own native culture, which you change in Unreal's Localization Dashboard.

## Export

Open the **Grid** tab and click **Export…** in the toolbar. The panel has three choices:

- **Culture**: the culture to export. It defaults to the Grid's active culture.
- **Format**: **CSV** for spreadsheets, or **XLIFF 1.2** for CAT tools. Pick XLIFF for an agency.
- **Strings**: **Strings matching the current filters** (exactly the rows the Grid shows right now) or **All strings**.

The file is saved as `lochub-<culture>.xlf`, in UTF-8, for example `lochub-de.xlf`.

The filter option is useful. If only the new strings of a patch need a vendor, filter the Grid to them first and
export the matching rows instead of paying to retranslate the whole game.

![Export panel](/LocHub/assets/12_export_dialog.png)

### What is inside the file

Each string becomes one `<trans-unit>`. The developer notes and the origin of the string (where it comes from in
the project) are written as `<note>` elements, so the translator sees the same context you see. When Length Check
gives a string a UI length limit, it is written as `maxwidth`. Approved strings carry `approved="yes"`.

The target `state` follows the LocHub status:

| LocHub status | XLIFF `state` |
|---|---|
| Draft, Needs fix | `needs-review-translation` |
| Edited, Human | `translated` |
| Approved | `final` |
| Rejected, Outdated | `needs-translation` |

A translation whose source text changed since it was made reads as outdated in LocHub and as `needs-translation`
in XLIFF, so the vendor sees which strings need work again.

### Placeholders and tags

Format arguments without a modifier (`{Name}`, `{0}`) and rich-text tags (`<Bold>`, `</>`, `<img id="coin"/>`) are
written as protected `<ph>` placeholders, which lets the CAT tool keep them intact.

An argument with a plural, ordinal or gender modifier, such as `{Count}|plural(one=…,other=…)`, stays plain text,
because its branches have to be translated. The format check on import is what catches a broken one.

One limit: XLIFF cannot store a few control characters at all. If a string holds one, the export names it. Export
CSV instead, or filter that string out.

## Send it, and what the agency needs to know

Send the `.xlf` file with the target language and tell the vendor to keep the `<ph>` placeholders and the
plural-modifier syntax untouched except for the branch texts. A CSV export exists too, for volunteers working in
Excel or Google Sheets; its columns include `lochub_id` and `lochub_revision`, which must stay in the file you get
back. If you use CSV, do not open it directly in Excel: reopen it through **Data > From Text/CSV** with every column
set to **Text**, because Excel can turn `lochub_id` into a number. If an id is mangled anyway, the import still finds
the string by its `namespace` and `key`.

## Import the result

In the Grid toolbar, click **Import…** and choose the file. LocHub reads `.csv`, `.xlf`, `.xliff` or `.xml` files into
the Grid's active culture. Make sure the active culture matches the file: an XLIFF whose `target-language` is another
culture is refused before anything is sent. The file can be UTF-8 (with or without a BOM) or, for XLIFF, UTF-16.

Nothing changes until you confirm. First LocHub shows a preview that sorts every string into a group:

| Group | What it means |
|---|---|
| **Changed** | A new translation; marked "(approved)" when the file approves it too |
| **Approved** | The same text as in LocHub, and the file approves it |
| **Unchanged** | Nothing to do |
| **Skipped** | Not imported: the source text changed since the export, the string is not in the project, the translation is empty, or the text has a problem Unreal would reject |
| **Conflicts** | The string changed in LocHub after the file was exported |
| **Needs confirmation** | The text has warnings only |

![Import preview](/LocHub/assets/13_import_preview.png)

Three details matter in practice:

- **Pre-filled targets count as nothing.** A target the CAT tool filled with the source text and left in state `new`
  or `needs-translation` is treated as no translation.
- **Empty never overwrites.** An import never clears a translation.
- **Conflicts are explicit.** If you edited a string in LocHub while the file was away, it lands in Conflicts and is
  left alone, unless you tick **Overwrite conflicts (N)**.

Enter your **Reviewer name** (required; the browser remembers it). It is recorded on every imported string and in its
history. Strings whose only issues are warnings are imported only if you check **Import anyway: N strings with
warnings**. Strings with a problem Unreal would reject, such as a broken `{0}`, a missing plural form or unbalanced
rich-text tags, are never imported. Each checkbox updates the preview, so what you see is what **Import** does.

## What an import does to your strings

A changed translation becomes **Edited**, written by the reviewer name you entered. If the file marks it
`approved="yes"`, it becomes **Approved**. Imported work is human work: AI translation jobs never overwrite it.

There is one deliberate exception to approval. If LocHub had already approved a different text for that string, or
the row only got in because you chose **Overwrite conflicts**, the string lands as plain **Edited**. The agency's
approval referred to a string that has since changed, so a reviewer approves the new text in LocHub instead.

If the LocHub data files changed on disk while the service ran (for example a source-control sync), the import is
refused and nothing is written. The same happens if the strings changed after the preview was shown; the panel shows
the fresh preview so you can check it before trying again.

## A workflow that works

1. Push, so the native culture is known.
2. Filter the Grid to the strings that need a human, and export them to XLIFF.
3. Send the file to the vendor with the placeholder note above.
4. Import the returned file, read the preview, and resolve conflicts on purpose.
5. Spot-check the result in the editor with **Apply \<culture\> live**, then run **Tools > LocHub > Pull**.

## Try it

LocHub is source-available under the Business Source License 1.1: free to read, modify and use, and free in
production for personal projects, education, academic research, game jams, and games given away free with no
monetization. Other production use needs a license purchased on Fab. The code and README are on
[GitHub](https://github.com/DmVergasov/LocHub), the plugin is on
[Fab](https://www.fab.com/listings/aaf6a7ae-e02e-4975-91b4-129e2456e491), and the full
[documentation](https://app.notion.com/p/LocHub-3e7fed51161881b6be04fb732972cb38) covers the export and import
panels in detail.

*Drafted by LocHub's AI assistant; every step and setting is checked against the LocHub documentation.*
