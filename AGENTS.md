# AGENTS.md

Guidance for any coding agent (or human) contributing to LocHub. `CLAUDE.md` in this repository points here
so Claude Code picks up the same rules.

## Project

LocHub is an Unreal Engine editor plugin (UE 5.6–5.8) for AI-assisted localization. It is one plugin with
three parts:

| Part | What it is | Language |
|---|---|---|
| `Source/LocHubEditor` | Menu commands, Project Settings, the embedded editor tab, the `LocHubSync` commandlet | C++ (Editor module) |
| `Service/` | The local Node.js service: AI provider calls, translation jobs, the review/glossary/coverage data store | TypeScript |
| `Web/` | The Grid/Review/Glossary/Jobs/Inbox/Coverage web app the service serves into the editor tab | TypeScript / React |

Other top-level folders:

- `Resources/LocHubService/lochub_service.mjs` and `Resources/LocHubWeb/` — the **committed, built**
  bundles the editor actually runs; they are not generated at build time.
- `Source/ThirdParty/LocHubNodeDeps`, `Source/ThirdParty/LocHubWebDeps` — the bundles' npm dependencies,
  vendored with their license texts (`LICENSES/`, `THIRD_PARTY_NOTICES.txt`).
- `Config/`, `LocHub.uplugin` — the plugin descriptor and its `FilterPlugin.ini`.
- `Docs/` — user-facing documentation (source of the published Notion docs).
- `Tools/` — the release script (`release.mjs`), its package checks (`release_checks.mjs`), and their
  tests.

`Docs/`, `Service/` and `Web/` sources and tests, `Tools/`, and this repository's own root files
(`README.md`, `LICENSE`, `AGENTS.md`, `CLAUDE.md`) do not ship in the Fab package — only `LocHub.uplugin`,
`Config`, `Resources` and `Source` do (`Tools/release.mjs`'s `SHIPPED` list is the source of truth).

## Build and test

C++ (from a host project that has this plugin in its `Plugins/` folder, or via `RunUAT.bat BuildPlugin`):

```
RunUAT.bat BuildPlugin -Plugin=<path>/LocHub.uplugin -Package=<out dir> -Rocket -TargetPlatforms=Win64
```

Build the module against **UE 5.6, 5.7 and 5.8** before opening a PR that touches C++ — `Tools/release.mjs`
does this for you (see below) and is the authority on whether a change is release-clean.

Service and Web (each has its own `npm test`/`npm run build`):

```
cd Service && npm ci && npm test && npm run build
cd Web && npm ci && npm test && npm run build
```

`npm run build` regenerates the bundles under `Resources/` (and the web deps bundle under
`Source/ThirdParty/LocHubWebDeps`) from `Service/src` / `Web/src`. **Commit the regenerated bundle together
with the source change that produced it** — the editor only ever runs the committed bundle, never
`Service/src` or `Web/src` directly.

Tools' own tests:

```
node --test "Tools/test/*.test.mjs"
```

Automation (from Unreal Editor, or `UnrealEditor-Cmd.exe <Project>.uproject -ExecCmds="Automation RunTests LocHub." -TestExit="Automation Test Queue Empty" -unattended -nullrhi`):

```
LocHub.*
```

Full release pipeline, which builds both bundles, stages the Fab package, runs the package checks,
`BuildPlugin` and (with `--automation`) the `LocHub.*` suite against one or more engines:

```
node Tools/release.mjs --engines 5.6=<engine root>,5.7=<engine root>,5.8=<engine root> [--automation] [--skip-npm] [--skip-build-plugin] [--forbid mygame] [--final]
```

`--automation` refuses to run while any `UnrealEditor.exe` is open — it starts its own throwaway host
project and editor process.

## Code rules

- **C++:** follow the [Epic Games C++ Coding Standard](https://dev.epicgames.com/documentation/en-us/unreal-engine/epic-cplusplus-coding-standard-for-unreal-engine).
  Generated code should be indistinguishable from stock Unreal Engine code.
- **Comments and UI-visible text are English**, without exception — this includes C++ comments, log
  messages, `FText` defaults, and every string the web app or the editor tab shows a user. Localize through
  the localization system, never by writing another language into a source string.
- **Line endings are LF** everywhere except the Windows batch files `.gitattributes` marks CRLF.
- **Engine-version-dependent code** is gated only with `UE_VERSION_NEWER_THAN_OR_EQUAL(...)` /
  `UE_VERSION_OLDER_THAN(...)` from `Misc/EngineVersionComparison.h` — never a private macro or a "lowest
  common denominator" workaround. A change that behaves differently across 5.6/5.7/5.8 must build and pass
  `LocHub.*` on all three before it is done; `Tools/release.mjs --engines 5.6=...,5.7=...,5.8=... --automation`
  is how you prove that, not a code review by inspection.

## Fab rules that are easy to break

LocHub ships on Fab, which enforces its own packaging rules — breaking one of these fails
`Tools/release.mjs`'s package check or the Fab review itself, not just a local build:

- No hyphens (or other disallowed characters) in the names of anything under `LocHub.uplugin`, `Config`,
  `Resources` or `Source` — the shipped package. Repository-only files (`Tools/`, `Docs/`, this file) are
  not checked.
- Third-party code only lives under `Source/ThirdParty/<Name>Deps`, each with its own
  `THIRD_PARTY_NOTICES.txt` and per-package license texts under `LICENSES/`.
- The `Resources/` bundles are **built artifacts that get committed**, not generated at package time: after
  changing `Service/src` or `Web/src`, run `npm run build` in that package and commit the result alongside
  the source change.
- `node Tools/release.mjs --engines ...` must be green (all package checks pass, `BuildPlugin` succeeds
  with no warnings on every engine version) before a release; treat a failure there as a blocking bug, not
  a release-time detail.

## Not allowed

- No API keys, tokens or other secrets in code, commit history, log output, or test fixtures of this
  repository — a buyer's own key lives in their project's Project Settings (`Config/DefaultEditor.ini`),
  which is their file, not this repository's; never commit a real key into LocHub's own files or tests.
- No test may make a real, billed call to an AI provider. Tests exercise the service/editor logic against
  fakes or fixtures; nothing in `Service/test`, `Web/test` or the C++ `LocHub.*` suite may depend on a live
  provider API key.

## Bug fixes need a proving test

A bug fix is accepted only together with a test that proves it: the test reproduces the bug, fails on the code
before the fix and passes after it. The pull request names the test and shows the failure before the fix (the
test run output, or the exact steps). A fix without such a test is not accepted.

## New features need tests

A new feature or any change of behavior is accepted only together with tests that cover it: every behavior the
pull request adds or changes has a test that exercises it through the entry point that uses it (a service route,
a web component, a C++ API or command), and that test fails when the feature is removed or broken. Tests assert
behavior, not implementation details. A feature without such tests is not accepted, however small it is.

Where tests live:

| Part | Tests | Run |
|---|---|---|
| `Service/` | `Service/test/*.test.ts` (Vitest) | `cd Service && npm test` |
| `Web/` | `Web/test/*.test.tsx` (Vitest + Testing Library) | `cd Web && npm test` |
| `Source/LocHubEditor` | `Source/LocHubEditor/Private/Tests/` (Automation, `LocHub.*`) | Automation `LocHub.` in the editor or `UnrealEditor-Cmd` |
| `Tools/` | `Tools/test/*.test.mjs` (`node:test`) | `node --test "Tools/test/*.test.mjs"` |

## Pull requests

- Keep a PR scoped to one change; describe what it fixes or adds and why, not just what changed.
- Show the tests you ran (`npm test` in the packages you touched, `node --test "Tools/test/*.test.mjs"` if
  you touched `Tools/`, `LocHub.*` Automation if you touched C++ or cross-cutting behavior) and their
  result.
- For a bug fix, follow "Bug fixes need a proving test" above; for a feature or behavior change, follow "New
  features need tests". A pull request without the tests these sections require is closed, not merged.
- By opening a pull request you agree your contribution is licensed under the **Business Source License
  1.1** (see [`LICENSE`](LICENSE)), the same license as the rest of this repository.
