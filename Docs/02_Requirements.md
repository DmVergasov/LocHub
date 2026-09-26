# Requirements

## Unreal Engine

| Engine version | Support |
|---|---|
| 5.6 | Supported |
| 5.7 | Supported |
| 5.8 | Supported |

LocHub is an editor-only plugin (its only module is `LocHubEditor`, of type `Editor`): it is never
compiled into a packaged/cooked game and adds no runtime cost to your shipped build.

> **Note:** Developer notes on text assets (used to write an answered translator question back onto the
> source string) require **UE 5.8 or newer**. On 5.6 and 5.7, the answer still reaches the translator through
> LocHub itself — it is just not written back onto the asset. See [05_AI_Providers_and_Keys.md](05_AI_Providers_and_Keys.md)
> and [06_Settings_Reference.md](06_Settings_Reference.md) for the **Write Dev Notes To Assets** setting.

## Operating system

| OS | Status |
|---|---|
| Windows | Tested |
| macOS | Code is written to run here; not tested by the author |
| Linux | Code is written to run here; not tested by the author |

LocHub from Fab comes prebuilt for Windows, macOS and Linux. The macOS and Linux builds come from the same
source as the Windows build, but the author has not tested them.

> **Note:** on macOS, a project path with two consecutive spaces in it is known to break the local service's
> startup (macOS collapses the double space in process arguments). Use a path without doubled spaces. See
> [11_Troubleshooting_and_FAQ.md](11_Troubleshooting_and_FAQ.md).

## Node.js

LocHub runs a small local service on your machine to talk to AI providers and to serve its web app. That
service is a Node.js program, so you need:

- **Node.js 22.11 or newer**, installed and reachable (see [03_Installation.md](03_Installation.md) for how
  LocHub finds it, and the **Node.js Executable** setting in [06_Settings_Reference.md](06_Settings_Reference.md)
  if you keep it somewhere non-standard).

You do not need Node.js experience, and you never run `npm` or any Node.js command yourself for normal use
— LocHub starts and stops the service for you. (`npm install`/`npm run build` only matter if you build the
service from source yourself; see [10_Commandlet_and_CI.md](10_Commandlet_and_CI.md).)

## An AI provider account

LocHub does not translate anything on its own — it sends strings to an AI provider you choose and pick a
model for. You need an account and an API key with one of the supported providers before you can run a
translation job. See [05_AI_Providers_and_Keys.md](05_AI_Providers_and_Keys.md) for the full list and where
to enter the key.

> **Tip:** you can install LocHub and explore the Grid, Glossary and Settings without an API key. You only
> need one when you run your first translation job.

## Claude Code (optional, only for Claude Subscription auth)

If you choose Anthropic's **Claude Subscription** auth mode instead of an API key (see
[05_AI_Providers_and_Keys.md](05_AI_Providers_and_Keys.md)), LocHub needs the **Claude Code** CLI (`claude`)
installed and reachable on `PATH`, signed in once by running `claude` yourself. Nothing else is required —
LocHub does not install, update or manage Claude Code for you. This is an optional external dependency: skip
it entirely if you use an API key, for Anthropic or any other provider.
