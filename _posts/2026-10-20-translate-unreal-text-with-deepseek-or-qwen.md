---
layout: post
title: "Translate Unreal Engine text with DeepSeek or Qwen"
description: "Set up DeepSeek or a Qwen model on Alibaba Cloud as the translation provider for an Unreal Engine 5.6–5.8 project in LocHub, with cost estimate and checks."
---

If you build an Unreal Engine game and want to translate it with DeepSeek or with a Qwen model, you do not need to
write glue code. [LocHub](https://github.com/DmVergasov/LocHub) is an editor plugin for Unreal Engine 5.6, 5.7 and
5.8 that sends your project's strings to an AI provider of your choice, lets you review the results inside the
editor, and writes them back into Unreal's own localization archives and `.locres` files. DeepSeek is a built-in
provider. Qwen is reached through LocHub's **Custom (OpenAI-compatible)** provider. This guide covers both.

## What you need

- Unreal Engine 5.6, 5.7 or 5.8. Windows is the tested platform.
- [Node.js](https://nodejs.org/) 22.11 or newer: LocHub runs a small local service on `127.0.0.1`.
- LocHub, from [Fab](https://www.fab.com/listings/aaf6a7ae-e02e-4975-91b4-129e2456e491) or cloned from
  [GitHub](https://github.com/DmVergasov/LocHub) into your project's `Plugins` folder, then enabled in the editor.
  LocHub is source-available under the Business Source License 1.1: free in production for personal projects,
  education, academic research, game jams and games given away free with no monetization. Other production use
  needs a license purchased on Fab.
- An API key for the provider you pick. Only the strings a job translates, their notes and your glossary are sent to
  that provider.

## Option 1: DeepSeek (built-in provider)

1. Create an API key in your DeepSeek account. DeepSeek's own
   [API documentation](https://api-docs.deepseek.com/) describes how to get one and which models are current.
2. In Unreal, open **Project Settings > Plugins > LocHub** and find the **AI** category.
3. Set **AI Provider** to **DeepSeek**. LocHub now shows the DeepSeek key field and hides the other providers' fields.
4. Paste your key into **API Key**. It is masked while you type.
5. Under **DeepSeek Models**, check **Translate Model** and **Judge Model**. The defaults are `deepseek-v4-pro` for
   translating and `deepseek-flash` for judging. You can change either to any model ID that DeepSeek's API accepts,
   for example a cheaper one. Compare the IDs with DeepSeek's documentation before a large job, because providers
   rename and retire models over time.

![The API Key field under AI Provider](/LocHub/assets/07_api_key.png)

The key is saved in `Config/DefaultEditor.ini` with the other LocHub settings. That file travels with your project
through version control, so anyone who can read the project's config can read the key. Keep that in mind before you
commit it to a shared repository.

There is no Base URL to enter for DeepSeek: LocHub already knows the address of its built-in providers.

## Option 2: Qwen through a Custom (OpenAI-compatible) endpoint

Qwen models are offered by Alibaba Cloud through an OpenAI-compatible API, and they can also run on your own
machine. LocHub has no dedicated Qwen entry, but its **Custom (OpenAI-compatible)** provider talks to any server that
speaks the OpenAI Chat Completions API.

### Qwen on Alibaba Cloud

1. In the [Alibaba Cloud Model Studio documentation](https://www.alibabacloud.com/help/en/model-studio/), find the
   OpenAI-compatible endpoint for your account and region, and create an API key. Alibaba lists different
   addresses per region and is rolling out per-workspace addresses, so copy the address shown for your own account
   in the Model Studio console instead of typing one from a blog post. Use a key from the same region as the address.
2. In **Project Settings > Plugins > LocHub > AI**, set **AI Provider** to **Custom (OpenAI-compatible)**.
3. Fill in the fields LocHub shows:
   - **Base URL**: the address from the console, without `/chat/completions`. It must start with `http://` or
     `https://`; LocHub adds `/chat/completions` and `/models` itself.
   - **API Key**: your Model Studio key.
   - **Key Header**: **Authorization: Bearer**, which is right for almost every server.
   - **Custom Models**: the model ID exactly as the provider lists it. **Translate Model** is required. Leave
     **Judge Model** empty to judge with the same model, or enter a cheaper one.
   - **Structured Output**: start with **JSON Schema**. If the server rejects it or the answers come back broken,
     switch to **JSON Object**, and if that fails too, to **Prompt Only**.
4. Set **Input Price** and **Output Price**, in USD per 1M tokens, to what the provider charges for your model. Take
   the figures from the provider's public price page for that model.

![Custom (OpenAI-compatible) selected in Project Settings](/LocHub/assets/08_custom_endpoint_settings.png)

### Qwen on your own machine

If you would rather not send text anywhere, run a Qwen model locally. For Ollama, set **Base URL** to
`http://localhost:11434/v1`, leave **API Key** empty (no authorization header is sent then), and put the model as
`ollama list` shows it, for example `qwen3:8b`, into **Translate Model**. Raise Ollama's context window first (see
[Ollama's documentation](https://docs.ollama.com/faq) on context length), for example by starting it with
`OLLAMA_CONTEXT_LENGTH=16384`: LocHub's documentation notes that the default is smaller than a full translate
request and that Ollama silently truncates what does not fit. With a local model the text never leaves your machine, and
translating costs nothing per token.

## Check the connection

Look at the AI pill at the top of LocHub. For a Custom endpoint it shows the endpoint's host and one of these:

| The pill says | Meaning |
|---|---|
| endpoint OK | The endpoint answered and lists every configured model. |
| model missing | The endpoint answered but does not list a configured model; hover the pill to see which. |
| unreachable | LocHub could not reach the endpoint, or the endpoint refused the key. |
| no model list | The endpoint has no model list LocHub can read. Jobs may still work: run a small one to find out. |

If the pill says **model missing**, set **Custom Models** to the IDs the endpoint actually lists. If a job fails with
**HTTP 404**, the Base URL is probably missing its API path: for many servers it must end in `/v1`.

## Estimate, then run

1. Open LocHub from the editor and go to the **Jobs** tab. Pick a culture, and optionally a group or folder.
2. Click **Estimate**. LocHub shows the number of strings and requests, approximate input and output tokens, and an
   estimated cost in USD when the models have a known price. For a Custom endpoint the price comes from the **Input
   Price** and **Output Price** you entered. With both at `0` the estimate shows "no price set" and **Max USD**
   cannot limit spending.
3. When the estimate is priced, a **Max USD** field appears, pre-filled about 20% above the estimate. The job will
   not exceed it. Click **Run**.

For a Custom endpoint the token counts are always a local approximation, marked **≈ Approximate**. The finished
job's report shows the real usage. If a request times out, LocHub does not retry it as is: it splits the group in two
and sends the smaller halves, so a slow model still finishes.

## Review what comes back

Translations land in the **Review** queue. Before you can approve a string, LocHub checks format arguments such as
`{0}` or `{PlayerName}`, plural forms for every target language and rich-text tags. A broken placeholder is a hard
issue that blocks Approve and Save, and Unreal's own validator checks the text again right before anything is
written. An optional judge pass, run by the **Judge Model**, rates meaning, terminology and tone and puts the
riskiest strings first. Human edits are never overwritten by the AI.

If you switch from DeepSeek to a Qwen model, or the other way, change the provider and the models in Project
Settings. The change applies to the running service right away, or after the current job finishes if one is running.

## Where to go next

LocHub is on [GitHub](https://github.com/DmVergasov/LocHub) and
[Fab](https://www.fab.com/listings/aaf6a7ae-e02e-4975-91b4-129e2456e491), and the
[documentation](https://app.notion.com/p/LocHub-3e7fed51161881b6be04fb732972cb38) covers every setting named above in
more detail, including the AI Providers and API Keys chapter.

*Drafted by LocHub's AI assistant; every step and setting is checked against the LocHub documentation.*
