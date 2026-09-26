# Commandlet and CI

LocHub ships a commandlet, `LocHubSync`, so Push and Pull can run headless in a build pipeline — no editor UI, no
open project.

> **Note:** Run **Tools > LocHub > Set Up Localization Target** in the editor at least once before using the
> commandlet. It creates the Game localization target the commandlet operates on; without it the commandlet fails
> immediately with "No game localization target named \<Target\>."

## Switches

```
UnrealEditor-Cmd <Project>.uproject -run=LocHubSync -push [-dryrun] [-target=<Name>]
UnrealEditor-Cmd <Project>.uproject -run=LocHubSync -pull [-target=<Name>]
```

| Switch | Meaning |
|---|---|
| `-push` | Publish the current source strings (and the coverage report) to the LocHub service. Mutually exclusive with `-pull` — passing both, or neither, is an error. |
| `-pull` | Pull finished translations back from the LocHub service into the project's localization archives and `.locres` files. |
| `-dryrun` | Push only: count what would change (added / changed / retired strings) without writing anything. Combining it with `-pull` is an error. |
| `-target=<Name>` | The localization target name. Defaults to the target **Set Up Localization Target** creates (`Game`). |

`-push`/`-pull` does **not** gather text on its own — run the engine's stock `GatherText` commandlet first, the
same way you would before doing a Push from the editor.

The commandlet starts (or reuses, if one is already running for this project) the local LocHub Node service the
same way the editor tab does, on the configured Service Port. The whole Push or Pull has a 15-minute timeout; a
run that has not finished by then fails with "LocHub Push/Pull did not finish within 900 seconds." Because a
commandlet has no Slate renderer, Pull's font glyph check is skipped with a note in the log rather than failing.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | The requested Push or Pull finished successfully. |
| `1` | Anything else: bad or missing switches, no matching localization target, the service could not start, the run timed out, or the Push/Pull itself failed. |

There is no finer-grained exit code — check the log output for the reason. Every report line (added/changed/
retired string counts for a Push, or per-culture written/rejected counts for a Pull) is written to the log via the
`LogLocHub` category, followed by the one-line summary.

## CI example

A minimal pipeline step that gathers text, then pushes it to LocHub, might look like this (adjust the engine path
and project path for your setup):

```yaml
# Windows runner
- name: Gather text
  run: |
    "C:\UnrealEngine\Engine\Binaries\Win64\UnrealEditor-Cmd.exe" "MyGame.uproject" -run=GatherText -config="Config/Localization/Game_Gather.ini"

- name: Push strings to LocHub
  run: |
    "C:\UnrealEngine\Engine\Binaries\Win64\UnrealEditor-Cmd.exe" "MyGame.uproject" -run=LocHubSync -push
```

The same two steps on other platforms, using each platform's own editor binary:

```bash
# Linux runner (headless UnrealEditor-Cmd)
/opt/UnrealEngine/Engine/Binaries/Linux/UnrealEditor-Cmd "MyGame.uproject" -run=GatherText -config="Config/Localization/Game_Gather.ini"
/opt/UnrealEngine/Engine/Binaries/Linux/UnrealEditor-Cmd "MyGame.uproject" -run=LocHubSync -push

# macOS runner
/Users/Shared/UnrealEngine/Engine/Binaries/Mac/UnrealEditor.app/Contents/MacOS/UnrealEditor "MyGame.uproject" -run=GatherText -config="Config/Localization/Game_Gather.ini"
/Users/Shared/UnrealEngine/Engine/Binaries/Mac/UnrealEditor.app/Contents/MacOS/UnrealEditor "MyGame.uproject" -run=LocHubSync -push
```

To bring finished translations back in before packaging a build, run the `-pull` form instead of `-push` as a
later pipeline step, then check the exit code (`0`/`1`) to decide whether packaging continues.

> **Tip:** Run `-push -dryrun` first in a pipeline that should not silently retire strings — its report line names
> exactly how many strings would be added, changed or retired, so a reviewer can look before a real Push runs.
