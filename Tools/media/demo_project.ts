// Builds a fully offline demo LocHub project for the Fab listing's screenshots (plan Task 11, Step 2).
//
// Invents a neutral fantasy/survival game ("Thornreach") and writes ~300 units across five namespaces
// (UI, Items, Dialogue, Quests, Tutorial) through the service's own applySnapshot/runTranslateJob/cells
// APIs — never by poking the on-disk file formats by hand. ~100 of those units are translated into
// German, French and Japanese by a small local LlmClient (DemoLlmClient below) that answers from a fixed
// dictionary of hand-written, professional-quality translations; it never touches the network. A few
// translations are deliberately flawed (a dropped placeholder, a dropped do-not-translate term, a wrong
// glossary term, an oversized UI label, a formality slip) so the grid shows a believable mix of clean,
// needs-fix and flagged-for-review rows, plus a glossary and a handful of open/answered Inbox questions.
//
// Determinism: every unit id, translation, judge verdict and count below is fully deterministic (no
// randomness, no external input). The one exception is wall-clock timestamps: CellEvent.ts and
// InboxItem.created/answered are stamped by LocHubStore/job.ts/cells.ts/memory.ts with `new
// Date().toISOString()` internally, and none of those APIs accept an injectable clock, so two runs a
// few milliseconds apart differ only in those timestamp strings — never in content or counts.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResponseCache } from '../../Service/src/cache.js';
import { approveCell, editCell } from '../../Service/src/cells.js';
import {
  KIND_METADATA_KEY,
  type CoverageFinding,
  type Culture,
  type GlossaryTerm,
  type JudgeIssue,
  type Snapshot,
  type SnapshotEntry,
} from '../../Service/src/contract.js';
import { textHash, unitIdOf } from '../../Service/src/ids.js';
import { DEFAULT_JOB_OPTIONS, runTranslateJob, type JobOptions, type JobReport } from '../../Service/src/job.js';
import type { LlmClient, LlmOutcome, LlmRequest } from '../../Service/src/llm.js';
import { answerQuestion } from '../../Service/src/memory.js';
import { applySnapshot } from '../../Service/src/push.js';
import { LocHubStore } from '../../Service/src/store.js';
import { SHOOT_PROVIDER } from './shoot_provider.mjs';

const CULTURES: Culture[] = ['de', 'fr', 'ja'];

// ---------------------------------------------------------------------------------------------------
// Content model
// ---------------------------------------------------------------------------------------------------

// A hand-written translation for one unit into one target culture. `ambiguity`/`question` mirror what a
// real translate response can carry (job.ts records the question in the Inbox); `judge` is a scripted
// judge verdict for this specific (unit, culture) pair, carried separately because job.ts never judges a
// translation that already failed the deterministic precheck (see `hard` below).
interface Localized {
  text: string;
  ambiguity?: 'guessed' | 'context';
  question?: string;
  // True when `text` deliberately fails the deterministic precheck (a dropped placeholder or DNT term):
  // the real runTranslateJob then marks the cell 'needs_fix' on its own and never sends it to the judge.
  hard?: boolean;
  judge?: JudgeIssue;
}

interface UnitDef {
  slug: string; // stable lookup key used later for approvals/edits/questions; never written to the store
  namespace: string;
  key: string;
  source: string;
  origin: string;
  groupKey: string;
  kind?: 'ui' | 'text';
  devNotes?: string;
  localized?: Partial<Record<Culture, Localized>>;
}

function u(
  slug: string,
  namespace: string,
  key: string,
  source: string,
  origin: string,
  groupKey: string,
  opts: { kind?: 'ui' | 'text'; devNotes?: string; localized?: Partial<Record<Culture, Localized>> } = {},
): UnitDef {
  return { slug, namespace, key, source, origin, groupKey, kind: opts.kind, devNotes: opts.devNotes, localized: opts.localized };
}

// Shorthand for the common case: the same clean translation in all three cultures, no ambiguity, no flaw.
function all(de: string, fr: string, ja: string): Partial<Record<Culture, Localized>> {
  return { de: { text: de }, fr: { text: fr }, ja: { text: ja } };
}

// ---------------------------------------------------------------------------------------------------
// Setting: "Thornreach" — an invented frontier survival/crafting world. No real franchises, brands or
// people. Do-not-translate proper nouns: Thornreach (region), Cinderguard (ranger order), Mira Hollowell
// (quest giver), Emberfall Watch (stronghold). Translated glossary terms: Ember Shard, Waystone, Ranger,
// Grovekeeper, Blight, Bounty.
//
// Per-language conventions every translation below follows (the deliberately flawed rows break exactly one):
//  - de: "du" throughout; glossary terms verbatim.
//  - fr: "tu" throughout; common-noun glossary terms lowercase mid-sentence (éclat de braise, rôdeur, gardien du
//    bosquet), "le Fléau" capitalised as a named calamity; a no-break space (" ") before : ? !
//  - ja: system text (UI, tutorial) polite です/ます; quest objectives imperative; NPCs keep their own voice;
//    full-width ：？; no space between Japanese and Latin names or {placeholders} (an argument may itself be
//    Japanese). Nicknames are localised: Old Bram is "der alte Bram" / "le vieux Bram" / "ブラム爺さん".
// ---------------------------------------------------------------------------------------------------

const BRIEF_TEXT = `# Thornreach

Thornreach is a frontier survival/crafting RPG. Players scavenge, craft and trade to survive on the edge
of a spreading environmental hazard called the Blight, while the Cinderguard — a ranger order based at
the watchtower Emberfall Watch — tries to hold the frontier together.

Tone: grounded, a little weary, dry humour rather than grimdark. Player-facing text is plain and short;
UI labels must stay short enough to fit their original widgets. NPC dialogue is spoken, not literary —
keep it conversational.
`;

const GLOSSARY: Record<Culture, GlossaryTerm[]> = {
  de: [
    { term: 'Thornreach', translation: 'Thornreach', dnt: true, note: 'Region name; keep verbatim in every language.' },
    { term: 'Cinderguard', translation: 'Cinderguard', dnt: true, note: "Ranger order based at Emberfall Watch; keep verbatim, don't translate \"guard\"." },
    { term: 'Mira Hollowell', translation: 'Mira Hollowell', dnt: true, note: 'NPC name; keep verbatim.' },
    { term: 'Emberfall Watch', translation: 'Emberfall Watch', dnt: true, note: 'Watchtower stronghold; keep verbatim.' },
    { term: 'Ember Shard', translation: 'Glutsplitter', dnt: false, note: 'Crafting resource, not a proper name.' },
    { term: 'Waystone', translation: 'Wegstein', dnt: false, note: 'Fast-travel landmark.' },
    { term: 'Ranger', translation: 'Waldläufer', dnt: false, note: 'Profession; Cinderguard field members.' },
    { term: 'Grovekeeper', translation: 'Hüter des Hains', dnt: false, note: 'Profession that tends the groves.' },
    { term: 'Blight', translation: 'Fäulnis', dnt: false, note: 'Environmental hazard / status effect.' },
    { term: 'Bounty', translation: 'Kopfgeld', dnt: false, note: 'Bounty-board contract reward.' },
  ],
  fr: [
    { term: 'Thornreach', translation: 'Thornreach', dnt: true, note: 'Region name; keep verbatim in every language.' },
    { term: 'Cinderguard', translation: 'Cinderguard', dnt: true, note: "Ranger order based at Emberfall Watch; keep verbatim, don't translate \"guard\"." },
    { term: 'Mira Hollowell', translation: 'Mira Hollowell', dnt: true, note: 'NPC name; keep verbatim.' },
    { term: 'Emberfall Watch', translation: 'Emberfall Watch', dnt: true, note: 'Watchtower stronghold; keep verbatim.' },
    { term: 'Ember Shard', translation: 'Éclat de braise', dnt: false, note: 'Crafting resource, not a proper name.' },
    { term: 'Waystone', translation: 'Pierre de voyage', dnt: false, note: 'Fast-travel landmark.' },
    { term: 'Ranger', translation: 'Rôdeur', dnt: false, note: 'Profession; Cinderguard field members.' },
    { term: 'Grovekeeper', translation: 'Gardien du bosquet', dnt: false, note: 'Profession that tends the groves.' },
    { term: 'Blight', translation: 'Fléau', dnt: false, note: 'Environmental hazard / status effect.' },
    { term: 'Bounty', translation: 'Prime', dnt: false, note: 'Bounty-board contract reward.' },
  ],
  ja: [
    { term: 'Thornreach', translation: 'Thornreach', dnt: true, note: 'Region name; keep verbatim in every language.' },
    { term: 'Cinderguard', translation: 'Cinderguard', dnt: true, note: "Ranger order based at Emberfall Watch; keep verbatim, don't translate \"guard\"." },
    { term: 'Mira Hollowell', translation: 'Mira Hollowell', dnt: true, note: 'NPC name; keep verbatim.' },
    { term: 'Emberfall Watch', translation: 'Emberfall Watch', dnt: true, note: 'Watchtower stronghold; keep verbatim.' },
    { term: 'Ember Shard', translation: '残り火の欠片', dnt: false, note: 'Crafting resource, not a proper name.' },
    { term: 'Waystone', translation: '道標の石', dnt: false, note: 'Fast-travel landmark.' },
    { term: 'Ranger', translation: 'レンジャー', dnt: false, note: 'Profession; Cinderguard field members.' },
    { term: 'Grovekeeper', translation: '森の番人', dnt: false, note: 'Profession that tends the groves.' },
    { term: 'Blight', translation: '腐敗', dnt: false, note: 'Environmental hazard / status effect.' },
    { term: 'Bounty', translation: '賞金', dnt: false, note: 'Bounty-board contract reward.' },
  ],
};

// Per-language style guide (glossary screen). Mirrors the conventions already followed by every translation
// below (see the comment above GLOSSARY): a reviewer opening the Style guide box for a culture sees the same
// rules the demo's own translations were written against, not an empty box.
const STYLE_GUIDES: Record<Culture, string> = {
  de: `- Address the player as "du" everywhere; never "Sie".
- UI labels must stay short: buttons and HUD stats should fit in ~10-14 characters, even if that means dropping an article.
- Tone: grounded and a little weary, dry humour rather than grimdark.
- Decimals use a comma, thousands a period (1.234,5), matching de-DE convention.
- Keep DNT terms (Cinderguard, Thornreach, Emberfall Watch, Mira Hollowell) exactly as given — never translate or inflect them.`,
  fr: `- Address the player as "tu", never "vous".
- Insert a no-break space before ; : ? ! (standard French typography).
- Keep DNT terms (Cinderguard, Thornreach, Emberfall Watch, Mira Hollowell) untranslated.`,
  ja: `- System text and tutorial hints stay polite (です/ます); NPC dialogue keeps each character's own voice.
- Use full-width ：？ punctuation; no space between Japanese text and {placeholders} or Latin names.
- Keep DNT terms (Cinderguard, Thornreach, Emberfall Watch, Mira Hollowell) untranslated.`,
};

// A handful of realistic coverage findings (Service/CONTRACT.md's Push protocol): player-visible strings that
// bypass localization entirely, each with the exact two kinds LocHubCoverage.cpp reports
// (CoverageKindFromString for an FText::FromString literal in C++, CoverageKindRmlLiteral for a literal string
// in a .rml document) plus a plausible file:line and the offending text.
const COVERAGE_FINDINGS: CoverageFinding[] = [
  { kind: 'FromString', file: 'Source/MyGame/Private/UI/HUDWidget.cpp', line: 87, text: 'Loading...' },
  { kind: 'FromString', file: 'Source/MyGame/Private/Inventory/InventoryComponent.cpp', line: 142, text: 'Inventory full' },
  { kind: 'FromString', file: 'Source/MyGame/Private/AI/CinderguardPatrolAI.cpp', line: 63, text: 'Halt! State your business.' },
  { kind: 'RmlLiteral', file: 'Content/DevUI/HUD/hud.rml', line: 22, text: 'Press E to loot' },
  { kind: 'RmlLiteral', file: 'Content/DevUI/Menus/settings.rml', line: 9, text: 'Apply' },
];

// ---------------------------------------------------------------------------------------------------
// UI namespace — 60 units (20 translated)
// ---------------------------------------------------------------------------------------------------

// Every origin uses one of the two shapes the gather writes and Web/src/origin.ts parses, so each row shows an
// openable asset or source file:
//  - asset: an object path "<Package>.<Object>" plus the member path. UMG text lives under the WidgetTree
//    subobject ("/Game/.../WBP_X.WBP_X:WidgetTree.Txt_Label.Text"); DataTable rows are
//    "<Package>.<Object>.<Row>.<Property>" (GatherDataTableForLocalization in Engine DataTable.cpp).
//  - C++ LOCTEXT: "Source/.../File.cpp(<line>)" (FSourceLocation::ToString).
// None of them may end in ":<digits>" or "(<digits>)" unless it is a C++ line, or the parser reads a line.

// PascalCase identifier from a display string, for plausible widget and row names ("Master Volume" -> "MasterVolume").
function pascal(text: string): string {
  return text
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word.length > 0)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join('');
}

const UI_FOLDER: Record<string, string> = { MainMenu: 'Menus', Settings: 'Menus', GameMenu: 'Menus', HUD: 'HUD', ItemActions: 'Inventory' };
const WIDGET_ORIGIN = (widget: string, label: string) =>
  `/Game/MyGame/UI/${UI_FOLDER[widget]}/WBP_${widget}.WBP_${widget}:WidgetTree.Txt_${pascal(label)}.Text`;

// Notifications and prompts are FText::Format patterns declared with LOCTEXT in C++, so they carry file:line.
let notificationLine = 18;
const NOTIFICATION_ORIGIN = () => `Source/MyGame/Private/UI/GameNotifications.cpp(${(notificationLine += 3)})`;

const uiUnits: UnitDef[] = [
  // Main menu (translated)
  u('ui.newGame', 'UI', 'MainMenu.NewGame', 'New Game', WIDGET_ORIGIN('MainMenu', 'NewGame'), 'UI/MainMenu', {
    kind: 'ui', devNotes: 'Main menu button, title screen. Keep to ~14 characters so it fits the button.', localized: all('Neues Spiel', 'Nouvelle partie', 'ニューゲーム'),
  }),
  u('ui.continue', 'UI', 'MainMenu.Continue', 'Continue', WIDGET_ORIGIN('MainMenu', 'Continue'), 'UI/MainMenu', {
    kind: 'ui', devNotes: 'Main menu button, only shown when a save exists. ~14 characters max.', localized: all('Fortsetzen', 'Continuer', 'コンティニュー'),
  }),
  u('ui.settingsLabel', 'UI', 'MainMenu.Settings', 'Settings', WIDGET_ORIGIN('MainMenu', 'Settings'), 'UI/MainMenu', {
    kind: 'ui', devNotes: 'Main menu button opening the Settings screen. ~14 characters max.', localized: all('Einstellungen', 'Paramètres', '設定'),
  }),
  u('ui.quit', 'UI', 'MainMenu.Quit', 'Quit', WIDGET_ORIGIN('MainMenu', 'Quit'), 'UI/MainMenu', {
    kind: 'ui', devNotes: 'Main menu button; a confirmation prompt follows. ~10 characters max.', localized: all('Beenden', 'Quitter', '終了'),
  }),
  u('ui.credits', 'UI', 'MainMenu.Credits', 'Credits', WIDGET_ORIGIN('MainMenu', 'Credits'), 'UI/MainMenu', {
    kind: 'ui', devNotes: 'Main menu button opening the credits scroll. ~14 characters max.', localized: all('Mitwirkende', 'Crédits', 'クレジット'),
  }),
  // HUD core stats (translated). DE "Hunger" equals the source on purpose: it is correct German and shows the
  // precheck's soft "untranslated" flag (band Y) on a legitimate row.
  u('ui.health', 'UI', 'HUD.Health', 'Health', WIDGET_ORIGIN('HUD', 'Health'), 'UI/HUD', {
    kind: 'ui', devNotes: 'HUD stat label, always on screen. Very tight: 6-8 characters.', localized: all('Gesundheit', 'Santé', '体力'),
  }),
  u('ui.stamina', 'UI', 'HUD.Stamina', 'Stamina', WIDGET_ORIGIN('HUD', 'Stamina'), 'UI/HUD', {
    kind: 'ui', devNotes: 'HUD stat label, always on screen. Very tight: 6-8 characters.', localized: all('Ausdauer', 'Endurance', 'スタミナ'),
  }),
  u('ui.hunger', 'UI', 'HUD.Hunger', 'Hunger', WIDGET_ORIGIN('HUD', 'Hunger'), 'UI/HUD', {
    kind: 'ui', devNotes: 'HUD stat label, always on screen. Very tight: 6-8 characters.', localized: all('Hunger', 'Faim', '空腹度'),
  }),
  u('ui.thirst', 'UI', 'HUD.Thirst', 'Thirst', WIDGET_ORIGIN('HUD', 'Thirst'), 'UI/HUD', {
    kind: 'ui', devNotes: 'HUD stat label, always on screen. Very tight: 6-8 characters.', localized: all('Durst', 'Soif', '喉の渇き'),
  }),
  u('ui.inventoryLabel', 'UI', 'HUD.Inventory', 'Inventory', WIDGET_ORIGIN('HUD', 'Inventory'), 'UI/HUD', {
    kind: 'ui', devNotes: 'HUD button opening the inventory screen. ~10 characters max.', localized: all('Inventar', 'Inventaire', '持ち物'),
  }),
  // Prompts / notifications (translated) — deliberate flaw A: DE drops {ItemName}
  u('ui.itemAdded', 'UI', 'Prompts.ItemAdded', 'Item added to inventory: {ItemName}', NOTIFICATION_ORIGIN(), 'UI/Prompts', {
    kind: 'ui',
    devNotes: "Toast notification on pickup; {ItemName} is the item's display name. One line, disappears after 3s.",
    localized: {
      de: { text: 'Gegenstand zum Inventar hinzugefügt.', hard: true },
      fr: { text: "Objet ajouté à l'inventaire\u00a0: {ItemName}" },
      ja: { text: '持ち物に追加：{ItemName}' },
    },
  }),
  u('ui.pressToInteract', 'UI', 'Prompts.PressToInteract', 'Press {Key} to interact.', NOTIFICATION_ORIGIN(), 'UI/Prompts', {
    kind: 'ui',
    devNotes: 'Contextual prompt above an interactable object; {Key} is the bound key glyph. Must stay short.',
    localized: all('Drücke {Key}, um zu interagieren.', 'Appuie sur {Key} pour interagir.', '{Key}で調べる'),
  }),
  u('ui.afflicted', 'UI', 'Prompts.Afflicted', 'You have been afflicted by {StatusName}.', NOTIFICATION_ORIGIN(), 'UI/Prompts', {
    kind: 'ui',
    devNotes: "Toast notification when a status effect is applied; {StatusName} is the effect's display name.",
    localized: all('Du wurdest von {StatusName} befallen.', "Tu subis l'effet {StatusName}.", '{StatusName}の影響を受けました。'),
  }),
  u('ui.inventoryFull', 'UI', 'Prompts.InventoryFull', 'Your inventory is full.', NOTIFICATION_ORIGIN(), 'UI/Prompts', {
    kind: 'ui',
    devNotes: 'Toast notification shown when a pickup fails because the inventory is full.',
    localized: all('Dein Inventar ist voll.', 'Ton inventaire est plein.', '持ち物がいっぱいです。'),
  }),
  u('ui.questCompleted', 'UI', 'Prompts.QuestCompleted', 'Quest completed: {QuestName}', NOTIFICATION_ORIGIN(), 'UI/Prompts', {
    kind: 'ui',
    devNotes: "Toast notification when a quest is turned in; {QuestName} is the quest's title.",
    localized: all('Quest abgeschlossen: {QuestName}', 'Quête terminée\u00a0: {QuestName}', 'クエスト完了：{QuestName}'),
  }),
  // Settings (translated) — deliberate flaw E: FR is a far-too-long button label
  u('ui.apply', 'UI', 'Settings.Apply', 'Apply', WIDGET_ORIGIN('Settings', 'Apply'), 'UI/Settings', {
    kind: 'ui',
    devNotes: 'Settings screen button that commits pending changes. Very tight: the button is ~90px wide.',
    localized: {
      de: { text: 'Übernehmen' },
      fr: {
        text: 'Appliquer les modifications maintenant',
        judge: { severity: 'minor', category: 'length', why: 'The button label is far longer than the source and will overflow the Settings button.', fix: 'Appliquer' },
      },
      ja: { text: '適用' },
    },
  }),
  // Approved below (culture de, see APPROVALS): a human reviewer signed off on the draft as shown.
  u('ui.saveComplete', 'UI', 'Prompts.SaveComplete', 'Save complete.', NOTIFICATION_ORIGIN(), 'UI/Prompts', {
    kind: 'ui',
    devNotes: 'Toast notification after a manual or autosave finishes.',
    localized: all('Speichern abgeschlossen.', 'Sauvegarde terminée.', 'セーブが完了しました。'),
  }),
  // Edited below (culture de, see EDITS): a human reviewer polished the draft before it shipped.
  u('ui.loading', 'UI', 'Prompts.Loading', 'Loading…', NOTIFICATION_ORIGIN(), 'UI/Prompts', {
    kind: 'ui',
    devNotes: 'Loading screen label, shown while a level streams in.',
    localized: all('Wird geladen…', 'Chargement…', '読み込み中…'),
  }),
  u('ui.discardItem', 'UI', 'Prompts.DiscardItem', 'Discard item?', NOTIFICATION_ORIGIN(), 'UI/Prompts', {
    kind: 'ui',
    devNotes: 'Confirmation prompt before discarding an inventory item.',
    localized: all('Gegenstand wegwerfen?', "Jeter l'objet\u00a0?", 'アイテムを破棄しますか？'),
  }),
  u('ui.sort', 'UI', 'Actions.Sort', 'Sort', WIDGET_ORIGIN('ItemActions', 'Sort'), 'UI/Actions', {
    kind: 'ui', devNotes: 'Inventory toolbar button that re-sorts the item list. ~8 characters max.', localized: all('Sortieren', 'Trier', '並べ替え'),
  }),
  // Deliberate flaw H: DE drops the |plural(...) modifier entirely, even though the source has one and de
  // has more than one plural form — precheck.ts's plural_dropped hard issue. Key sorts after
  // "Prompts.ItemAdded" (the other de needs_fix row) within the UI namespace, so the queue (05, unchanged)
  // still shows ItemAdded first and this row is a genuinely different card (02).
  u('ui.keybindsReset', 'UI', 'Settings.KeybindsReset', 'Reset {Count} {Count}|plural(one=keybind,other=keybinds) to default.', NOTIFICATION_ORIGIN(), 'UI/Settings', {
    kind: 'ui',
    devNotes: 'Toast notification after resetting key bindings; {Count} is how many changed.',
    localized: {
      de: { text: 'Setze {Count} Tastenbelegungen zurück.', hard: true },
      fr: { text: 'Réinitialise {Count} {Count}|plural(one=raccourci,many=raccourcis,other=raccourcis) par défaut.' },
      ja: { text: 'キー割り当てを{Count}個リセットしました。' },
    },
  }),

  // Filler (untranslated) — 40 units
  ...[
    'Graphics', 'Audio', 'Controls', 'Gameplay', 'Back', 'Master Volume', 'Music Volume', 'SFX Volume', 'Brightness',
    'Field of View', 'Subtitles', 'Language', 'Invert Y Axis', 'Vibration', 'Screen Resolution',
  ].map((s, i) => u(`ui.settings.${i}`, 'UI', `Settings.${i}`, s, WIDGET_ORIGIN('Settings', s), 'UI/Settings', { kind: 'ui' })),
  ...['Map', 'Quest Log', 'Crafting', 'Waystone Fast Travel', 'Bounty Board'].map((s, i) =>
    u(`ui.hud.${i}`, 'UI', `HUD.${i}`, s, WIDGET_ORIGIN('HUD', s), 'UI/HUD', { kind: 'ui' }),
  ),
  // Shown in a frame (01_grid, via the grid's "prompts" search): gets devNotes too, even though it is filler.
  u('ui.prompt.0', 'UI', 'Prompts.0', 'Are you sure you want to quit?', NOTIFICATION_ORIGIN(), 'UI/Prompts', {
    kind: 'ui', devNotes: 'Confirmation dialog shown when the player chooses Quit from the pause menu.',
  }),
  ...['Equip', 'Unequip', 'Drop', 'Use', 'Repair', 'Sell', 'Buy', 'Craft', 'Filter'].map((s, i) =>
    u(`ui.action.${i}`, 'UI', `Actions.${i}`, s, WIDGET_ORIGIN('ItemActions', s), 'UI/Actions', { kind: 'ui' }),
  ),
  ...[
    'Achievements', 'Statistics', 'Return to Title', 'Resume', 'New Bounty Available', 'Level Up!', 'Skill Point Available', 'Server Browser', 'Multiplayer', 'Photo Mode',
  ].map((s, i) => u(`ui.meta.${i}`, 'UI', `Meta.${i}`, s, WIDGET_ORIGIN('GameMenu', s), 'UI/Meta', { kind: 'ui' })),
];

// ---------------------------------------------------------------------------------------------------
// Items namespace — 100 units (30 translated: 15 items × name + description)
// ---------------------------------------------------------------------------------------------------

const ITEM_ORIGIN = (row: string, property: 'Name' | 'Description') => `/Game/MyGame/Data/DT_Items.DT_Items.${row}.${property}`;

interface ItemDef {
  slug: string;
  key: string;
  name: string;
  desc: string;
  nameL?: Partial<Record<Culture, Localized>>;
  descL?: Partial<Record<Culture, Localized>>;
}

const translatedItems: ItemDef[] = [
  {
    slug: 'emberShard', key: 'EmberShard',
    name: 'Ember Shard', desc: "A shard of cooled ember, still warm to the touch. Rangers of the Cinderguard trade it for supplies at Thornreach's outposts.",
    nameL: {
      de: { text: 'Glutsplitter', ambiguity: 'guessed', question: "Is 'Ember' used here as a proper name for the resource, or just a description of its glow?" },
      fr: { text: 'Éclat de braise' },
      ja: { text: '残り火の欠片' },
    },
    descL: all(
      'Ein Splitter erkalteter Glut, der sich noch warm anfühlt. Waldläufer der Cinderguard tauschen ihn in den Außenposten von Thornreach gegen Vorräte ein.',
      "Un éclat de braise refroidie, encore tiède au toucher. Les rôdeurs du Cinderguard l'échangent contre des provisions aux avant-postes de Thornreach.",
      '冷えた残り火の欠片。まだほのかに温かい。Cinderguardのレンジャーは、Thornreachの前哨基地でこれを物資と交換してくれる。',
    ),
  },
  {
    slug: 'waystoneFragment', key: 'WaystoneFragment',
    name: 'Waystone Fragment', desc: "A broken piece of a Waystone's core. A Grovekeeper can bind it into a new travel charm.",
    nameL: all('Wegstein-Fragment', 'Fragment de pierre de voyage', '道標の石の欠片'),
    descL: all(
      'Ein abgebrochenes Stück vom Kern eines Wegsteins. Ein Hüter des Hains kann daraus ein neues Reiseamulett binden.',
      "Un morceau brisé du cœur d'une pierre de voyage. Un gardien du bosquet peut l'enchâsser dans un nouveau charme de voyage.",
      '道標の石の核から砕け落ちた欠片。森の番人ならこれを新たな旅の護符に結び直せる。',
    ),
  },
  {
    slug: 'rangersCloak', key: 'RangersCloak',
    name: "Ranger's Cloak", desc: 'Standard-issue cloak of the Cinderguard. Keeps the rain off and the cinderfall smell out.',
    nameL: all('Waldläufermantel', 'Cape de rôdeur', 'レンジャーのマント'),
    descL: all(
      'Standardmantel der Cinderguard. Hält den Regen ab und den Aschegeruch draußen.',
      'Cape réglementaire du Cinderguard. Elle protège de la pluie et de l\'odeur des cendres.',
      'Cinderguard支給の標準装備のマント。雨をしのぎ、灰の匂いを寄せ付けない。',
    ),
  },
  {
    slug: 'grovekeepersSatchel', key: 'GrovekeepersSatchel',
    name: "Grovekeeper's Satchel", desc: 'A worn satchel lined with dried leaves. Keeps herbs fresh twice as long.',
    nameL: all('Ranzen des Hüters des Hains', 'Besace du gardien du bosquet', '森の番人の肩掛け鞄'),
    descL: all(
      'Ein abgenutzter Ranzen, ausgekleidet mit getrockneten Blättern. Hält Kräuter doppelt so lange frisch.',
      'Une besace usée doublée de feuilles séchées. Elle garde les herbes fraîches deux fois plus longtemps.',
      '乾いた葉で内張りした、使い古しの肩掛け鞄。薬草の鮮度を通常の倍保つ。',
    ),
  },
  {
    // Deliberate flaw B: FR drops {Reward}
    slug: 'bountyContract', key: 'BountyContract',
    name: 'Bounty Contract', desc: 'A signed request from the Bounty Board. Complete it for {Reward} coin.',
    nameL: all('Kopfgeldvertrag', 'Contrat de prime', '賞金首の依頼書'),
    descL: {
      de: { text: 'Ein unterschriebener Auftrag vom Kopfgeldbrett. Erfülle ihn für {Reward} Münzen.' },
      fr: { text: 'Une demande signée du tableau des primes. Accomplis-la pour empocher la récompense.', hard: true },
      ja: { text: '賞金首の掲示板から取った、署名入りの依頼書。達成すると{Reward}枚のコインがもらえる。' },
    },
  },
  {
    slug: 'duskhornHide', key: 'DuskhornHide',
    name: 'Duskhorn Hide', desc: 'Thick hide from a Duskhorn Stag. Popular with the Cinderguard\'s tailors.',
    nameL: all('Dämmerhirschfell', 'Peau de cerf du crépuscule', '黄昏の角鹿の毛皮'),
    descL: all(
      'Dickes Fell eines Dämmerhirschs. Beliebt bei den Schneidern der Cinderguard.',
      'Peau épaisse d\'un cerf du crépuscule. Très prisée par les tailleurs du Cinderguard.',
      'Cinderguardの仕立て屋に人気がある、黄昏の角鹿の厚い毛皮。',
    ),
  },
  {
    slug: 'healingHerb', key: 'HealingHerb',
    name: 'Healing Herb', desc: 'A common herb with mild restorative properties. The Grovekeeper always wants more.',
    nameL: all('Heilkraut', 'Herbe curative', '癒しの薬草'),
    descL: all(
      'Ein gewöhnliches Kraut mit leicht heilender Wirkung. Der Hüter des Hains kann nie genug davon bekommen.',
      'Une herbe commune aux légères vertus curatives. Le gardien du bosquet en veut toujours plus.',
      '軽い治癒効果を持つありふれた薬草。森の番人はいつももっと欲しがっている。',
    ),
  },
  {
    slug: 'ironSword', key: 'IronSword',
    name: 'Iron Sword', desc: 'A simple, well-balanced blade. Not fancy, but it gets the job done.',
    nameL: all('Eisenschwert', 'Épée en fer', '鉄の剣'),
    descL: all(
      'Eine einfache, gut ausbalancierte Klinge. Nicht prächtig, aber zuverlässig.',
      'Une lame simple et bien équilibrée. Rien d\'extraordinaire, mais elle fait le travail.',
      'シンプルでバランスの取れた剣。見栄えはしないが、仕事はきちんとこなす。',
    ),
  },
  {
    slug: 'huntingBow', key: 'HuntingBow',
    name: 'Hunting Bow', desc: 'A lightweight bow favored by Rangers for tracking game through dense brush.',
    nameL: all('Jagdbogen', 'Arc de chasse', '狩猟弓'),
    descL: all(
      'Ein leichter Bogen, den Waldläufer bevorzugen, um Wild durch dichtes Unterholz zu verfolgen.',
      'Un arc léger apprécié des rôdeurs pour traquer le gibier dans les broussailles.',
      'レンジャーに好まれる軽量の弓で、深い茂みの中でも獲物を追跡できる。',
    ),
  },
  {
    slug: 'campfireKit', key: 'CampfireKit',
    name: 'Campfire Kit', desc: 'Flint, tinder and a folding grate. Everything needed for a night on the trail.',
    nameL: all('Lagerfeuer-Set', 'Kit de feu de camp', '焚き火セット'),
    descL: all(
      'Feuerstein, Zunder und ein Klapprost. Alles, was man für eine Nacht unterwegs braucht.',
      'Silex, amadou et une grille pliante. Tout ce qu\'il faut pour une nuit sur la piste.',
      '火打石、火口、折りたたみ式の焼き網。道中の一夜に必要なものが揃っている。',
    ),
  },
  {
    slug: 'trailMap', key: 'TrailMap',
    name: 'Trail Map', desc: 'A hand-drawn map of the trails around Thornreach. Mostly accurate.',
    nameL: all('Wanderkarte', 'Carte des sentiers', '小道の地図'),
    descL: all(
      'Eine handgezeichnete Karte der Pfade rund um Thornreach. Größtenteils zuverlässig.',
      'Une carte des sentiers autour de Thornreach, dessinée à la main. Globalement fiable.',
      'Thornreach周辺の小道を手描きした地図。おおむね正確。',
    ),
  },
  {
    slug: 'wardingCharm', key: 'WardingCharm',
    name: 'Warding Charm', desc: 'A carved token said to ward off the worst of the Blight. Old Bram swears by it.',
    nameL: all('Schutzamulett', 'Charme de protection', '魔除けの護符'),
    descL: {
      de: { text: 'Ein geschnitztes Amulett, das angeblich vor dem Schlimmsten der Fäulnis schützt. Der alte Bram schwört darauf.' },
      fr: {
        text: 'Un talisman sculpté censé repousser le pire du Fléau. Le vieux Bram jure que ça marche.',
        ambiguity: 'guessed',
        question: "Is 'Old Bram swears by it' a literal oath, or just a colloquial 'he really believes in it'? Affects how casual the French should read.",
      },
      ja: { text: '腐敗の最もひどい害から身を守ってくれるという、手彫りの護符。ブラム爺さんはこれを固く信じている。' },
    },
  },
  {
    slug: 'cinderDust', key: 'CinderDust',
    name: 'Cinder Dust', desc: 'Fine ash left over from a spent Ember Shard. Useful in a dozen recipes.',
    nameL: all('Aschestaub', 'Poussière de cendre', '燃えかす'),
    descL: all(
      'Feine Asche, die von einem verbrauchten Glutsplitter übrig bleibt. In einem Dutzend Rezepten nützlich.',
      'Cendre fine laissée par un éclat de braise consumé. Utile dans une dizaine de recettes.',
      '使い切った残り火の欠片から出る細かい灰。多くのレシピで役立つ。',
    ),
  },
  {
    slug: 'travelersBoots', key: 'TravelersBoots',
    name: "Traveler's Boots", desc: 'Sturdy boots broken in over many miles. Comfortable from the first step.',
    nameL: all('Wanderstiefel', 'Bottes de voyageur', '旅人のブーツ'),
    descL: all(
      'Robuste Stiefel, über viele Meilen eingelaufen. Bequem vom ersten Schritt an.',
      'Des bottes robustes rodées par de nombreux kilomètres. Confortables dès le premier pas.',
      '長い距離を歩いて馴染んだ丈夫なブーツ。履いた瞬間から快適。',
    ),
  },
  {
    slug: 'emberfallWatchInsignia', key: 'EmberfallWatchInsignia',
    name: 'Emberfall Watch Insignia', desc: 'A tarnished badge from Emberfall Watch. Once worn by every Cinderguard captain stationed there.',
    nameL: all('Abzeichen von Emberfall Watch', "Insigne d'Emberfall Watch", 'Emberfall Watchの記章'),
    descL: all(
      'Ein angelaufenes Abzeichen aus Emberfall Watch. Früher von jedem dort stationierten Cinderguard-Hauptmann getragen.',
      "Un insigne terni provenant d'Emberfall Watch. Autrefois porté par chaque capitaine du Cinderguard qui y était posté.",
      'Emberfall Watchのくすんだ記章。かつてそこに駐屯したCinderguardの隊長たちが、皆これを身につけていた。',
    ),
  },
];

const fillerItems: { key: string; name: string; desc: string }[] = [
  { key: 'IronOre', name: 'Iron Ore', desc: 'Raw ore chipped from the hillside. Smelts into usable ingots with enough heat.' },
  { key: 'CopperOre', name: 'Copper Ore', desc: 'Softer than iron and easier to find. Good for early tools.' },
  { key: 'OakLog', name: 'Oak Log', desc: 'A heavy length of oak. Slow to cut but strong once seasoned.' },
  { key: 'PineLog', name: 'Pine Log', desc: 'Light and easy to split. Burns fast, does not last.' },
  { key: 'LinenCloth', name: 'Linen Cloth', desc: 'Woven from cultivated flax. The backbone of most crafted clothing.' },
  { key: 'LeatherStrap', name: 'Leather Strap', desc: 'A simple strip of tanned leather. Holds gear together.' },
  { key: 'FrostcapMushroom', name: 'Frostcap Mushroom', desc: 'Grows in shaded, cold ground. Bitter raw, better cooked.' },
  { key: 'CleanWater', name: 'Clean Water', desc: 'Filtered and safe to drink. Heavier than it looks in a full waterskin.' },
  { key: 'RationPack', name: 'Ration Pack', desc: 'Compressed trail food. Not tasty, but it keeps hunger away.' },
  { key: 'SteelAxe', name: 'Steel Axe', desc: 'A heavier axe for felling the thickest trunks.' },
  { key: 'Bedroll', name: 'Bedroll', desc: "Rolls up small, unrolls into a night's rest anywhere flat enough." },
  { key: 'FishingRod', name: 'Fishing Rod', desc: 'A simple cane rod with a horsehair line.' },
  { key: 'Torch', name: 'Torch', desc: 'Wrapped cloth and pitch on a stick. Burns for about an hour.' },
  { key: 'Lockpick', name: 'Lockpick', desc: 'A thin sliver of metal, bent just so. Works on simple locks.' },
  { key: 'Whetstone', name: 'Whetstone', desc: 'Smooths a dulled edge back to sharp in a few passes.' },
  { key: 'TannedLeather', name: 'Tanned Leather', desc: 'Cured hide, softened and ready for stitching.' },
  { key: 'IronIngot', name: 'Iron Ingot', desc: 'Smelted and cooled into a workable bar.' },
  { key: 'SteelIngot', name: 'Steel Ingot', desc: 'Iron reforged with charcoal for a harder edge.' },
  { key: 'Charcoal', name: 'Charcoal', desc: 'Slow-burned wood. Runs hotter than raw logs in a forge.' },
  { key: 'Resin', name: 'Resin', desc: 'Sticky sap tapped from pine bark. Useful as an adhesive.' },
  { key: 'BeeswaxCandle', name: 'Beeswax Candle', desc: 'Burns cleaner and longer than tallow.' },
  { key: 'DriedMeat', name: 'Dried Meat', desc: 'Salted and smoked. Keeps for weeks on the trail.' },
  { key: 'BerryPreserve', name: 'Berry Preserve', desc: 'Boiled down and jarred. A rare bit of sweetness out here.' },
  { key: 'SpicedStew', name: 'Spiced Stew', desc: 'Whatever was left in the pot, seasoned well.' },
  { key: 'StonePickaxe', name: 'Stone Pickaxe', desc: 'Crude but serviceable. Good enough for softer ore.' },
  { key: 'IronPickaxe', name: 'Iron Pickaxe', desc: 'Cuts through stone and ore far faster than the stone kind.' },
  { key: 'Rope', name: 'Rope', desc: "Braided fiber, strong enough to hold a grown man's weight." },
  { key: 'GrapplingHook', name: 'Grappling Hook', desc: 'Three barbed prongs on a length of rope. Handy for cliffs.' },
  { key: 'Waterskin', name: 'Waterskin', desc: "Holds enough water for a day's travel, if you're careful." },
  { key: 'SignalFlare', name: 'Signal Flare', desc: 'Burns bright red. Visible for miles at night.' },
  { key: 'MoonpetalFlower', name: 'Moonpetal Flower', desc: 'Blooms only at night. Prized by alchemists.' },
  { key: 'AshwoodPlank', name: 'Ashwood Plank', desc: 'Cut from trees that grew too close to the Blight. Unusually light.' },
  { key: 'RustyKey', name: 'Rusty Key', desc: 'Corroded past recognition. Might still open something, somewhere.' },
  { key: 'OldCompass', name: 'Old Compass', desc: 'The needle sticks sometimes, but it mostly points true.' },
  { key: 'ReinforcedBackpack', name: 'Reinforced Backpack', desc: 'Extra straps and a steel frame. Carries more without cutting into your shoulders.' },
];

const itemUnits: UnitDef[] = [
  ...translatedItems.flatMap((it) => [
    u(`item.${it.slug}.name`, 'Items', `${it.key}.Name`, it.name, ITEM_ORIGIN(it.key, 'Name'), `Items/${it.key}`, {
      kind: 'text',
      devNotes: `Inventory list name for "${it.name}". The matching Desc row below is the tooltip body.`,
      localized: it.nameL,
    }),
    u(`item.${it.slug}.desc`, 'Items', `${it.key}.Desc`, it.desc, ITEM_ORIGIN(it.key, 'Description'), `Items/${it.key}`, {
      kind: 'text',
      devNotes: `Tooltip body for "${it.name}". The Name row above is the inventory list label.`,
      localized: it.descL,
    }),
  ]),
  ...fillerItems.flatMap((it) => [
    u(`item.filler.${it.key}.name`, 'Items', `${it.key}.Name`, it.name, ITEM_ORIGIN(it.key, 'Name'), `Items/${it.key}`, { kind: 'text' }),
    u(`item.filler.${it.key}.desc`, 'Items', `${it.key}.Desc`, it.desc, ITEM_ORIGIN(it.key, 'Description'), `Items/${it.key}`, { kind: 'text' }),
  ]),
];

// ---------------------------------------------------------------------------------------------------
// Dialogue namespace — 60 units (25 translated)
// ---------------------------------------------------------------------------------------------------

// One DataTable per speaker, one row per line, the spoken text in the row's "Text" property.
const DIALOGUE_ORIGIN = (npc: string, row: string) => `/Game/MyGame/Dialogue/DT_NPC_${npc}.DT_NPC_${npc}.${row}.Text`;
const rowNumber = (i: number) => String(i + 1).padStart(2, '0');

// Per-speaker developer notes, reused across every one of that speaker's translated lines: who they are and
// how they sound, so a translator without art-of-record access still gets the voice right.
const MIRA_NOTE = 'Mira Hollowell, the quest giver in Thornreach: warm, encouraging, a little worn down. Spoken line, no strict length limit.';
const BRAM_NOTE = 'Old Bram, the town blacksmith: gruff, practical, dry humour. Spoken line.';
const RENN_NOTE = 'Captain Renn of the Cinderguard: clipped, formal, no-nonsense. Spoken line.';
const SELLA_NOTE = 'Sella the trader: friendly, transactional, always closing a deal. Spoken line.';

const dialogueUnits: UnitDef[] = [
  // Mira Hollowell — quest giver (7 translated). JA voice: soft, feminine, casual (…わ, …の, …て).
  u('dlg.mira.welcome', 'Dialogue', 'Mira.Welcome', 'Welcome to Thornreach, {PlayerName}.', DIALOGUE_ORIGIN('Mira', 'Welcome'), 'Dialogue/Mira', {
    kind: 'text', devNotes: MIRA_NOTE, localized: all('Willkommen in Thornreach, {PlayerName}.', 'Bienvenue à Thornreach, {PlayerName}.', 'Thornreachへようこそ、{PlayerName}。'),
  }),
  u('dlg.mira.notFromHere', 'Dialogue', 'Mira.NotFromHere', "You're not from around here, are you?", DIALOGUE_ORIGIN('Mira', 'NotFromHere'), 'Dialogue/Mira', {
    kind: 'text',
    devNotes: MIRA_NOTE,
    localized: {
      de: { text: 'Du bist nicht von hier, oder?', ambiguity: 'guessed', question: 'Should Mira address the player formally (Sie) or casually (du) at this point in the story?' },
      fr: { text: "Tu n'es pas du coin, pas vrai\u00a0?" },
      ja: { text: 'あなた、この辺りの人じゃないわよね？' },
    },
  }),
  u('dlg.mira.thanks', 'Dialogue', 'Mira.Thanks', 'Thank you for your help. Thornreach owes you a debt.', DIALOGUE_ORIGIN('Mira', 'Thanks'), 'Dialogue/Mira', {
    kind: 'text',
    devNotes: MIRA_NOTE,
    localized: {
      de: { text: 'Danke für deine Hilfe. Thornreach steht in deiner Schuld.' },
      fr: { text: 'Merci pour ton aide. Thornreach a une dette envers toi.' },
      ja: {
        text: 'ありがとよ、助かったぜ。Thornreachはお前に借りができたな。',
        judge: {
          severity: 'major', category: 'tone',
          why: 'Rough, masculine phrasing ("ありがとよ", "ぜ", "お前") breaks the soft, feminine voice Mira uses in every other line ("…わ", "…の", "あなた").',
          fix: 'ありがとう、助かったわ。Thornreachはあなたに借りができたわね。',
        },
      },
    },
  }),
  u('dlg.mira.warning', 'Dialogue', 'Mira.Warning', 'The Grovekeeper asked me to pass along a warning: stay off the north trail after dark.', DIALOGUE_ORIGIN('Mira', 'Warning'), 'Dialogue/Mira', {
    kind: 'text',
    devNotes: MIRA_NOTE,
    localized: all(
      'Der Hüter des Hains bat mich, eine Warnung weiterzugeben: Bleib nach Einbruch der Dunkelheit vom nördlichen Pfad fern.',
      "Le gardien du bosquet m'a demandé de te transmettre un avertissement\u00a0: évite le sentier du nord après la tombée de la nuit.",
      '森の番人から言付けを頼まれたの。日が暮れたら北の小道には近づかないで。',
    ),
  }),
  u('dlg.mira.cinderguard', 'Dialogue', 'Mira.Cinderguard', "The Cinderguard keep the roads safe, but even they can't be everywhere.", DIALOGUE_ORIGIN('Mira', 'Cinderguard'), 'Dialogue/Mira', {
    kind: 'text',
    devNotes: MIRA_NOTE,
    localized: all(
      'Die Cinderguard hält die Straßen sicher, aber selbst sie kann nicht überall sein.',
      'Le Cinderguard veille sur les routes, mais même lui ne peut pas être partout.',
      'Cinderguardが道を守ってくれているけれど、彼らでもすべてには目が届かないわ。',
    ),
  }),
  u('dlg.mira.craft', 'Dialogue', 'Mira.Craft', "Bring me {Count} Ember Shards and I'll see what I can craft.", DIALOGUE_ORIGIN('Mira', 'Craft'), 'Dialogue/Mira', {
    kind: 'text',
    devNotes: MIRA_NOTE,
    localized: all(
      'Bring mir {Count} Glutsplitter, dann schaue ich, was sich daraus machen lässt.',
      'Apporte-moi {Count} éclats de braise et je verrai ce que je peux fabriquer.',
      '残り火の欠片を{Count}個持ってきて。何が作れるか見てみるわ。',
    ),
  }),
  u('dlg.mira.farewell', 'Dialogue', 'Mira.Farewell', 'Safe travels, {PlayerName}. The Waystone will take you as far as Emberfall Watch.', DIALOGUE_ORIGIN('Mira', 'Farewell'), 'Dialogue/Mira', {
    kind: 'text',
    devNotes: MIRA_NOTE,
    localized: all(
      'Gute Reise, {PlayerName}. Der Wegstein bringt dich bis nach Emberfall Watch.',
      'Bon voyage, {PlayerName}. La pierre de voyage te mènera jusqu\'à Emberfall Watch.',
      '道中気をつけて、{PlayerName}。道標の石を使えば、Emberfall Watchまで行けるわ。',
    ),
  }),
  // Old Bram — blacksmith (6 translated)
  u('dlg.bram.whetstone', 'Dialogue', 'Bram.Whetstone', "This blade won't sharpen itself. Bring me a Whetstone.", DIALOGUE_ORIGIN('Bram', 'Whetstone'), 'Dialogue/Bram', {
    kind: 'text', devNotes: BRAM_NOTE, localized: all('Diese Klinge schärft sich nicht von selbst. Bring mir einen Wetzstein.', "Cette lame ne s'aiguisera pas toute seule. Apporte-moi une pierre à aiguiser.", 'この刃は勝手には研げん。砥石を持ってきてくれ。'),
  }),
  u('dlg.bram.blight', 'Dialogue', 'Bram.Blight', "The Blight's been eating at my supply lines for months.", DIALOGUE_ORIGIN('Bram', 'Blight'), 'Dialogue/Bram', {
    kind: 'text', devNotes: BRAM_NOTE, localized: all('Die Fäulnis frisst sich schon seit Monaten durch meine Versorgungswege.', 'Le Fléau ronge mes lignes d\'approvisionnement depuis des mois.', '腐敗はもう何か月も俺の補給路を蝕んでいる。'),
  }),
  u('dlg.bram.ironOre', 'Dialogue', 'Bram.IronOre', "Iron Ore's gotten scarce. Copper will have to do for now.", DIALOGUE_ORIGIN('Bram', 'IronOre'), 'Dialogue/Bram', {
    kind: 'text', devNotes: BRAM_NOTE, localized: all('Eisenerz ist knapp geworden. Kupfer muss vorerst reichen.', 'Le minerai de fer se fait rare. Le cuivre devra suffire pour l\'instant.', '鉄鉱石が乏しくなってきた。当面は銅で我慢するしかないな。'),
  }),
  u('dlg.bram.bow', 'Dialogue', 'Bram.Bow', 'A good Hunting Bow is worth more than gold out here.', DIALOGUE_ORIGIN('Bram', 'Bow'), 'Dialogue/Bram', {
    kind: 'text', devNotes: BRAM_NOTE, localized: all('Ein guter Jagdbogen ist hier draußen mehr wert als Gold.', "Un bon arc de chasse vaut plus que de l'or, par ici.", 'ここらじゃ、いい狩猟弓は金より価値があるんだ。'),
  }),
  u('dlg.bram.armor', 'Dialogue', 'Bram.Armor', "Tell the Cinderguard their armor order will be ready by week's end.", DIALOGUE_ORIGIN('Bram', 'Armor'), 'Dialogue/Bram', {
    kind: 'text', devNotes: BRAM_NOTE, localized: all("Sag der Cinderguard, ihre Rüstungsbestellung ist bis Ende der Woche fertig.", "Dis au Cinderguard que sa commande d'armures sera prête d'ici la fin de la semaine.", 'Cinderguardに伝えてくれ、防具の注文は週末までに仕上がると。'),
  }),
  u('dlg.bram.hook', 'Dialogue', 'Bram.Hook', "Careful with that Grappling Hook — the rope frays faster than it should.", DIALOGUE_ORIGIN('Bram', 'Hook'), 'Dialogue/Bram', {
    kind: 'text', devNotes: BRAM_NOTE, localized: all('Vorsicht mit dem Enterhaken – das Seil franst schneller aus, als es sollte.', "Fais attention avec ce grappin – la corde s'effiloche plus vite qu'elle ne le devrait.", 'そのグラップリングフックには気をつけろ――ロープが妙に早くほつれるんだ。'),
  }),
  // Captain Renn — Cinderguard captain (6 translated)
  u('dlg.renn.blightSpread', 'Dialogue', 'Renn.BlightSpread', 'Cinderguard patrols report the Blight spreading past the old boundary stones.', DIALOGUE_ORIGIN('Renn', 'BlightSpread'), 'Dialogue/Renn', {
    kind: 'text', devNotes: RENN_NOTE, localized: all('Cinderguard-Patrouillen melden, dass sich die Fäulnis über die alten Grenzsteine hinaus ausbreitet.', 'Les patrouilles du Cinderguard signalent que le Fléau se propage au-delà des anciennes bornes.', 'Cinderguardの巡回によれば、腐敗は古い境界石を越えて広がっているという。'),
  }),
  u('dlg.renn.waystoneLost', 'Dialogue', 'Renn.WaystoneLost', 'We lost another Waystone to storm damage last week.', DIALOGUE_ORIGIN('Renn', 'WaystoneLost'), 'Dialogue/Renn', {
    kind: 'text', devNotes: RENN_NOTE, localized: all('Wir haben letzte Woche einen weiteren Wegstein durch Sturmschäden verloren.', 'Nous avons perdu une autre pierre de voyage à cause d\'une tempête la semaine dernière.', '先週も嵐でまた一つ道標の石を失った。'),
  }),
  u('dlg.renn.recruit', 'Dialogue', 'Renn.Recruit', "Any Ranger who signs on gets a Ranger's Cloak and a place at Emberfall Watch.", DIALOGUE_ORIGIN('Renn', 'Recruit'), 'Dialogue/Renn', {
    kind: 'text', devNotes: RENN_NOTE, localized: all("Jeder Waldläufer, der sich meldet, bekommt einen Waldläufermantel und einen Platz in Emberfall Watch.", "Tout rôdeur qui s'engage reçoit une cape de rôdeur et une place à Emberfall Watch.", '入隊するレンジャーには、レンジャーのマントとEmberfall Watchでの居場所が与えられる。'),
  }),
  u('dlg.renn.bountyBoard', 'Dialogue', 'Renn.BountyBoard', 'Bounty Board postings go up every three days, sharp.', DIALOGUE_ORIGIN('Renn', 'BountyBoard'), 'Dialogue/Renn', {
    kind: 'text', devNotes: RENN_NOTE, localized: all('Die Aushänge am Kopfgeldbrett werden alle drei Tage pünktlich erneuert.', 'Les annonces du tableau des primes sont renouvelées tous les trois jours, sans faute.', '賞金首の掲示板の張り紙は、三日ごとにきっちり貼り替えられる。'),
  }),
  u('dlg.renn.thornreachStands', 'Dialogue', 'Renn.ThornreachStands', 'Thornreach stands because the Cinderguard never sleeps.', DIALOGUE_ORIGIN('Renn', 'ThornreachStands'), 'Dialogue/Renn', {
    kind: 'text', devNotes: RENN_NOTE, localized: all('Thornreach hält stand, weil die Cinderguard niemals schläft.', 'Thornreach tient bon parce que le Cinderguard ne dort jamais.', 'Cinderguardが決して眠らないからこそ、Thornreachは立っていられる。'),
  }),
  u('dlg.renn.wardingCharm', 'Dialogue', 'Renn.WardingCharm', 'Keep your Warding Charm close past the tree line.', DIALOGUE_ORIGIN('Renn', 'WardingCharm'), 'Dialogue/Renn', {
    kind: 'text', devNotes: RENN_NOTE, localized: all('Behalte dein Schutzamulett jenseits der Baumgrenze griffbereit.', 'Garde ton charme de protection à portée de main au-delà de la lisière.', '木々の境界を越えたら、魔除けの護符を手放すな。'),
  }),
  // Sella the Trader — merchant (6 translated)
  u('dlg.sella.smokehouse', 'Dialogue', 'Sella.Smokehouse', 'Fresh Dried Meat and Berry Preserve, straight from the smokehouse.', DIALOGUE_ORIGIN('Sella', 'Smokehouse'), 'Dialogue/Sella', {
    kind: 'text', devNotes: SELLA_NOTE, localized: all('Frisches Trockenfleisch und Beerenkonfitüre, direkt aus dem Räucherhaus.', 'Viande séchée fraîche et confiture de baies, tout droit sorties du fumoir.', 'できたての干し肉とベリージャム、燻製小屋から直送だよ。'),
  }),
  u('dlg.sella.oldRoads', 'Dialogue', 'Sella.OldRoads', "The old roads aren't as safe as they used to be.", DIALOGUE_ORIGIN('Sella', 'OldRoads'), 'Dialogue/Sella', {
    kind: 'text',
    devNotes: SELLA_NOTE,
    localized: {
      de: { text: 'Die alten Straßen sind nicht mehr so sicher wie früher.' },
      fr: { text: 'Les vieilles routes ne sont plus aussi sûres qu\'avant.', ambiguity: 'guessed', question: "Does 'the old roads' refer to a specific named trade route, or just aging roads in general?" },
      ja: { text: '古い街道はかつてほど安全じゃなくなったね。' },
    },
  }),
  u('dlg.sella.rustyKey', 'Dialogue', 'Sella.RustyKey', "I'll trade you a Waterskin and a Torch for that Rusty Key.", DIALOGUE_ORIGIN('Sella', 'RustyKey'), 'Dialogue/Sella', {
    kind: 'text', devNotes: SELLA_NOTE, localized: all('Ich gebe dir einen Wasserschlauch und eine Fackel für den rostigen Schlüssel da.', 'Je t\'échange une gourde et une torche contre cette clé rouillée.', 'その錆びた鍵をくれたら、水筒と松明をあげるよ。'),
  }),
  u('dlg.sella.emberShards', 'Dialogue', 'Sella.EmberShards', 'Ember Shards fetch a good price this season.', DIALOGUE_ORIGIN('Sella', 'EmberShards'), 'Dialogue/Sella', {
    kind: 'text', devNotes: SELLA_NOTE, localized: all('Glutsplitter bringen diese Saison einen guten Preis.', 'Les éclats de braise se vendent bien cette saison.', '残り火の欠片は今シーズン、いい値がつくよ。'),
  }),
  u('dlg.sella.backpack', 'Dialogue', 'Sella.Backpack', 'A Reinforced Backpack will save your back on the long hauls.', DIALOGUE_ORIGIN('Sella', 'Backpack'), 'Dialogue/Sella', {
    kind: 'text', devNotes: SELLA_NOTE, localized: all('Ein verstärkter Rucksack schont deinen Rücken auf den langen Wegen.', 'Un sac à dos renforcé t\'épargnera le dos sur les longs trajets.', '補強リュックがあれば、長旅でも背中が楽になるよ。'),
  }),
  u('dlg.sella.flare', 'Dialogue', 'Sella.Flare', "Careful — that Signal Flare is louder than it looks.", DIALOGUE_ORIGIN('Sella', 'Flare'), 'Dialogue/Sella', {
    kind: 'text', devNotes: SELLA_NOTE, localized: all('Vorsicht – diese Signalfackel ist lauter, als sie aussieht.', "Attention – cette fusée de détresse est plus bruyante qu'elle n'en a l'air.", '気をつけて――その信号弾は見た目より大きな音がするよ。'),
  }),

  // Filler dialogue (untranslated) — 35 units
  ...['The grove\'s been quiet lately. Too quiet.', 'I still remember when the road to the coast was safe.', 'Take care on the north trail — I mean it.'].map((s, i) =>
    u(`dlg.mira.filler.${i}`, 'Dialogue', `Mira.Filler.${i}`, s, DIALOGUE_ORIGIN('Mira', `Idle_${rowNumber(i)}`), 'Dialogue/Mira', { kind: 'text' }),
  ),
  ...['Mind the sparks, this forge bites.', "Every nail's got a story if you ask me.", 'Steel remembers the hammer that shaped it.'].map((s, i) =>
    u(`dlg.bram.filler.${i}`, 'Dialogue', `Bram.Filler.${i}`, s, DIALOGUE_ORIGIN('Bram', `Idle_${rowNumber(i)}`), 'Dialogue/Bram', { kind: 'text' }),
  ),
  ...['Discipline keeps you alive out here more than steel does.', "We don't leave anyone behind. Not on my watch.", 'Report anything strange. Anything.'].map((s, i) =>
    u(`dlg.renn.filler.${i}`, 'Dialogue', `Renn.Filler.${i}`, s, DIALOGUE_ORIGIN('Renn', `Idle_${rowNumber(i)}`), 'Dialogue/Renn', { kind: 'text' }),
  ),
  ...["Coin's coin, but I'll trade for good stories too.", "Careful, that one's fragile.", "Come back when you've got more to sell."].map((s, i) =>
    u(`dlg.sella.filler.${i}`, 'Dialogue', `Sella.Filler.${i}`, s, DIALOGUE_ORIGIN('Sella', `Idle_${rowNumber(i)}`), 'Dialogue/Sella', { kind: 'text' }),
  ),
  ...[
    'Halt. State your business.', 'Move along, nothing to see here.', 'Watch yourself past the gate after dark.', "Papers, if you've got any.",
    "The road's clear as of this morning.", 'Careful out there today.', 'Another one heading out? Good luck.', "We've had no trouble at the gate all week.",
    'Keep your weapon sheathed inside the walls.', "Welcome back — you look like you've had a rough trip.",
  ].map((s, i) => u(`dlg.guard.${i}`, 'Dialogue', `GateGuard.${i}`, s, DIALOGUE_ORIGIN('GateGuard', `Bark_${rowNumber(i)}`), 'Dialogue/GateGuard', { kind: 'text' })),
  ...[
    'The road provides, if you let it.', "I've walked farther than I can remember.", 'Kindness is rarer than coin these days.', 'Every ember fades, but the warmth lingers.',
    'I seek nothing but the next horizon.', 'Even the Blight cannot touch a settled heart.', 'Rest here a while, traveler.', 'The old paths remember every footstep.',
    'I carry no coin, only stories.', 'May your fire never go out.',
  ].map((s, i) => u(`dlg.pilgrim.${i}`, 'Dialogue', `Pilgrim.${i}`, s, DIALOGUE_ORIGIN('Pilgrim', `Bark_${rowNumber(i)}`), 'Dialogue/Pilgrim', { kind: 'text' })),
  ...['The winds are picking up — best find shelter.', 'A merchant caravan passed through at dawn.', 'Something is stirring in the old grove tonight.'].map((s, i) =>
    u(`dlg.ambient.${i}`, 'Dialogue', `Ambient.${i}`, s, DIALOGUE_ORIGIN('Ambient', `Bark_${rowNumber(i)}`), 'Dialogue/Ambient', { kind: 'text' }),
  ),
];

// ---------------------------------------------------------------------------------------------------
// Quests namespace — 60 units (15 translated: 5 quests × title/objective/description)
// ---------------------------------------------------------------------------------------------------

const QUEST_ORIGIN = (row: string, property: string) => `/Game/MyGame/Quests/DT_Quests.DT_Quests.${row}.${property}`;

interface QuestDef {
  slug: string;
  key: string;
  title: string;
  objective: string;
  description: string;
  titleL?: Partial<Record<Culture, Localized>>;
  objectiveL?: Partial<Record<Culture, Localized>>;
  descriptionL?: Partial<Record<Culture, Localized>>;
}

const translatedQuests: QuestDef[] = [
  {
    slug: 'embersInTheDark', key: 'EmbersInTheDark',
    title: 'Embers in the Dark',
    objective: 'Relight the three watch-beacons between Thornreach and Emberfall Watch before nightfall.',
    description: 'The beacon path has gone dark. Old Bram says the Blight is spreading faster after dusk — light the beacons before the Cinderguard patrol turns back.',
    titleL: all('Glut in der Dunkelheit', "Braises dans l'obscurité", '闇の中の残り火'),
    objectiveL: all(
      'Entzünde die drei Wachfeuer zwischen Thornreach und Emberfall Watch, bevor die Nacht hereinbricht.',
      'Rallume les trois feux de guet entre Thornreach et Emberfall Watch avant la tombée de la nuit.',
      '夜が訪れる前に、ThornreachとEmberfall Watchの間にある三つの見張り火を再び灯せ。',
    ),
    descriptionL: all(
      'Die Wachfeuer entlang des Pfads sind erloschen. Der alte Bram sagt, die Fäulnis breite sich nach Einbruch der Dunkelheit schneller aus – entzünde sie wieder, bevor die Cinderguard-Patrouille umkehrt.',
      "Les feux du chemin se sont éteints. Le vieux Bram affirme que le Fléau se propage plus vite après le crépuscule – rallume-les avant que la patrouille du Cinderguard ne rebrousse chemin.",
      '道沿いの見張り火が消えてしまった。ブラム爺さんによれば、日暮れ後は腐敗の広がりが速まるという――Cinderguardの巡回が引き返す前に、火を灯せ。',
    ),
  },
  {
    // Deliberate flaw G: DE objective uses the wrong glossary term ("Waldwächter" instead of "Hüter des Hains"),
    // inconsistent with this same quest's own title/description.
    slug: 'grovekeepersRequest', key: 'GrovekeepersRequest',
    title: "The Grovekeeper's Request",
    objective: 'Gather 5 Healing Herbs and 3 Frostcap Mushrooms for the Grovekeeper.',
    description: 'The Grovekeeper is running low on remedies for the sick at Thornreach. Bring what the grove will still give.',
    titleL: all('Die Bitte des Hüters des Hains', 'La requête du gardien du bosquet', '森の番人の頼み'),
    objectiveL: {
      de: {
        text: 'Sammle 5 Heilkräuter und 3 Frostkappenpilze für den Waldwächter.',
        judge: {
          severity: 'minor', category: 'terminology',
          why: '"Waldwächter" is inconsistent with the glossary term "Hüter des Hains" used in this quest\'s own title and description.',
          fix: 'Sammle 5 Heilkräuter und 3 Frostkappenpilze für den Hüter des Hains.',
        },
      },
      fr: { text: 'Récolte 5 herbes curatives et 3 champignons givrés pour le gardien du bosquet.' },
      ja: { text: '森の番人のために、癒しの薬草を5つ、霜傘キノコを3つ集めよ。' },
    },
    descriptionL: all(
      'Dem Hüter des Hains gehen die Heilmittel für die Kranken in Thornreach aus. Bring, was der Hain noch hergibt.',
      "Le gardien du bosquet n'a presque plus de remèdes pour les malades de Thornreach. Rapporte ce que le bosquet veut bien encore donner.",
      '森の番人のもとで、Thornreachの病人に使う薬が底を尽きかけている。森がまだ恵んでくれるものを持ち帰れ。',
    ),
  },
  {
    slug: 'bountyDuskhornStag', key: 'BountyDuskhornStag',
    title: 'Bounty: Duskhorn Stag',
    objective: 'Hunt the Duskhorn Stag stalking the northern trail and claim the bounty.',
    description: 'A Duskhorn Stag has been driving travelers off the northern trail. The Bounty Board is offering {Reward} coin for its hide.',
    titleL: {
      de: { text: 'Kopfgeld: Dämmerhirsch' },
      fr: { text: 'Prime\u00a0: Cerf du crépuscule' },
      ja: { text: '賞金首：黄昏の角鹿', ambiguity: 'guessed', question: "Is 'Duskhorn' part of the creature's proper species name, or just a descriptor (dusk-colored horns)?" },
    },
    objectiveL: all(
      'Jage den Dämmerhirsch, der den nördlichen Pfad heimsucht, und hol dir das Kopfgeld.',
      'Chasse le cerf du crépuscule qui hante le sentier du nord et récupère la prime.',
      '北の小道に居座る黄昏の角鹿を狩り、賞金を受け取れ。',
    ),
    descriptionL: all(
      'Ein Dämmerhirsch vertreibt Reisende vom nördlichen Pfad. Das Kopfgeldbrett bietet {Reward} Münzen für sein Fell.',
      'Un cerf du crépuscule chasse les voyageurs du sentier du nord. Le tableau des primes offre {Reward} pièces pour sa peau.',
      '黄昏の角鹿が北の小道から旅人を追い払っている。賞金首の掲示板では、その毛皮に{Reward}枚のコインが懸けられている。',
    ),
  },
  {
    slug: 'waystoneRepairs', key: 'WaystoneRepairs',
    title: 'Waystone Repairs',
    objective: 'Repair the broken Waystone west of Thornreach with {Count} Ember Shards.',
    description: 'Waystones let travelers jump between Thornreach and the frontier instantly. This one took storm damage and needs Ember Shards to relight its core.',
    titleL: all('Reparatur des Wegsteins', 'Réparation de la pierre de voyage', '道標の石の修復'),
    objectiveL: all(
      'Repariere den beschädigten Wegstein westlich von Thornreach mit {Count} Glutsplittern.',
      'Répare la pierre de voyage brisée à l\'ouest de Thornreach avec {Count} éclats de braise.',
      'Thornreachの西にある壊れた道標の石を、残り火の欠片{Count}個で修復せよ。',
    ),
    descriptionL: all(
      'Über Wegsteine gelangen Reisende im Nu zwischen Thornreach und dem Grenzland hin und her. Dieser hier hat Sturmschäden erlitten und braucht Glutsplitter, um seinen Kern neu zu entzünden.',
      'Les pierres de voyage permettent aux voyageurs de se déplacer instantanément entre Thornreach et les terres frontalières. Celle-ci a été endommagée par une tempête et a besoin d\'éclats de braise pour rallumer son cœur.',
      '道標の石は、旅人をThornreachと辺境の間で瞬時に移動させてくれる。この石は嵐で損傷しており、核を再び灯すには残り火の欠片が必要だ。',
    ),
  },
  {
    // Deliberate flaw C: JA title drops the DNT term "Emberfall Watch" (translates it instead of keeping it verbatim).
    slug: 'whispersAtEmberfallWatch', key: 'WhispersAtEmberfallWatch',
    title: 'Whispers at Emberfall Watch',
    objective: 'Investigate the strange lights reported at Emberfall Watch.',
    description: 'Cinderguard scouts report lights moving inside Emberfall Watch at night, though the watch has stood empty for years.',
    titleL: {
      de: { text: 'Geflüster in Emberfall Watch' },
      fr: { text: 'Murmures à Emberfall Watch' },
      ja: { text: '灰燼監視所の囁き', hard: true },
    },
    objectiveL: all(
      'Untersuche die seltsamen Lichter, die bei Emberfall Watch gemeldet wurden.',
      'Enquête sur les lumières étranges signalées à Emberfall Watch.',
      'Emberfall Watchで報告された奇妙な光を調査せよ。',
    ),
    descriptionL: all(
      'Cinderguard-Kundschafter melden, dass sich nachts Lichter in Emberfall Watch bewegen, obwohl der Wachturm seit Jahren leer steht.',
      "Les éclaireurs du Cinderguard signalent des lumières se déplaçant à l'intérieur d'Emberfall Watch la nuit, alors que le fort est abandonné depuis des années.",
      'Cinderguardの斥候によれば、何年も無人だったはずのEmberfall Watchの中で、夜な夜な光が動いているという。',
    ),
  },
];

const fillerQuests: { key: string; title: string; objective: string; description: string }[] = [
  { key: 'OldBramsDebt', title: "Old Bram's Debt", objective: 'Recover the tools Old Bram lent to a trader who never came back.', description: 'Old Bram is missing three sets of tools and the trader who borrowed them. Find out what happened on the east road.' },
  { key: 'SignalFires', title: 'Signal Fires', objective: 'Light three signal flares along the ridge to call the Cinderguard patrol.', description: 'A patrol has gone quiet. Light the ridge flares to bring help before dark.' },
  { key: 'TheMissingShipment', title: 'The Missing Shipment', objective: 'Track down the supply wagon that never reached Thornreach.', description: "A wagon of rations left the coast three days ago and hasn't arrived. Find the wagon, or what's left of it." },
  { key: 'RootsOfTheBlight', title: 'Roots of the Blight', objective: "Collect samples from the Blight's spreading edge for the Grovekeeper.", description: 'The Grovekeeper wants fresh samples to understand why the Blight is spreading faster this year.' },
  { key: 'CinderguardRecruitment', title: 'Cinderguard Recruitment', objective: 'Prove yourself to Captain Renn to join the Cinderguard.', description: 'Captain Renn is looking for recruits. Complete three tasks to earn a place in the ranks.' },
  { key: 'TrailOfAsh', title: 'Trail of Ash', objective: 'Follow the ash trail from the burned campsite to its source.', description: "A cold campsite, burned gear, and a trail of ash leading north. Someone left in a hurry." },
  { key: 'AColdTrade', title: 'A Cold Trade', objective: 'Deliver preserved rations to the outpost before the first snow.', description: 'The northern outpost is low on food with winter closing in. Get the rations there in time.' },
  { key: 'TheHollowPath', title: 'The Hollow Path', objective: 'Find a way through the Hollow Path to the far ridge.', description: "Old maps mark a shortcut called the Hollow Path. Nobody's used it in years — there might be a reason." },
  { key: 'SongsOfTheGrove', title: 'Songs of the Grove', objective: "Record the Grovekeeper's chants before the old grove is lost.", description: "The grove is shrinking. The Grovekeeper wants the old chants written down before they're forgotten." },
  { key: 'BountyIronbackBoar', title: 'Bounty: Ironback Boar', objective: 'Hunt the Ironback Boar terrorizing the eastern farms.', description: 'An Ironback Boar has trampled two fences already. The farmers are offering a bounty for its tusks.' },
  { key: 'TheLastRation', title: 'The Last Ration', objective: 'Decide how to split the last of the food stores.', description: 'Supplies are critically low. Whatever you decide, someone will go hungry tonight.' },
  { key: 'AshwoodContract', title: 'Ashwood Contract', objective: 'Deliver ten Ashwood Planks to the carpenter at Thornreach.', description: 'The carpenter needs Ashwood Planks for a rush job. Payment is good if you are quick.' },
  { key: 'BeneathTheWatch', title: 'Beneath the Watch', objective: 'Explore the tunnels beneath Emberfall Watch.', description: "Old maps show tunnels under the watch that aren't on any modern survey." },
  { key: 'TheLanternKeeper', title: 'The Lantern Keeper', objective: 'Relight the lanterns along the river path.', description: 'The river path lanterns have gone dark one by one. Find out why, and relight them.' },
  { key: 'Homecoming', title: 'Homecoming', objective: 'Escort a returning Cinderguard veteran back to Thornreach.', description: "A veteran ranger is finally coming home after years away. The road isn't as safe as it used to be." },
];

const questUnits: UnitDef[] = [
  ...translatedQuests.flatMap((q) => [
    u(`quest.${q.slug}.title`, 'Quests', `${q.key}.Title`, q.title, QUEST_ORIGIN(q.key, 'Title'), `Quests/${q.key}`, {
      kind: 'text', devNotes: `Quest log header for "${q.title}". Objective is the HUD tracker line, description is the log body.`, localized: q.titleL,
    }),
    u(`quest.${q.slug}.objective`, 'Quests', `${q.key}.Objective`, q.objective, QUEST_ORIGIN(q.key, 'Objective'), `Quests/${q.key}`, {
      kind: 'text', devNotes: `HUD tracker line for quest "${q.title}". Stays on screen while the quest is active; keep it to one line.`, localized: q.objectiveL,
    }),
    u(`quest.${q.slug}.description`, 'Quests', `${q.key}.Description`, q.description, QUEST_ORIGIN(q.key, 'Description'), `Quests/${q.key}`, {
      kind: 'text', devNotes: `Quest log body text for "${q.title}".`, localized: q.descriptionL,
    }),
  ]),
  ...fillerQuests.flatMap((q) => [
    u(`quest.filler.${q.key}.title`, 'Quests', `${q.key}.Title`, q.title, QUEST_ORIGIN(q.key, 'Title'), `Quests/${q.key}`, { kind: 'text' }),
    u(`quest.filler.${q.key}.objective`, 'Quests', `${q.key}.Objective`, q.objective, QUEST_ORIGIN(q.key, 'Objective'), `Quests/${q.key}`, { kind: 'text' }),
    u(`quest.filler.${q.key}.description`, 'Quests', `${q.key}.Description`, q.description, QUEST_ORIGIN(q.key, 'Description'), `Quests/${q.key}`, { kind: 'text' }),
  ]),
];

// ---------------------------------------------------------------------------------------------------
// Tutorial namespace — 20 units (10 translated). Origins are LOCTEXT lines in a C++ hint table (file:line).
// JA hint voice is polite (です/ます), like the other system text.
// ---------------------------------------------------------------------------------------------------

let tutorialLine = 10;
const TUTORIAL_ORIGIN = () => `Source/MyGame/Private/Tutorial/TutorialHints.cpp(${(tutorialLine += 4)})`;

const tutorialUnits: UnitDef[] = [
  u('tut.sprint', 'Tutorial', 'Hints.Sprint', 'Hold {Key} to sprint.', TUTORIAL_ORIGIN(), 'Tutorial', {
    kind: 'text',
    devNotes: 'On-screen hint the first time the player holds sprint; {Key} is the bound key glyph.',
    localized: all('Halte {Key} gedrückt, um zu sprinten.', 'Maintiens {Key} pour sprinter.', '{Key}を押し続けるとダッシュします。'),
  }),
  u('tut.openInventory', 'Tutorial', 'Hints.OpenInventory', 'Press {Key} to open your inventory.', TUTORIAL_ORIGIN(), 'Tutorial', {
    kind: 'text',
    devNotes: 'On-screen hint the first time the inventory is available; {Key} is the bound key glyph.',
    localized: all('Drücke {Key}, um dein Inventar zu öffnen.', 'Appuie sur {Key} pour ouvrir ton inventaire.', '{Key}を押すと持ち物が開きます。'),
  }),
  u('tut.waystone', 'Tutorial', 'Hints.Waystone', 'Approach a Waystone and press {Key} to fast travel.', TUTORIAL_ORIGIN(), 'Tutorial', {
    kind: 'text',
    devNotes: 'On-screen hint near a Waystone; {Key} is the bound key glyph.',
    localized: all('Nähere dich einem Wegstein und drücke {Key} für die Schnellreise.', 'Approche-toi d\'une pierre de voyage et appuie sur {Key} pour utiliser le voyage rapide.', '道標の石に近づいて{Key}を押すと、ファストトラベルできます。'),
  }),
  u('tut.cinderguardTrade', 'Tutorial', 'Hints.CinderguardTrade', 'Rangers of the Cinderguard will trade supplies for Ember Shards.', TUTORIAL_ORIGIN(), 'Tutorial', {
    kind: 'text',
    devNotes: 'On-screen hint near a Cinderguard ranger who trades Ember Shards.',
    localized: {
      de: {
        text: 'Waldläufer der Cinderguard tauschen Vorräte gegen Glutsteine.',
        judge: {
          severity: 'major', category: 'terminology',
          why: 'Uses "Glutsteine" for the crafting resource; the established glossary term is "Glutsplitter".',
          fix: 'Waldläufer der Cinderguard tauschen Vorräte gegen Glutsplitter.',
        },
      },
      fr: { text: 'Les rôdeurs du Cinderguard échangent des provisions contre des éclats de braise.' },
      ja: { text: 'Cinderguardのレンジャーは、残り火の欠片と物資を交換してくれます。' },
    },
  }),
  // UE plural forms are FTextFormat patterns with no ICU "#": the count is printed by a separate {Count}, and the
  // modifier only picks the noun. JA cardinal has a single plural form ("other"), so the engine rejects the
  // modifier there (FTextFormatArgumentModifier_PluralForm::Validate) and the argument is written plainly.
  u('tut.pickedUp', 'Tutorial', 'Hints.PickedUp', 'You picked up {Count} {Count}|plural(one=Ember Shard,other=Ember Shards).', TUTORIAL_ORIGIN(), 'Tutorial', {
    kind: 'text',
    devNotes: 'On-screen hint the first time the player picks up Ember Shards; {Count} is the amount picked up.',
    localized: all(
      'Du hast {Count} {Count}|plural(one=Glutsplitter,other=Glutsplitter) aufgesammelt.',
      'Tu as récupéré {Count} {Count}|plural(one=éclat de braise,many=éclats de braise,other=éclats de braise).',
      '残り火の欠片を{Count}個手に入れました。',
    ),
  }),
  u('tut.grovekeeperIdentify', 'Tutorial', 'Hints.GrovekeeperIdentify', 'Grovekeepers can identify rare herbs for you.', TUTORIAL_ORIGIN(), 'Tutorial', {
    kind: 'text',
    devNotes: 'On-screen hint near a Grovekeeper NPC.',
    localized: all('Hüter des Hains können seltene Kräuter für dich bestimmen.', 'Les gardiens du bosquet peuvent identifier les herbes rares pour toi.', '森の番人なら、珍しい薬草を鑑定してくれます。'),
  }),
  u('tut.repair', 'Tutorial', 'Hints.Repair', 'Repair worn equipment at a blacksmith before it breaks.', TUTORIAL_ORIGIN(), 'Tutorial', {
    kind: 'text',
    devNotes: 'On-screen hint near a blacksmith with worn equipment.',
    localized: all('Repariere abgenutzte Ausrüstung beim Schmied, bevor sie zerbricht.', "Répare ton équipement usé chez un forgeron avant qu'il ne casse.", '装備が壊れる前に、鍛冶屋で修理しておきましょう。'),
  }),
  u('tut.questLog', 'Tutorial', 'Hints.QuestLog', 'Press <Key>Tab</> to open the quest log.', TUTORIAL_ORIGIN(), 'Tutorial', {
    kind: 'text',
    devNotes: 'On-screen hint the first time a quest is tracked; <Key>Tab</> is a styled key-glyph tag and must stay intact.',
    localized: all('Drücke <Key>Tab</>, um das Questprotokoll zu öffnen.', 'Appuie sur <Key>Tab</> pour ouvrir le journal de quêtes.', '<Key>Tab</>を押すとクエストログが開きます。'),
  }),
  u('tut.blightNight', 'Tutorial', 'Hints.BlightNight', 'The Blight spreads faster after dark near Thornreach.', TUTORIAL_ORIGIN(), 'Tutorial', {
    kind: 'text',
    devNotes: 'On-screen hint when the player enters a Blight zone after dark.',
    localized: all('Die Fäulnis breitet sich in der Nähe von Thornreach nach Einbruch der Dunkelheit schneller aus.', 'Le Fléau se propage plus vite après la tombée de la nuit près de Thornreach.', 'Thornreach周辺では、日が暮れると腐敗の広がりが速くなります。'),
  }),
  u('tut.bountiesReset', 'Tutorial', 'Hints.BountiesReset', 'Bounties reset every three days.', TUTORIAL_ORIGIN(), 'Tutorial', {
    kind: 'text',
    devNotes: 'On-screen hint near the Bounty Board.',
    localized: all('Kopfgelder werden alle drei Tage erneuert.', 'Les primes se renouvellent tous les trois jours.', '賞金首の依頼は三日ごとに更新されます。'),
  }),
  // Filler (untranslated) — 10 units
  ...[
    'Craft basic tools at a campfire.',
    'Check the bounty board at Emberfall Watch for available contracts.',
    'Your hunger and thirst drain over time — keep rations and water on hand.',
    'Equip a torch to see in dark caves.',
    'Use {Key} to block incoming attacks.',
    'Sprinting drains stamina faster in heavy armor.',
    'Some creatures only appear at night near Thornreach.',
    'Save your game at a campfire.',
    'You can mark a location on your map.',
    'Fishing rods work best near calm water.',
  ].map((s, i) => u(`tut.filler.${i}`, 'Tutorial', `Hints.Filler.${i}`, s, TUTORIAL_ORIGIN(), 'Tutorial', { kind: 'text' })),
];

// ---------------------------------------------------------------------------------------------------
// All units, lookups
// ---------------------------------------------------------------------------------------------------

const ALL_UNITS: UnitDef[] = [...uiUnits, ...itemUnits, ...dialogueUnits, ...questUnits, ...tutorialUnits];

function toSnapshotEntry(unit: UnitDef): SnapshotEntry {
  return {
    namespace: unit.namespace,
    key: unit.key,
    source: unit.source,
    origin: unit.origin,
    devNotes: unit.devNotes ?? '',
    metadata: unit.kind ? { [KIND_METADATA_KEY]: unit.kind } : {},
    groupKey: unit.groupKey,
  };
}

const unitIdBySlug = new Map<string, string>(ALL_UNITS.map((unit) => [unit.slug, unitIdOf(unit.namespace, unit.key)]));

function idOf(slug: string): string {
  const id = unitIdBySlug.get(slug);
  if (!id) throw new Error(`Unknown demo unit slug: ${slug}`);
  return id;
}

// unitId -> per-culture translation, for every unit that carries `localized`.
const TRANSLATIONS = new Map<string, Partial<Record<Culture, Localized>>>();
for (const unit of ALL_UNITS) if (unit.localized) TRANSLATIONS.set(unitIdOf(unit.namespace, unit.key), unit.localized);
const TRANSLATED_IDS = [...TRANSLATIONS.keys()];

// ---------------------------------------------------------------------------------------------------
// DemoLlmClient — a fixed dictionary of hand-written translations and judge verdicts. Never calls the
// network: every answer is read out of the tables built above. `culture` is set by the caller before
// each per-culture runTranslateJob call.
// ---------------------------------------------------------------------------------------------------

class DemoLlmClient implements LlmClient {
  culture: Culture = 'de';

  async runSync(requests: LlmRequest[], _concurrency: number, onOutcome?: (outcome: LlmOutcome) => void): Promise<LlmOutcome[]> {
    return requests.map((request) => {
      const outcome = this.respond(request);
      onOutcome?.(outcome);
      return outcome;
    });
  }

  async runBatch(requests: LlmRequest[]): Promise<LlmOutcome[]> {
    return this.runSync(requests, 1);
  }

  async countInputTokens(): Promise<number> {
    return 0;
  }

  private respond(request: LlmRequest): LlmOutcome {
    const isJudge = JSON.stringify(request.params.output_config).includes('"issues"');
    const body = JSON.parse(request.params.messages[0]!.content as string) as { items: Record<string, unknown>[] };
    if (isJudge) {
      const issues: Record<string, unknown>[] = [];
      for (const item of body.items) {
        const id = item.id as string;
        const issue = TRANSLATIONS.get(id)?.[this.culture]?.judge;
        if (issue) issues.push({ id, ...issue });
      }
      return ok(request.customId, { issues });
    }
    const items = body.items.map((item) => {
      const id = item.id as string;
      const spec = TRANSLATIONS.get(id)?.[this.culture];
      if (!spec) throw new Error(`demo_project: no ${this.culture} translation defined for unit ${id}`);
      return { id, translation: spec.text, ambiguity: spec.ambiguity ?? 'none', alts: [], question: spec.question ?? '', terms_used: [] };
    });
    return ok(request.customId, { items });
  }
}

function ok(customId: string, value: unknown): LlmOutcome {
  return { customId, kind: 'ok', text: JSON.stringify(value), inputTokens: 10, outputTokens: 5 };
}

// ---------------------------------------------------------------------------------------------------
// Human review pass: a few approvals and edits through the real cell-action API, and two of the five
// scripted Inbox questions answered (leaving three open).
// ---------------------------------------------------------------------------------------------------

const APPROVALS: { slug: string; culture: Culture }[] = [
  { slug: 'item.emberShard.name', culture: 'de' },
  { slug: 'item.huntingBow.name', culture: 'fr' },
  { slug: 'ui.newGame', culture: 'ja' },
  { slug: 'quest.embersInTheDark.title', culture: 'de' },
  { slug: 'tut.openInventory', culture: 'fr' },
  // Also de, and also UI/Prompts: keeps the grid's "prompts" search (01_grid) showing an approved row
  // alongside the drafts and the needs_fix row, without touching any other view.
  { slug: 'ui.saveComplete', culture: 'de' },
];

const EDITS: { slug: string; culture: Culture; text: string }[] = [
  { slug: 'item.ironSword.desc', culture: 'de', text: 'Eine einfache, gut ausbalancierte Klinge – nicht prächtig, aber zuverlässig.' },
  { slug: 'dlg.bram.ironOre', culture: 'fr', text: 'Le minerai de fer commence à se faire rare. Le cuivre devra suffire, pour l\'instant.' },
  // The reviewer swaps "居座る" (squats, stays put) for "うろつく" (prowls), which is what "stalking" means.
  { slug: 'quest.bountyDuskhornStag.objective', culture: 'ja', text: '北の小道をうろつく黄昏の角鹿を狩り、賞金を受け取れ。' },
  // Also de, also UI/Prompts (see the APPROVALS comment above): an edited row in the same "prompts" search.
  { slug: 'ui.loading', culture: 'de', text: 'Wird geladen, bitte warten…' },
];

// Which of the five scripted questions (unit slug + culture + exact question text) get answered; the
// other two/three stay open. The id is derived the same way recordQuestion (memory.ts) derives it, so no
// store search is needed.
const QUESTIONS_TO_ANSWER: { slug: string; culture: Culture; answer: string }[] = [
  { slug: 'dlg.sella.oldRoads', culture: 'fr', answer: 'General term — no dedicated place name, just aging trade roads.' },
  { slug: 'item.wardingCharm.desc', culture: 'fr', answer: "Colloquial — keep it as a casual figure of speech, not a literal oath." },
];

const ACTOR = 'demo-reviewer';

// ---------------------------------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------------------------------

// Built once and reused for both the in-process apply below (main()) and the on-disk copy shoot.mjs later
// POSTs to the running shoot service over HTTP (Service/CONTRACT.md's Push protocol) so /api/coverage and
// /api/meta's nativeCulture are populated the same way a real editor Push populates them — applySnapshot()
// alone (in-process, no HTTP) never touches either. Coverage is baked in unconditionally: push.ts's
// applySnapshot ignores a Snapshot's `coverage` field entirely, so including it here is a no-op for the
// in-process apply and exactly what the later HTTP push needs.
function buildSnapshot(): Snapshot {
  return {
    target: 'Thornreach',
    nativeCulture: 'en',
    cultures: CULTURES,
    entries: ALL_UNITS.map(toSnapshotEntry),
    archives: {},
    coverage: COVERAGE_FINDINGS,
    // headSha/dirty intentionally omitted: those Snapshot fields are being removed from the contract in
    // a parallel task. esbuild strips types without checking them, so this compiles and runs fine even
    // though the current (soon-to-change) Snapshot type still declares both as required.
  } as Snapshot;
}

export async function main(outDir: string): Promise<void> {
  const dataDir = join(outDir, 'demo_project');
  const store = LocHubStore.load(dataDir);

  store.brief = BRIEF_TEXT;
  for (const culture of CULTURES) {
    store.glossary.set(culture, GLOSSARY[culture]);
    store.style.set(culture, STYLE_GUIDES[culture]);
  }

  const snapshot = buildSnapshot();
  applySnapshot(store, snapshot, 'push');

  const client = new DemoLlmClient();
  const cacheDir = mkdtempSync(join(tmpdir(), 'lochub-democache-'));
  const cache = new ResponseCache(cacheDir);
  const reports: JobReport[] = [];
  try {
    for (const culture of CULTURES) {
      client.culture = culture;
      const opts: JobOptions = {
        ...DEFAULT_JOB_OPTIONS,
        culture,
        mode: 'sync',
        pollMs: 1,
        auditPercent: 0,
        // Matches the shoot service's own --translate-model/--judge-model (Tools/media/shoot_provider.mjs),
        // so a card's recorded provenance ("ai:<model>+<promptVersion>", set by job.ts from these two fields
        // plus the real PROMPT_VERSION constant) agrees with the running service's own header.
        translateModel: SHOOT_PROVIDER.translateModel,
        judgeModel: SHOOT_PROVIDER.judgeModel,
        filter: { unitIds: TRANSLATED_IDS },
      };
      reports.push(await runTranslateJob(store, client, cache, opts));
    }
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }

  for (const { slug, culture } of APPROVALS) approveCell(store, culture, idOf(slug), ACTOR);
  for (const { slug, culture, text } of EDITS) editCell(store, culture, idOf(slug), text, ACTOR);

  const now = new Date().toISOString();
  for (const { slug, culture, answer } of QUESTIONS_TO_ANSWER) {
    const spec = TRANSLATIONS.get(idOf(slug))?.[culture];
    if (!spec?.question) throw new Error(`demo_project: ${slug}/${culture} has no scripted question to answer`);
    const inboxId = textHash(`${idOf(slug)}|${culture}|${spec.question.trim()}`);
    answerQuestion(store, inboxId, answer, now);
  }

  store.save();

  // Sibling to dataDir (Localization/demo_project, later renamed to Localization/LocHub by shoot.mjs), not
  // inside it: shoot.mjs reads this file by its own known path (join(projectDir, 'Localization',
  // 'push_snapshot.json')) after the rename, so it must not be renamed along with the store's own directory.
  writeFileSync(join(outDir, 'push_snapshot.json'), JSON.stringify(snapshot));

  // Read back from disk, the way the report asks: prove the store round-trips through the real APIs.
  const reread = LocHubStore.load(dataDir);
  printSummary(reread, reports, dataDir);
}

function printSummary(store: LocHubStore, reports: JobReport[], dataDir: string): void {
  const byStatus = (culture: Culture, status: string) => [...(store.cells.get(culture)?.values() ?? [])].filter((c) => c.status === status).length;
  const translatedPerCulture = Object.fromEntries(CULTURES.map((c) => [c, store.cells.get(c)?.size ?? 0]));
  const needsFixPerCulture = Object.fromEntries(CULTURES.map((c) => [c, byStatus(c, 'needs_fix')]));
  const approvedPerCulture = Object.fromEntries(CULTURES.map((c) => [c, byStatus(c, 'approved')]));
  const editedPerCulture = Object.fromEntries(CULTURES.map((c) => [c, byStatus(c, 'edited')]));
  const glossaryPerCulture = Object.fromEntries(CULTURES.map((c) => [c, store.glossary.get(c)?.length ?? 0]));
  const inboxByStatus = { open: 0, answered: 0, applied: 0, dismissed: 0 } as Record<string, number>;
  for (const item of store.inbox.values()) inboxByStatus[item.status] = (inboxByStatus[item.status] ?? 0) + 1;

  console.log(`demo_project written to ${dataDir}`);
  console.log(`units: ${store.units.size}`);
  console.log(`translated per culture: ${JSON.stringify(translatedPerCulture)}`);
  console.log(`needs_fix per culture: ${JSON.stringify(needsFixPerCulture)} (total ${Object.values(needsFixPerCulture).reduce((a, b) => a + b, 0)})`);
  console.log(`approved per culture: ${JSON.stringify(approvedPerCulture)} (total ${Object.values(approvedPerCulture).reduce((a, b) => a + b, 0)})`);
  console.log(`edited per culture: ${JSON.stringify(editedPerCulture)} (total ${Object.values(editedPerCulture).reduce((a, b) => a + b, 0)})`);
  console.log(`glossary terms per culture: ${JSON.stringify(glossaryPerCulture)}`);
  console.log(`inbox by status: ${JSON.stringify(inboxByStatus)}`);
  for (const r of reports) console.log(`job[${r.culture}]: requested=${r.requested} written=${r.written} needsFix=${r.needsFix} questions=${r.questions} bands=${JSON.stringify(r.bands)}`);
}
