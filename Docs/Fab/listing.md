# Fab listing text — LocHub

Source for the Fab product page. Copy the sections below into the corresponding Fab fields when creating
or editing the listing. English only — this is buyer-facing text.

## Title

LocHub — AI-Assisted Localization for Unreal Engine

## Short description (one-liner / card subtitle)

AI-assisted localization with you in control: translate your project's text with your own AI key, let
built-in checks and a second AI catch the problems, review everything in one fast grid inside the editor,
and pull it back as plain Unreal localization data.

## Full description

Fab's description field is plain text (no Markdown). **Paste `Docs/Fab/description_fab.txt`** — the same text as
below, one line per paragraph or bullet, bullets as "•", section titles in capitals. The Markdown below is the source
for the README's "Why LocHub"; keep both in sync.

LocHub brings AI translation into the Unreal Editor without taking the control away from you. Your
project's strings go to the AI provider you choose, under your own key; built-in checks and a second AI
catch the problems; you review the result in one place and pull it back as plain Unreal localization data.

<!-- WHY-LOCHUB:BEGIN — keep this section identical in README.md and Docs/Fab/listing.md. -->
## Why LocHub

**You stay in control**
- **Broken formatting never reaches your game.** Format arguments (`{0}`, `{PlayerName}`), plural forms for
  every target language and rich-text tags are validated in code twice — by LocHub, and again by Unreal's own
  validator right before anything is written. Broken text cannot be approved, not even by hand.
- **A second AI reviews every translation.** An optional judge checks meaning, terminology and tone, rates each
  issue by severity and suggests a fix. Risky strings come first in the review queue.
- **Every string is translated in context.** With the text, the AI gets where it comes from (the asset or C++
  file), its developer notes and metadata, already-translated strings from the same screen or asset, your
  project brief and style guide, and your answers to its earlier questions.
- **Your glossary is followed.** Fixed terms and do-not-translate words go to the translator and the judge with
  every request; do-not-translate terms are also checked in code. Change a term, and every string that uses it
  is queued for re-translation in one click.
- Translations that would overflow your UI are flagged, and the AI is told the length limit up front.
- Human edits are never overwritten by the AI.
- Changed source text marks its translations outdated; they are not shipped until updated.
- You choose what ships: only approved strings, or everything that passed the checks.
- Full history per string, a cost estimate before every job and a hard spending cap.

**Pleasant to use**
- Works in an editor tab: a fast grid, filters, and a keyboard-driven review queue.
- Jump from a string to its asset or C++ line; preview a language in the editor live.
- Glossary CSV import/export; the AI asks you questions instead of guessing.
- Work with human translators: export to XLIFF or CSV, import their work back through the same checks.

**Simple**
- One click sets up your localization target. No accounts, no servers.
- Bring your own key: Anthropic, OpenAI, xAI, DeepSeek, Google Gemini or any OpenAI-compatible endpoint,
  including local models (Ollama, LM Studio) — or, for Anthropic, your own Claude subscription via Claude
  Code, no key needed.
- Output is ordinary archives and `.locres` — stop using LocHub any time.
<!-- WHY-LOCHUB:END -->

## How it works

1. **Set Up** the localization target from Tools > LocHub.
2. **Push** your gathered strings (a dry run shows what changes first).
3. **Translate** your strings with your AI provider, after a cost estimate.
4. **Review** in the grid and the review queue.
5. **Pull** the translations back into your project.

## Requirements

- Unreal Engine 5.6, 5.7 or 5.8.
- Node.js 22.11 or newer (LocHub runs a small local service on `127.0.0.1`).
- An API key for one of the supported AI providers — or any OpenAI-compatible endpoint, including a local model
  server (Ollama, LM Studio) that needs no key — or, for Anthropic, a Claude Code CLI on your machine, installed
  and signed in to your Claude subscription, instead of a key.

Only what a translation needs — the strings, their notes and your glossary — leaves your machine, sent to your
AI provider under your own key (or, under a Claude subscription, to your own signed-in Claude Code CLI). With a
local model on a Custom endpoint, nothing leaves your machine at all.

## Source code

LocHub's full source is on GitHub: https://github.com/DmVergasov/LocHub — browse the code, report issues and
follow development there.

## Key features (compact list for Fab's "Features" field)

- Format arguments, plural forms and rich-text tags validated in code, twice, before anything is written.
- Optional AI judge that rates every translation's issues by severity and suggests fixes.
- Human edits are never overwritten; changed source text marks translations outdated.
- Release policy: ship only human-approved strings, or everything that passed the checks.
- Per-string history, cost estimate and a hard spending cap per job.
- Editor tab with a fast grid, keyboard-driven review queue, jump-to-source and live preview.
- Glossary with CSV import/export, inbox for the AI's questions, coverage report of text that bypasses
  localization.
- Export to XLIFF 1.2 or CSV for human translators; their work is imported back through the same checks.
- UI length check: translations that would overflow the UI are flagged; the AI is told the limit.
- One-click target setup, no accounts or servers, five AI providers with your own key or any OpenAI-compatible
  endpoint, including local models.
- Plain Unreal archives and `.locres` output; a commandlet for Push/Pull on CI.

## Tags

Localization, Translation, AI, Machine Translation, Internationalization, i18n, Editor Utility,
Automation, Text, LLM

## Category

Code Plugins — Localization / Editor Scripting *(confirm the exact category value against Fab's current
category picker when creating the listing; this document does not have access to that live taxonomy)*.

---

## Technical Information (Fab template)

- **Features:** the compact list under "Key features" above; the full story is "Why LocHub".
- **Code Modules:** `LocHubEditor` (Editor).
- **Number of Blueprints:** 0.
- **Number of C++ Classes:** 45 (class and struct definitions in `Source/LocHubEditor` headers, tests and forward
  declarations excluded; counted on 2026-09-26 — recount if headers change before release).
- **Network Replicated:** No.
- **Supported Development Platforms:** Windows, macOS, Linux.
  *Additional note:* tested on Windows. The macOS and Linux builds come from the same source (the C++
  module, the local Node service and the web UI are all portable), but the author has not tested LocHub
  on macOS or Linux.
- **Supported Target Build Platforms:** Editor-only — `LocHubEditor` is an Editor module with no runtime
  counterpart; it does not run in, or affect, a packaged/cooked game.
- **Documentation:** https://app.notion.com/p/LocHub-3e7fed51161881b6be04fb732972cb38
- **Example Project:** None. The listing's screenshots come from a local demo project used only to produce
  images; no example project is included in the package.
- **Important/Additional Notes:**
  - Requires Node.js 22.11 or newer on the machine running the editor.
  - Requires your own API key for one of the supported AI providers (Anthropic, OpenAI, xAI, DeepSeek,
    Google Gemini), or an OpenAI-compatible endpoint you run or rent (a local model needs no key); LocHub does
    not include or resell access to any AI provider.
  - Optional, Anthropic only: instead of an API key, LocHub can authenticate through your own Claude
    subscription, by running the Claude Code CLI (`claude`) already installed and signed in on your
    machine. This is an external dependency only when that mode is selected; every other provider and
    Anthropic's own API-key mode need nothing beyond Node.js.
  - Your project's text strings are sent to the AI provider you configure, under your own key (or, under
    a Claude subscription, to your own signed-in Claude Code CLI), when you run a translation job.
  - Network access is limited to the configured provider's API (for a Custom endpoint, the Base URL you set)
    and to LocHub's own local service on `127.0.0.1`.
  - Tested on Windows only; the macOS and Linux builds come from the same source but are untested by the
    author.

## Media

Screenshots and the plugin icon are produced separately; see `Docs/Fab/media_requirements.md` for Fab's
size/format/count requirements and the icon and gallery images by role (grid overview, review-queue card
with judge notes, Jobs screen with cost estimate, Inbox, glossary, coverage). Reference images by role in
this document and in the portal checklist, not by their final rendered file name.
