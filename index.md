---
layout: home
title: AI-assisted localization for Unreal Engine
---

**LocHub** is an Unreal Engine editor plugin (UE 5.6–5.8) that translates your project's text with the AI provider
you choose — Anthropic (Claude), OpenAI, xAI (Grok), DeepSeek, Google Gemini, or a local model through Ollama or
LM Studio — checks every result, and lets you review it in one grid inside the editor before it goes back into
Unreal's own localization archives.

![The review queue: the AI dropped {ItemName}, LocHub flags it, the reviewer fixes it, A approves]({{ "/assets/review_queue.gif" | relative_url }})

*The AI dropped `{ItemName}` from a German translation. LocHub flags it, the reviewer types it back, and
<kbd>A</kbd> approves.*

- **Broken formatting never reaches your game.** Format arguments, plural forms and rich-text tags are validated
  twice — by LocHub and by Unreal's own validator — before anything is written.
- **A second AI can review every translation**, rate issues by severity and suggest a fix; risky strings come first.
- **Every string is translated in context:** its asset or C++ origin, developer notes, neighbouring strings, your
  glossary, project brief and style guide.
- **You stay in control:** a cost estimate and a hard spending cap before each job, human edits never overwritten,
  and you choose what ships.
- **Plain Unreal output:** ordinary `.archive` and `.locres` files — stop using LocHub any time.

**Free for non-commercial use** — personal projects, education, game jams, games given away free. Commercial use
needs a license on [Fab](https://www.fab.com/listings/aaf6a7ae-e02e-4975-91b4-129e2456e491). The source is
available under the Business Source License 1.1.

[Source on GitHub](https://github.com/DmVergasov/LocHub) ·
[Get it on Fab](https://www.fab.com/listings/aaf6a7ae-e02e-4975-91b4-129e2456e491) ·
[Documentation](https://app.notion.com/p/LocHub-3e7fed51161881b6be04fb732972cb38)

If LocHub helps you, a ⭐ on [GitHub](https://github.com/DmVergasov/LocHub) helps other Unreal developers find it.

## Guides
