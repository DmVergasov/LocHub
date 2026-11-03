---
layout: post
title: "Translate Unreal Engine text with your Claude subscription, no API key"
description: "Set up LocHub's Claude Subscription mode so an Unreal Engine 5.6–5.8 project is translated through your signed-in Claude Code CLI instead of an API key."
---

If you already pay for Claude Code, you may not want to create and manage a separate Anthropic API key just to
translate your game. [LocHub](https://github.com/DmVergasov/LocHub), an editor plugin for Unreal Engine 5.6, 5.7 and
5.8, has a mode for exactly that: **Claude Subscription**. Instead of sending requests with an API key, LocHub runs
your own, already signed-in Claude Code CLI (`claude`) on your machine and reads back its result. This guide walks
through the setup, what changes in the Jobs tab, and when an API key is the better choice.

## What this mode is, and what it is not

LocHub does not translate anything by itself. Every job sends strings to an AI provider, using a translate model and
a cheaper judge model that checks the translation afterwards. With **Anthropic** as the provider, there are two ways
to authenticate:

- **API Key**: you paste a key from your Anthropic account, and LocHub bills usage to that metered key.
- **Claude Subscription**: LocHub starts your local `claude` CLI, hidden, with no tools enabled, once per translation
  or judge request, and reads back its structured result. No key is read or sent to LocHub's service in this mode.

Only the strings a job translates, their notes and your glossary leave the machine. The request content is the same
under both modes; the only difference is how LocHub reaches Anthropic. LocHub never reads or logs your Claude account
e-mail or any session token. Each request is a separate one-shot `claude` process with no session persisted between
requests.

## What you need

- Unreal Engine 5.6, 5.7 or 5.8. Windows is the tested platform.
- [Node.js](https://nodejs.org/) 22.11 or newer: LocHub runs a small local service on `127.0.0.1`.
- LocHub, from [Fab](https://www.fab.com/listings/aaf6a7ae-e02e-4975-91b4-129e2456e491) or from
  [GitHub](https://github.com/DmVergasov/LocHub), enabled as a plugin in your project. LocHub is source-available
  under the Business Source License 1.1: free in production for personal projects, education, academic research,
  game jams and games given away free with no monetization. Other production use needs a license purchased on Fab.
- [Claude Code](https://claude.com/product/claude-code) installed, with `claude` reachable on `PATH`, and a Claude
  subscription to sign in with. LocHub does not install, update or manage Claude Code for you. This is an optional
  dependency: if you use an API key, for Anthropic or any other provider, you do not need it.

## Step 1: Sign in to Claude Code once

Open a terminal and run:

```
claude
```

Sign in to your Claude subscription when it asks. You only need to do this once, outside Unreal. LocHub will use the
same signed-in CLI later; it does not handle your login itself.

## Step 2: Switch LocHub to Claude Subscription

1. In Unreal, open **Project Settings > Plugins > LocHub** and find the **AI** category.
2. Set **AI Provider** to **Anthropic**.
3. Set **Anthropic Auth** to **Claude Subscription**. The **API Key** field disappears: in this mode no key is read or
   sent.
4. Under **Anthropic Models**, check **Translate Model** and **Judge Model**. The defaults are `claude-opus-5-5` for
   translating and `claude-sonnet-5` for judging. You can change either to any model ID that Anthropic accepts.
   Check Anthropic's current model list before a large job, because providers rename and retire models.

Changes to AI settings apply to the running LocHub service right away, or, if a translation job is running, right
after that job finishes. The editor shows a notification confirming this.

## Step 3: Check that LocHub sees Claude Code

LocHub checks whether Claude Code is installed and signed in. Until it is, the **Estimate** and **Run** buttons in the
Jobs tab stay disabled, and a tooltip on the button gives the reason. Two messages are worth knowing:

> Claude Code (claude) was not found on PATH.

Install Claude Code so `claude` is reachable on `PATH`, then retry. You do not need to restart the editor, because
LocHub re-checks readiness on its own.

> Claude Code is not signed in: run "claude" once and sign in.

Open a terminal, run `claude`, sign in, and retry **Estimate** or **Run**.

## Step 4: Estimate and run a job

Open **Tools > LocHub > Open LocHub** and go to the **Jobs** tab. A job translates the active culture. You can leave
**Group** empty for every group, type an exact group key for one group, or type a path ending in `/` to scope the job
to a folder and everything under it. A selection made in the Grid can also arrive here as a fixed set of strings.

![The Jobs tab](/LocHub/assets/05_jobs.png)

Click **Estimate**. Under Claude Subscription auth the estimate is different from an API-key estimate:

- It still shows the number of strings, the number of requests and token counts.
- The token counts are always a local approximation, marked **≈ Approximate**, because LocHub counts tokens
  exactly only for Anthropic with an API key. The finished job's report shows the real usage.
- There is **no dollar figure and no Max USD field**. Usage is not billed per token here; it counts against your
  Claude plan's own usage limits.

That last point matters for planning. With an API key, the **Max USD** cap is a hard ceiling set before anything is
spent. In subscription mode there is no such cap, so start with a small scope, such as one group, look at the report,
and then widen it. Your plan's limits are defined by Anthropic, so check them on your Claude account rather than
assuming a number.

Click **Run** when you are ready. If you would rather skip estimating, **Run without estimate** starts the job
immediately.

## Step 5: Review before anything ships

The checks do not change with the authentication mode. Translations go through the optional **Judge** pass, which
checks meaning, terminology and tone and rates issues by severity, and then into the review queue. Format arguments
such as `{0}` or `{PlayerName}`, plural forms for every target language and rich-text tags are validated by LocHub and
again by Unreal's own validator right before anything is written. A hard issue blocks **Approve** and **Save**
outright. Human edits are never overwritten by the AI, and the output is ordinary Unreal localization archives and
`.locres` files, so you can stop using LocHub at any time. When you are done reviewing, run **Tools > LocHub > Pull**.

## Limits to know about

- **Ten-minute cap per request.** A single translate or judge request run through Claude Code is killed and reported
  as an error if it takes longer than 10 minutes. It appears in the job's **Error reasons** like any other provider
  error and is retried the same way a transient provider failure is.
- **One `claude` process per request.** Every translate or judge request starts its own one-shot process with no
  persisted session.
- **No per-job USD budget.** See above.
- **Anthropic only.** The mode exists for the Anthropic provider. Other providers use a key, or a Custom endpoint
  if you run a local model.

## API key or subscription?

Pick **API Key** when you want a per-job USD budget you can cap in advance, or when you would rather bill translation
to a metered API key than against your personal Claude subscription's usage limits. Pick **Claude Subscription**
when you already pay for Claude Code and would rather not manage a separate Anthropic API key.

## Troubleshooting

- **The buttons are disabled.** Hover over **Estimate** to read the reason. It is almost always one of the two
  messages in Step 3.
- **A request timed out.** Look at **Error reasons** in the job report. A request that takes over 10 minutes is
  retried; if it keeps failing, scope the job smaller.
- **A job stops immediately as failed.** If every request of a job's first round fails the same way, the job stops
  and changes no cell, so nothing partial gets written.

LocHub is on [GitHub](https://github.com/DmVergasov/LocHub) and [Fab](https://www.fab.com/listings/aaf6a7ae-e02e-4975-91b4-129e2456e491),
and the full setup and settings reference is in the
[documentation](https://app.notion.com/p/LocHub-3e7fed51161881b6be04fb732972cb38).

*Drafted by LocHub's AI assistant; every step and setting is checked against the LocHub documentation.*
