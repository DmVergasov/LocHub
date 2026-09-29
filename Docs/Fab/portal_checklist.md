# Fab seller portal checklist — LocHub

Steps to take on fab.com when creating and submitting the LocHub listing. Checklist only — actions on the
portal (drafting, uploading, publishing) are for the owner to perform.

## 1. Engine versions and packages

- [ ] Target engine versions: **5.6, 5.7, 5.8**.
- [ ] Build/package **one zip per engine version** (three zips total). Each zip contains the plugin as it
      builds and packages against that engine version — do not ship a single zip across versions.
- [ ] Attach each zip to its matching engine-version entry in the Fab listing's version list.

## 2. Third-party software declaration (portal question 4.2.5)

Fab asks whether the product includes third-party software and, if so, to list it. Answer **yes** and
list:

- **Every package named in both `THIRD_PARTY_NOTICES.txt` files** the release build generates (one for
  the Service bundle, one for the Web bundle) — name, version, license, per that file. These files do not
  exist yet at the time of writing; they are produced by the release packaging step
  (`packageDirsFromModuleIds` / `writeThirdPartyNotices`). **Use their actual contents as the source of
  truth at submission time** — the list below is the current runtime-dependency baseline that feeds them,
  not a substitute for reading the generated files.
- **The AI provider APIs the plugin talks to** (not bundled code, but external services the product
  integrates with): **Anthropic, OpenAI, xAI, DeepSeek, Google Gemini, and any OpenAI-compatible endpoint the
  user configures**.

Baseline runtime dependencies as declared in the two `package.json` files today (2026-09-26), with
license taken from each package's own `node_modules/<pkg>/package.json`:

| Package | Version | License | Used by |
|---|---|---|---|
| `@anthropic-ai/sdk` | 0.128.0 | MIT | Service |
| `fastify` | 5.12.5 | MIT | Service |
| `@tanstack/react-virtual` | 3.14.13 | MIT | Web |
| `react` | 19.3.0 | MIT | Web |
| `react-dom` | 19.3.0 | MIT | Web |

Note: the generated `THIRD_PARTY_NOTICES.txt` files may list more entries than this table — they are
built from the bundled output and can include these packages' own transitive runtime dependencies as well
as license/attribution files bundled alongside them. Copy the final declaration from those two files, not
from this table.

## 3. "Created with AI" (portal question 1.8.8)

- [ ] Answer **Yes**. LocHub's stated purpose is running AI translation/judge jobs through external
      provider APIs; this is the intended reading of the question for this product.

## 4. Price

- [ ] **PRICE: ask the owner.** Not decided by this checklist — the owner sets it when creating the
      listing.

## 5. Draft and FabURL

- [x] Create the draft listing on Fab.
- [x] Record the resulting Fab listing URL here once the draft exists:

  `FabURL: https://www.fab.com/listings/aaf6a7ae-e02e-4975-91b4-129e2456e491`

## 6. Listing text and media

- [ ] Paste the title, short description, full description, key features, tags and category from
      `Docs/Fab/listing.md` into the corresponding Fab fields.
- [ ] Paste the Technical Information block from `Docs/Fab/listing.md` into Fab's Technical Information
      section.
- [ ] Upload the plugin icon and gallery images per the size/format/count rules in
      `Docs/Fab/media_requirements.md`. Match images to the listing by **role** (thumbnail/cover, grid
      overview, review-queue card with judge notes, Jobs screen with cost estimate, Inbox, glossary,
      coverage) — the final rendered file names are decided when those images are produced, separately
      from this checklist.
- [ ] Confirm the number of gallery images and their aspect ratio/format match what
      `media_requirements.md` records for Fab's current requirements before uploading.

## 7. Before submitting

- [ ] All three zips (5.6/5.7/5.8) attached.
- [ ] Third-party declaration filled from the real `THIRD_PARTY_NOTICES.txt` pair (Section 2).
- [ ] "Created with AI" answered Yes.
- [ ] Price set by the owner.
- [ ] Icon and gallery images uploaded and matched to their roles.
- [ ] Documentation link (Notion) filled in, once published.
- [ ] `clean_project_check.md` run and passed on both a 5.6 and a 5.8 clean project, from the actual zips
      about to be submitted.
