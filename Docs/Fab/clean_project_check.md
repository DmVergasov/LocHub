# Clean-project verification — LocHub

A smoke test to run against the actual submission zips before (or right after) publishing, on a project
that has never seen LocHub before. Run this twice: once against the Unreal Engine **5.6** zip, once
against the **5.8** zip, each on its own freshly created project. Repeating on 5.7 as well is a good idea
but not mandatory if 5.6 and 5.8 both pass, since 5.7 sits between them.

## Setup

1. Install the matching engine version (5.6 or 5.8) if not already present.
2. Create a brand-new, empty project (Blank template, no starter content) at that engine version — not a
   copy of an existing project, and not the LocHub development project.
3. Extract the corresponding zip's `LocHub` plugin folder into the new project's `Plugins/` directory (or
   install it engine-wide, whichever matches how the zip is meant to be distributed on Fab).

## Steps

- [ ] **Install.** Launch the project. The editor should start normally; if the plugin ships prebuilt
      Windows binaries, no compile prompt should appear. If it does prompt to compile, compiling should
      succeed.
- [ ] **Enable the plugin.** Edit > Plugins > search "LocHub" (category Localization). It should be listed
      but **unchecked** (`EnabledByDefault` is off). Check it, and let the editor restart when it asks.
- [ ] **Node.js required window.** If the test machine has no Node.js 22.11+ reachable (no PATH entry, no
      per-user Node.js Executable setting, none of the usual install locations), nothing about Node.js should
      happen when the editor itself starts. The "LocHub: Node.js required" window should instead appear the
      first time you launch LocHub — open **Tools > LocHub > Open LocHub**, or run **Push**, **Push (Dry
      Run)**, **Pull** or **Restart Service** — naming where it looked, with a working "Download Node.js"
      link/button and an "OK" to dismiss. If a suitable Node.js is present and discoverable, the window
      should **not** appear.
  - [ ] Optionally verify the override path: set **Editor Preferences > Plugins > LocHub > Node.js
        Executable** to a valid Node.js binary and confirm the window no longer appears (or, if Node.js is
        genuinely absent, that setting it there is what makes LocHub start working).
- [ ] **Set Up.** Tools > LocHub > **Set Up Localization Target**. Confirm it creates (or completes) the
      project's Game localization target, with the foreign cultures configured under Project Settings >
      Plugins > LocHub (the **Setup Foreign Cultures** setting; default de, fr, es, ja) added next to the native
      culture. Run it a second time and confirm nothing changes and nothing is removed.
- [ ] **Push.** Add one or two test strings to the project (e.g. a `FText` literal, or a Data Table row)
      so there is something to gather, run Gather Text, then Tools > LocHub > **Push**. A dry run should
      report what would be added/changed/retired; confirm the real Push, and check that it succeeds
      without errors.
- [ ] **Run a job.** Open the LocHub tab (Tools > LocHub > **Open LocHub**). In Project Settings > Plugins >
      LocHub > AI, pick a provider and enter a real API key for it in the **API Key** field (your own key —
      this step makes a real, billed call). Start a
      translation job for the pushed strings into one of the configured foreign cultures. Confirm:
  - a cost estimate is shown before the job starts (or, if every string is already covered by translation
    memory/cached answers, the "no translate cost is estimated" message instead);
  - the job completes and produces translated rows (or, on a deliberately bad key, fails cleanly with an
    "Error reasons" list and no cell changed — useful as a negative check, but run the real case too).
- [ ] **Review.** Open the review queue / grid. Confirm the translated strings are visible, any judge
      notes/flags show up on the flagged rows, and a manual edit to a translation saves correctly.
- [ ] **Pull.** Tools > LocHub > **Pull**. Confirm the translations are written into the project's
      localization archive for the target culture and that `.locres` compiles without errors. On UE 5.8,
      confirm developer notes are written into the source text's metadata where applicable; on 5.6/5.7,
      confirm the Pull result still reports answered questions even though developer notes are not written
      to the asset.

## What counts as success

- No C++ compile errors and no missing-binary errors on either engine version.
- The plugin installs disabled and enables cleanly, with a restart when asked.
- The Node.js required window appears exactly when a suitable Node.js is genuinely unreachable, and never
  otherwise; the Node.js Executable override in Editor Preferences resolves it.
- Set Up, Push, a real translation job, Review and Pull all complete with no unhandled errors, no crashes,
  and no LocHub-related errors/warnings in the Output Log beyond the expected user-facing messages (e.g.
  the tombstone confirmation dialog, a deliberately-triggered bad-key failure).
- After Pull, the target culture's localization archive and compiled `.locres` in the clean project
  actually contain the new translations — open the archive or run the game with that culture active to
  confirm the string shows translated text, not the source string.
- Nothing in the process required the LocHub development project, its Config files, or any file outside
  the clean test project and the installed plugin.

## If something fails

Note the exact step, the error text (redact any API key before saving it anywhere), and whether it
reproduces on both engine versions or only one, before deciding whether the package is ready to submit.
