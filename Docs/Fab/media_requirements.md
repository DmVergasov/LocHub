# Fab Listing Media Requirements (for LocHub)

Research date: 2026-09-26. Gathered by navigating fab.com / dev.epicgames.com /
support.fab.com / brand.epicgames.com in Chrome (read-only: no sign-in, no
submit/accept clicks except declining the non-essential-cookies banner on
brand.epicgames.com). All facts below are quoted/paraphrased from the cited
pages as they read on 2026-09-26; Fab states requirements are subject to
change.

## Media Gallery images (2D)

Source: [Asset File Format and Structure Requirements in Fab](https://dev.epicgames.com/documentation/en-us/fab/asset-file-format-and-structure-requirements-in-fab), section "Media Gallery Images".

- Minimum image size: **1920 x 1080 px**. (No maximum stated.)
- File size: **< 3 MB** per image.
- File format: **JPEG or PNG**.
- All 2D images in the Media Gallery combined must be **< 25 MB total**.
- 3D previews in the Media Gallery must be **< 500 MB**.

Aspect ratio is not pinned to a single value beyond the 1920x1080 minimum
(i.e. effectively >= 16:9 landscape at that resolution); no explicit
"must be exactly 16:9" statement was found. **Unconfirmed**: any maximum
resolution or DPI ceiling.

## Media Gallery video

Same source, section "Media Gallery Videos".

- Resolution: **1920 x 1080**.
- Maximum file size: **300 MB**.
- File format: **MP4, MOV, or WEBM**.

## Thumbnail image (the one representing the product in Discover/search)

Sources: [Publishing Assets for Sale or Free Download in Fab](https://dev.epicgames.com/documentation/en-us/fab/publishing-assets-for-sale-or-free-download-in-fab) ("Product Details" > "Thumbnail Image"), and [Publisher Get Started in Fab](https://dev.epicgames.com/documentation/en-us/fab/publisher-get-started-in-fab).

- A thumbnail image is **mandatory** for every listing (separate from the
  Media Gallery, which needs at least one image, 3D preview, or video in
  addition to the thumbnail).
- Requirement is qualitative, not a pixel spec: "Make sure the thumbnail
  image is clear, easy to understand, and properly represents your
  product." Fab uses it on the Discover page and in other listings.
- Fab **automatically generates search tags from the thumbnail image**, so
  the image must clearly depict the product's actual contents.
- Editing a live listing's Thumbnail requires Fab review before it goes
  live (see "Review Requirements for Listing Updates" table on the
  Publishing page: Thumbnail = "Requires Review: Yes").
- **Minimum resolution: 1920 x 1080**, formats .jpeg / .jpg / .png — from the Fab publisher portal's Thumbnail
  field, quoted by the owner on 2026-09-26 (the public docs do not state it). The file:
  `Saved/Media/cover_1920x1080.png`, rendered from `Tools/media/frames/cover.html` (a 640 x 360 layout rendered at
  device scale factor 3). Fab shows the thumbnail small in Discover and search, so it must stay legible when
  scaled down: the mark, the product name and one line of what it does — nothing else.

## Text, logos, and branding on listing images

Sources: [Technical Requirements](https://www.fab.com/o/technical-requirements) section 1.8.6 "Media (if included)", and [Fab Brand Guidelines > Product thumbnails & images](https://brand.epicgames.com/document/411) (brand.epicgames.com, reached from the Technical Requirements page's "Fab Brand Guidelines" link).

- 1.8.6.a Images, videos, and models must **accurately display the actual
  contents of the product**.
- 1.8.6.b All branding and promotional materials must adhere to the Fab
  Brand Guidelines.
- Fab Brand Guidelines, "Product thumbnails & images" page:
  - Clean thumbnails **with no Unreal Engine branding are always fine**
    ("Also acceptable: no logo or marker").
  - **Do not use the Unreal Engine or MetaHuman logos as standalone marks**
    on thumbnails — implies false official endorsement.
  - If referencing engine compatibility, use the official "Made for
    Unreal Engine" / "Powered by Unreal Engine" asset markers instead of
    the bare logos (optional, not required).
  - No general "no text at all" rule was found for gallery/thumbnail
    images; the constraint found is specifically about **not using Epic's
    own product logos standalone**, plus the general 1.8.6.a "must
    accurately display the product" rule.
- [Publisher Get Started in Fab](https://dev.epicgames.com/documentation/en-us/fab/publisher-get-started-in-fab) FAQ: "Products must not contain or be
  marketed using any copyrighted or trademark protected names, branding,
  or content, including any Epic-owned trademarks ... unless owned by or
  adequately licensed to the publisher." — i.e. no third-party logos of
  any kind, not just Epic's.
- **Unconfirmed**: any numeric limit on how much of an image may be
  covered by text/watermark, or a required safe-margin/clear-space rule
  for thumbnails specifically (the asset-marker guidelines PDF/page that
  covers "placement, spacing, sizing" for the optional Unreal Engine
  marker was linked but not opened, since it only applies if a publisher
  chooses to add that marker, which LocHub's icon does not).

## Code Plugin zip: required root layout

Source: [Technical Requirements](https://www.fab.com/o/technical-requirements) section "4.3.7.3 Code Plugins", matching the summary on [Asset File Format and Structure Requirements in Fab](https://dev.epicgames.com/documentation/en-us/fab/asset-file-format-and-structure-requirements-in-fab) ("Unreal Engine Code Plugins").

Required layout of the overarching plugin folder that gets zipped (example
name `MyPlugin`):

```
MyPlugin/
  Config/
  Content/
  Resources/
  Source/
    MyModule/
      Private/
      Public/
      MyModule.build.cs
    ThirdParty/
  MyPlugin.uplugin
```

- Must contain a `.uplugin` file, a `Source` directory, a `Content`
  directory, and a `Config` directory (dev.epicgames.com summary, "All
  Code Plugin products must contain the following").
- 4.3.7.3.a: plugin folder must not contain unused folders or local/build
  folders (`Binaries`, `Build`, `Intermediate`, `Saved`) — these must be
  excluded from the zip.
- 4.3.7.3.b: any extra folders meant for distribution besides `Content`,
  `Resources`, or `Source` (e.g. a `Docs` folder) require a `Config/FilterPlugin.ini`
  listing them, e.g.:
  ```
  [FilterPlugin]
  /Docs/...
  /MyOtherFolder/...
  ```
- 4.3.7.3.c: starting from the overarching plugin folder, **all file paths
  must be <= 170 characters**.
- 4.3.7.3.d: third-party dependencies need proof of permission and must
  live in a `ThirdParty` folder **inside `Source`**.
- 4.2.1.a: the project/plugin file must be uploaded as a **zip archive**
  containing **only one** Unreal Engine project or plugin.
- Naming: folders/files must use only English alphanumeric characters and
  underscores, and must not be vaguely named (`Assets`, `NewFolder`, etc.)
  (4.3.7.1).
- Code-plugin specific (4.3.6): must contain at least one C++ module; must
  not be closed-source w.r.t. any code needing UE source to compile; must
  not ship `.exe`/`.msi` files; source/header files need a commented
  copyright notice with publisher name/company and year; `.uplugin` needs
  `EngineVersion`, `PlatformAllowList`/`PlatformDenyList` per module, and a
  `FabURL` key (filled in with the product's Publisher Portal URL after
  submission, so not applicable until upload time).

## Other things noted in passing (not required by this task, kept for context)

- General asset zip size ceiling: keep under 15 GB where possible; up to
  6 GB per "Additional Files" (max 3 of those, 18 GB total); 6 GB per other
  file type (max 1 file per type).
- Fab review turnaround for listing updates is "usually processed within
  24 hours" per the Publishing page, but Thumbnail/Images/Video changes do
  require review before going live (not instant).

## Sources visited

1. https://dev.epicgames.com/documentation/en-us/fab/asset-file-format-and-structure-requirements-in-fab
2. https://dev.epicgames.com/documentation/en-us/fab/publishing-assets-for-sale-or-free-download-in-fab
3. https://dev.epicgames.com/documentation/en-us/fab/publisher-get-started-in-fab
4. https://support.fab.com/s/article/FAB-TECHNICAL-REQUIREMENTS (redirects to the full requirements doc, source 5)
5. https://www.fab.com/o/technical-requirements
6. https://brand.epicgames.com/d/1WbsuftyadLk/home (Fab Brand Guidelines hub; declined the non-essential-cookies banner to read it)
7. https://brand.epicgames.com/document/411 ("Product thumbnails & images")

No login was performed; no buttons that submit, publish, accept terms, or
enter data were clicked. The only interactive elements used besides
navigation were: expanding read-only accordion sections on page 5, and
declining non-essential cookies on page 6.
