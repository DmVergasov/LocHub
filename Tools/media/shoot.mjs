#!/usr/bin/env node
// End-to-end Fab gallery shoot for LocHub (plan Task 11, Steps 3/4/6; reshot for task 11's reshoot brief):
// generates the offline demo project, starts a throwaway "shoot" service — the shipped bundle
// (Resources/LocHubService/lochub_service.mjs) serving the shipped web app (Resources/LocHubWeb +
// Source/ThirdParty/LocHubWebDeps), never Service/dist or Web/dist — pushes the demo's own snapshot back to
// it over HTTP (so coverage findings and the native culture show up, which an in-process store write never
// populates), holds the editor bridge stream open (so every "Editor:" pill reads connected), drives the real
// web UI in headless Edge over the DevTools protocol to capture raw screenshots, composes each one into a
// 1920x1080 frame (Tools/media/frames/feature.html), and stops the shoot service again. Re-runnable end to
// end from a clean slate.
//
// Usage: node Tools/media/shoot.mjs [--out <dir>] [--log-dir <dir>]
// --out and --log-dir default to Saved/Media and Saved/Logs under the plugin root (gitignored there); Tools/
// ships in the public repository, so nothing here may name the host project it happens to be checked out in.
//
// Hard constraints this script exists to satisfy:
//  - Never touches the owner's real LocHub service (port 47810); this one always runs on SHOOT_PORT below.
//  - No network calls and no real API key: the shoot service runs with a placeholder key for a provider
//    whose job-cost estimate is computed locally (OpenAiCompatibleLlmClient/GeminiLlmClient.countInputTokens
//    -> approxInputTokens; never AnthropicLlmClient.countInputTokens, which calls the real /v1/messages/count_tokens
//    endpoint). No translate/judge job is ever started — only POST /api/jobs/estimate, which never calls a model.
//  - The Custom endpoint scene (10_custom_endpoint) runs a second shoot service (CUSTOM_SHOOT_PORT) with
//    --provider custom and no API key, pointed at a loopback stand-in (FAKE_MODELS_PORT) that answers only
//    GET /v1/models, the service's startup probe; any other request to the stand-in fails the shoot.
//  - The editor bridge stream is only ever held open (a plain GET, never read for content); no bridge command
//    is ever sent, and Preview/Apply live are never clicked.
//  - Every process this script starts is stopped again by its own PID (service, Edge), never by image name.

import { spawn, execFileSync } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SHOOT_LENGTH_CHECK } from './shoot_length_check.mjs';
import { SHOOT_PROVIDER } from './shoot_provider.mjs';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
// The owner's own LocHub service lives on 47810 and must never be started, stopped or queried by this script.
const SHOOT_PORT = 47811;
const CDP_PORT = 9333;
// The Custom (OpenAI-compatible) endpoint scene: its own shoot service and a loopback stand-in that only lists
// CUSTOM_SHOOT_MODEL. Never a real endpoint, never a model call.
const CUSTOM_SHOOT_PORT = 47812;
const FAKE_MODELS_PORT = 47813;
const CUSTOM_SHOOT_MODEL = 'qwen3:8b';
const VIEWPORT = { width: 1280, height: 800, deviceScaleFactor: 2 };
const FRAME_SIZE = { width: 1920, height: 1080 };

const scriptDir = dirname(fileURLToPath(import.meta.url)); // .../LocHub/Tools/media
const pluginRoot = resolve(scriptDir, '..', '..'); // .../LocHub
// The shipped layout (plan Task 4/5), not Service/dist or Web/dist: those are stale now that the plugin ships
// a bundled service + a prebuilt web app under Resources/ and Source/ThirdParty/.
const shippedServicePath = join(pluginRoot, 'Resources', 'LocHubService', 'lochub_service.mjs');
const webDir = join(pluginRoot, 'Resources', 'LocHubWeb');
const webDepsDir = join(pluginRoot, 'Source', 'ThirdParty', 'LocHubWebDeps');
const frameTemplate = join(scriptDir, 'frames', 'feature.html');

function parseArgs(argv) {
  let out;
  let logDir;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') {
      out = argv[i + 1];
      i++;
    } else if (argv[i] === '--log-dir') {
      logDir = argv[i + 1];
      i++;
    }
  }
  return { out, logDir };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForHttp(url, timeoutMs, extraHeaders = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { headers: extraHeaders });
      if (res.ok) return res;
      lastError = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastError = e;
    }
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError}`);
}

// ---------------------------------------------------------------------------------------------------
// Step 1: the offline demo project (Tools/media/demo_project.ts via run_demo.mjs), laid out as
// <projectDir>/Localization/LocHub so the real CLI's --project flag can load it (cli.ts: LocHubStore.load
// resolves join(projectDir, 'Localization', 'LocHub')). demo_project.ts's own main() always writes into
// <out>/demo_project, so --out is pointed at .../Localization and the folder is renamed afterward.
// ---------------------------------------------------------------------------------------------------

function generateDemoProject(projectDir, logPath) {
  rmSync(projectDir, { recursive: true, force: true });
  const localizationDir = join(projectDir, 'Localization');
  mkdirSync(localizationDir, { recursive: true });
  const logFd = openSync(logPath, 'w');
  try {
    execFileSync(process.execPath, [join(scriptDir, 'run_demo.mjs'), '--out', localizationDir], { stdio: ['ignore', logFd, logFd] });
  } finally {
    closeSync(logFd);
  }
  renameSync(join(localizationDir, 'demo_project'), join(localizationDir, 'LocHub'));
}

// ---------------------------------------------------------------------------------------------------
// Step 2: the shoot service — the shipped bundle (Resources/LocHubService/lochub_service.mjs), serving the
// shipped web app (Resources/LocHubWeb + Source/ThirdParty/LocHubWebDeps), on SHOOT_PORT, with a placeholder
// key only in this child process's own environment (never written to a file, a log line, or this script's
// own output).
// ---------------------------------------------------------------------------------------------------

function startShootService(projectDir, logPath) {
  const logFd = openSync(logPath, 'w');
  const env = { ...process.env, [SHOOT_PROVIDER.keyVar]: 'demo-placeholder-not-a-key' };
  const child = spawn(
    process.execPath,
    [
      shippedServicePath,
      'serve',
      '--project',
      projectDir,
      '--port',
      String(SHOOT_PORT),
      '--provider',
      SHOOT_PROVIDER.provider,
      '--translate-model',
      SHOOT_PROVIDER.translateModel,
      '--judge-model',
      SHOOT_PROVIDER.judgeModel,
      '--web-dir',
      webDir,
      '--web-deps-dir',
      webDepsDir,
      ...SHOOT_LENGTH_CHECK.args,
    ],
    { cwd: pluginRoot, env, stdio: ['ignore', logFd, logFd] },
  );
  closeSync(logFd);
  return child;
}

// The stand-in for a local OpenAI-compatible server: answers only GET /v1/models (the service's one startup probe)
// with CUSTOM_SHOOT_MODEL. Every other request is recorded and answered 500; the scene fails if there was any.
function startFakeModelsServer() {
  const unexpected = [];
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ object: 'list', data: [{ id: CUSTOM_SHOOT_MODEL, object: 'model' }] }));
      return;
    }
    unexpected.push(`${request.method} ${request.url}`);
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'The shoot stand-in only lists models.' } }));
  });
  return new Promise((resolveServer, reject) => {
    server.once('error', reject);
    server.listen(FAKE_MODELS_PORT, '127.0.0.1', () => resolveServer({ server, unexpected }));
  });
}

// The Custom endpoint scene's service: the same shipped bundle and web app as startShootService, but --provider
// custom against the stand-in above, with no API key at all (a local endpoint needs none) and both prices 0, so the
// Jobs view shows the "prices are 0" hint.
function startCustomShootService(projectDir, logPath) {
  const logFd = openSync(logPath, 'w');
  const env = { ...process.env };
  delete env[SHOOT_PROVIDER.keyVar];
  const child = spawn(
    process.execPath,
    [
      shippedServicePath,
      'serve',
      '--project',
      projectDir,
      '--port',
      String(CUSTOM_SHOOT_PORT),
      '--provider',
      'custom',
      '--translate-model',
      CUSTOM_SHOOT_MODEL,
      '--judge-model',
      CUSTOM_SHOOT_MODEL,
      '--base-url',
      `http://127.0.0.1:${FAKE_MODELS_PORT}/v1`,
      '--key-header',
      'bearer',
      '--structured-output',
      'json_schema',
      '--price-in',
      '0',
      '--price-out',
      '0',
      '--max-parallel',
      '2',
      '--request-timeout',
      '300',
      '--web-dir',
      webDir,
      '--web-deps-dir',
      webDepsDir,
    ],
    { cwd: pluginRoot, env, stdio: ['ignore', logFd, logFd] },
  );
  closeSync(logFd);
  return child;
}

// Waits for the Custom service's startup probe (GET /api/health ai.endpoint) to leave 'checking'; anything but 'ok'
// means the scene would not show what it is meant to.
async function waitForEndpointOk(base, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const health = await (await fetch(`${base}/api/health`)).json();
    const endpoint = health.ai?.endpoint;
    if (endpoint?.status === 'ok') return;
    if (endpoint && endpoint.status !== 'checking') throw new Error(`Custom shoot endpoint probe: ${endpoint.status} ${endpoint.detail ?? ''}`);
    if (Date.now() > deadline) throw new Error('Custom shoot endpoint probe did not finish in time');
    await sleep(200);
  }
}

function stopByPid(pid, label) {
  if (pid === undefined) return;
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } catch (e) {
    console.warn(`Could not stop ${label} (pid ${pid}): ${e.message}`);
  }
}

// ---------------------------------------------------------------------------------------------------
// Step 2b: coverage findings and nativeCulture (Service/CONTRACT.md's Push protocol) only ever arrive
// through a real POST /api/push — demo_project.ts's own in-process applySnapshot() never populates the
// server's coverage/lastPush variables (server.ts's /api/push route sets those itself, after
// applySnapshot() returns). Sends the exact same entries demo_project.ts already applied in-process (a
// dry run first proves it changes no cells), plus the coverage findings, over HTTP the way the editor does.
// ---------------------------------------------------------------------------------------------------

async function pushDemoSnapshot(base, projectDir) {
  const snapshotPath = join(projectDir, 'Localization', 'push_snapshot.json');
  const body = readFileSync(snapshotPath, 'utf8');
  const headers = { 'content-type': 'application/json' };
  const dry = await (await fetch(`${base}/api/push?dryRun=1`, { method: 'POST', headers, body })).json();
  const touched = (dry.added ?? 0) + (dry.changed ?? 0) + (dry.cosmetic ?? 0) + (dry.tombstoned ?? 0) + (dry.revived ?? 0) + (dry.humanEdits ?? 0);
  if (touched !== 0) throw new Error(`Coverage push dry run would touch cells, refusing: ${JSON.stringify(dry)}`);
  const real = await (await fetch(`${base}/api/push`, { method: 'POST', headers, body })).json();
  console.log(`Coverage push applied (dry run confirmed no cell changes first): ${JSON.stringify(real)}`);
}

// ---------------------------------------------------------------------------------------------------
// Step 2c: hold the editor bridge stream open (server.ts's GET /api/bridge/stream), exactly as a real
// editor's SSE client does — a plain open GET, no handshake, never a bridge command — so /api/health's
// editorConnected (and every screen's "Editor:" pill) reads connected for the rest of the shoot.
// ---------------------------------------------------------------------------------------------------

async function holdBridgeStream(base) {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/bridge/stream`, { signal: controller.signal });
  if (!response.ok || !response.body) throw new Error(`Bridge stream failed to open: HTTP ${response.status}`);
  const reader = response.body.getReader();
  // Drain quietly in the background so the connection never backs up on its own heartbeat; the content of
  // each chunk is never inspected (this script never sends or reacts to a bridge command).
  (async () => {
    try {
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch {
      // Aborted on shutdown, or the service went away mid-shoot — either way nothing to report here.
    }
  })();
  return () => controller.abort();
}

// ---------------------------------------------------------------------------------------------------
// Step 3: a tiny Chrome DevTools Protocol client (Edge headless + --remote-debugging-port + WebSocket),
// no npm dependency: Node 22 has a global WebSocket and fetch (brief, Shots section).
// ---------------------------------------------------------------------------------------------------

class CdpTab {
  constructor(targetId, ws) {
    this.targetId = targetId;
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (event) => this.onMessage(JSON.parse(event.data)));
  }

  onMessage(msg) {
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data ?? '')})`));
      else resolve(msg.result);
    } else if (msg.method) {
      for (const handler of this.listeners.get(msg.method) ?? []) handler(msg.params);
    }
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  once(method) {
    return new Promise((resolve) => {
      const list = this.listeners.get(method) ?? [];
      const handler = (params) => {
        this.listeners.set(
          method,
          (this.listeners.get(method) ?? []).filter((h) => h !== handler),
        );
        resolve(params);
      };
      list.push(handler);
      this.listeners.set(method, list);
    });
  }

  // Evaluates a synchronous expression in the page; throws if the page threw.
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true });
    if (result.exceptionDetails) throw new Error(`Page threw: ${result.exceptionDetails.text} ${JSON.stringify(result.exceptionDetails.exception ?? '')}`);
    return result.result?.value;
  }

  async waitFor(expression, { timeoutMs = 8000, intervalMs = 150 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await this.evaluate(expression)) return;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for: ${expression}`);
      await sleep(intervalMs);
    }
  }

  async navigate(url) {
    const loaded = this.once('Page.loadEventFired');
    await this.send('Page.navigate', { url });
    await loaded;
  }

  async reload() {
    const loaded = this.once('Page.loadEventFired');
    await this.send('Page.reload', { ignoreCache: true });
    await loaded;
  }

  async screenshotPng() {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    return Buffer.from(data, 'base64');
  }

  close() {
    this.ws.close();
  }
}

async function openTab(cdpPort) {
  let target;
  try {
    target = await (await fetch(`http://127.0.0.1:${cdpPort}/json/new?about:blank`, { method: 'PUT' })).json();
  } catch {
    target = await (await fetch(`http://127.0.0.1:${cdpPort}/json/new?about:blank`)).json();
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  const tab = new CdpTab(target.id, ws);
  await tab.send('Page.enable');
  await tab.send('Runtime.enable');
  await tab.send('Emulation.setDeviceMetricsOverride', { ...VIEWPORT, mobile: false });
  return tab;
}

async function closeTab(cdpPort, tab) {
  tab.close();
  try {
    await fetch(`http://127.0.0.1:${cdpPort}/json/close/${tab.targetId}`);
  } catch {
    // Best effort: the whole Edge process is killed by PID right after the shoot anyway.
  }
}

// Navigates a fresh tab to one shot's url, waits for its prepare() condition, captures the raw screenshot and closes
// the tab again. Shared by the shotList loop and the Length Check shot, which is captured separately (see main()) so
// it sorts after 10_custom_endpoint in the "Shooting" log.
async function shootOne(shot, rawDir) {
  console.log(`Shooting ${shot.name}...`);
  const tab = await openTab(CDP_PORT);
  try {
    await tab.navigate(shot.url);
    await shot.prepare(tab);
    const png = await tab.screenshotPng();
    writeFileSync(join(rawDir, `${shot.name}.png`), png);
  } finally {
    await closeTab(CDP_PORT, tab);
  }
}

// Set by main() once the demo project exists: the translator's CSV demo_project.ts writes for the import preview.
let exchangeSamplePath = '';

// ---------------------------------------------------------------------------------------------------
// Step 4: the shot list. Unit ids were picked by hand from the deterministic demo store (see the report
// for how each was found) so every card shows a real, telling row instead of an arbitrary one.
// ---------------------------------------------------------------------------------------------------

function shotList(base) {
  return [
    {
      name: '01_grid',
      url: `${base}/?host=editor#/grid`,
      async prepare(tab) {
        // Extra culture columns are a per-browser preference (localStorage), read only once at mount, so a
        // reload is required for the app to pick up more than the single active column.
        await tab.evaluate("localStorage.setItem('lochub.gridExtraColumns', JSON.stringify(['de','fr','ja']))");
        await tab.reload();
        await tab.waitFor("document.querySelectorAll('.grid-row').length > 5");
        await tab.waitFor("(document.querySelector('.grid-header')?.textContent ?? '').includes('fr')");
        // "prompts" narrows the grid to the UI/Prompts.* rows (real search box, no scrolling needed): mostly
        // translated (8 of 9), and — by construction of the demo data — a needs_fix row (a dropped
        // placeholder), an approved row and an edited row mixed in among plain drafts and one untranslated
        // filler, so four distinct statuses and more than one priority band show up in a single screen.
        await tab.evaluate(`(() => {
          const input = document.querySelector('input[aria-label="Search"]');
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(input, 'prompts');
          input.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
        await tab.waitFor("document.querySelectorAll('.grid-row').length === 9");
      },
    },
    {
      // Settings.KeybindsReset (de): the demo generator drops the source's |plural(...) modifier on purpose;
      // runTranslateJob's own deterministic precheck marks it needs_fix (plural_dropped). The live format
      // check (ux-approve) now runs as soon as the card opens, so the issue is visible without any edit —
      // Approve/Save edit are already disabled ("Fix the problems above first"). Its key was chosen (see
      // demo_project.ts) to sort after Prompts.ItemAdded within the UI namespace, so the queue's own top row
      // (shot 05, unchanged) still shows ItemAdded — a genuinely different row from this card.
      name: '02_broken_formatting',
      url: `${base}/?host=editor#/card/de/6756ad45edfadac2`,
      async prepare(tab) {
        await tab.waitFor("!!document.querySelector('.cell-panel')");
        await tab.waitFor("document.querySelectorAll('.issues li').length > 0");
      },
    },
    {
      // Hints.CinderguardTrade (de): judge-flagged (severity major, terminology), why + fix scripted in the demo data.
      name: '03_judge',
      url: `${base}/?host=editor#/card/de/069cd8ebd4c5cc0d`,
      async prepare(tab) {
        await tab.waitFor("document.querySelectorAll('.judge li').length > 0");
      },
    },
    {
      // Prompts.QuestCompleted (de): clean ai_draft, C++ origin (GameNotifications.cpp), {QuestName} argument,
      // dev notes and a captioned table of neighbouring strings in the same UI/Prompts group.
      name: '04_context',
      url: `${base}/?host=editor#/card/de/d8f97024585b0aac`,
      async prepare(tab) {
        await tab.waitFor("!!document.querySelector('.context')");
        await tab.waitFor("document.querySelectorAll('.neighbors tr').length > 0");
        // Scrolls the neighbours table's bottom edge to the bottom of the viewport (not the Context section's
        // top, and not 'center'): shows the whole Context block (Origin/Dev notes/Arguments/Group/Provenance)
        // plus the full captioned neighbours table, while keeping as much of the page above it — including
        // the Source label near the top — in view as still fits.
        await tab.evaluate("document.querySelector('.neighbors')?.scrollIntoView({ block: 'end' })");
        await sleep(300);
      },
    },
    {
      name: '05_review_queue',
      url: `${base}/?host=editor#/queue`,
      async prepare(tab) {
        await tab.waitFor("!!document.querySelector('.queue-bar')");
      },
    },
    {
      name: '06_glossary',
      url: `${base}/?host=editor#/glossary`,
      async prepare(tab) {
        await tab.waitFor("document.querySelectorAll('.terms tbody tr').length > 0");
      },
    },
    {
      name: '07_jobs',
      url: `${base}/?host=editor#/jobs`,
      async prepare(tab) {
        await tab.waitFor("!!document.querySelector('.jobs')");
        await tab.evaluate("[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Estimate')?.click()");
        await tab.waitFor("!!document.querySelector('input[inputmode=\"decimal\"]')");
      },
    },
    {
      name: '08_inbox',
      url: `${base}/?host=editor#/inbox`,
      async prepare(tab) {
        await tab.waitFor("document.querySelectorAll('.inbox-list li').length > 0");
      },
    },
    {
      // Populated by pushDemoSnapshot() (a real POST /api/push, run once before any shot): the demo
      // generator's own in-process applySnapshot() never sets the server's coverage/nativeCulture state.
      name: '09_coverage',
      url: `${base}/?host=editor#/coverage`,
      async prepare(tab) {
        await tab.waitFor("document.querySelectorAll('.coverage tbody tr').length > 0");
      },
    },
  ];
}

// UI Menus.SaveAndQuit (de), the Length Check demo row (demo_project.ts lengthCheckUnits): the German label is far
// longer than the button allows, so the card opens with the counter over its limit and the too_long warning listed.
// Shot against the primary shoot service (its own --length-* flags are what the card's limits come from), but after
// the Custom endpoint scene — frame 11 follows frame 10 in the "Shooting" log.
function lengthCheckShot(base) {
  return {
    name: '11_length_check',
    url: `${base}/?host=editor#/card/de/4f04eeb24d357b2d`,
    async prepare(tab) {
      await tab.waitFor("!!document.querySelector('.length-counter.over')");
      await tab.waitFor("[...document.querySelectorAll('.issues li')].some((li) => li.textContent.startsWith('Too long for the UI'))");
    },
  };
}

// Translation exchange, Export… (Docs/07 "Export and import"): the same "prompts" search as 01_grid, so the scope
// reads "Strings matching the current filters (9)", with XLIFF picked. Never clicks Export (no file is written).
// Captured separately (see main()), after the Length Check shot, so it sorts last in the "Shooting" log.
function exchangeExportShot(base) {
  return {
    name: '12_exchange_export',
    url: `${base}/?host=editor#/grid`,
    async prepare(tab) {
      await tab.waitFor("document.querySelectorAll('.grid-row').length > 5");
      await tab.evaluate(`(() => {
        const input = document.querySelector('input[aria-label="Search"]');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, 'prompts');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await tab.waitFor("document.querySelectorAll('.grid-row').length === 9");
      await tab.evaluate("[...document.querySelectorAll('.toolbar button')].find((b) => b.textContent.trim() === 'Export…').click()");
      await tab.waitFor("!!document.querySelector('[role=\"dialog\"][aria-label=\"Export translations\"]')");
      await tab.evaluate(`(() => {
        const select = document.querySelector('select[aria-label="Export format"]');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
        setter.call(select, 'xliff');
        select.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await tab.waitFor("document.querySelector('select[aria-label=\"Export format\"]').value === 'xliff'");
    },
  };
}

// Translation exchange, Import… preview: feeds demo_project.ts's translator CSV to the browser file picker the
// web app opens (no editor binding here), through Edge's own file chooser intercepted over CDP — nothing about
// the page is faked. The click carries a user gesture, which a file chooser requires. Never clicks the final
// Import: the preview is a dry run and writes nothing.
function exchangeImportShot(base) {
  return {
    name: '13_exchange_import',
    url: `${base}/?host=editor#/grid`,
    async prepare(tab) {
      await tab.waitFor("document.querySelectorAll('.grid-row').length > 5");
      await tab.send('DOM.enable');
      await tab.send('Page.setInterceptFileChooserDialog', { enabled: true });
      const chooser = tab.once('Page.fileChooserOpened');
      await tab.send('Runtime.evaluate', {
        expression: "[...document.querySelectorAll('.toolbar button')].find((b) => b.textContent.trim() === 'Import…').click()",
        userGesture: true,
      });
      const { backendNodeId } = await chooser;
      await tab.send('DOM.setFileInputFiles', { files: [exchangeSamplePath], backendNodeId });
      await tab.waitFor("!!document.querySelector('[role=\"dialog\"][aria-label=\"Import translations\"]')", { timeoutMs: 15000 });
      await tab.evaluate(`(() => {
        const input = document.querySelector('input[aria-label="Reviewer name"]');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, 'Alex Morgan');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      // Opens the groups worth seeing: what changes, what is skipped and why, and the conflict.
      await tab.evaluate("for (const d of document.querySelectorAll('.exchange-panel details')) { if (/^(Changed|Skipped|Conflicts) /.test(d.querySelector('summary')?.textContent ?? '')) d.open = true; }");
      await tab.waitFor("[...document.querySelectorAll('.exchange-panel button')].some((b) => b.textContent.trim() === 'Import' && !b.disabled)");
      await tab.evaluate("document.querySelector('.exchange-panel')?.scrollIntoView({ block: 'start' })");
      await sleep(300);
    },
  };
}

// ---------------------------------------------------------------------------------------------------
// Step 4b: the Custom (OpenAI-compatible) endpoint scene — the AI pill with the endpoint host and "endpoint OK",
// and the Jobs view's "prices are 0" hint after an Estimate (computed locally; never a model call).
// ---------------------------------------------------------------------------------------------------

async function shootCustomEndpoint(projectDir, rawDir, logRoot) {
  const { server: modelsServer, unexpected } = await startFakeModelsServer();
  const service = startCustomShootService(projectDir, join(logRoot, 'shoot-custom-service.log'));
  const base = `http://127.0.0.1:${CUSTOM_SHOOT_PORT}`;
  let stopBridge;
  try {
    await waitForHttp(`${base}/api/health`, 15000);
    await waitForEndpointOk(base, 15000);
    stopBridge = await holdBridgeStream(base);
    const tab = await openTab(CDP_PORT);
    try {
      await tab.navigate(`${base}/?host=editor#/jobs`);
      await tab.waitFor("[...document.querySelectorAll('.ai-status')].some((el) => el.textContent.includes('endpoint OK'))");
      await tab.waitFor("!!document.querySelector('.jobs')");
      await tab.evaluate("[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Estimate')?.click()");
      await tab.waitFor("document.body.innerText.includes('Max USD cannot limit spending')");
      writeFileSync(join(rawDir, '10_custom_endpoint.png'), await tab.screenshotPng());
    } finally {
      await closeTab(CDP_PORT, tab);
    }
    if (unexpected.length > 0) throw new Error(`The Custom endpoint scene reached the stand-in beyond GET /v1/models: ${unexpected.join(', ')}`);
  } finally {
    if (stopBridge) stopBridge();
    stopByPid(service.pid, 'custom shoot service');
    modelsServer.close();
  }
}

// ---------------------------------------------------------------------------------------------------
// Step 5: frame composition (Tools/media/frames/feature.html), one headless Edge invocation per frame,
// exactly the command line the brief specifies.
// ---------------------------------------------------------------------------------------------------

const FRAME_TEXTS = {
  '01_grid': { title: 'Every string in one grid', body: ['Status, priority and source for thousands of strings.', 'Filter by status, path or namespace.'] },
  '02_broken_formatting': {
    title: 'Broken formatting never ships',
    body: ['Placeholders, plural forms and rich-text tags are checked in code.', 'Broken text cannot be approved.'],
  },
  '03_judge': { title: 'A second AI reviews every translation', body: ['Issues rated by severity, with a suggested fix.'] },
  '04_context': { title: 'Translated in context', body: ['The asset, developer notes and neighbouring strings go with every request.'] },
  '05_review_queue': { title: 'Review what matters first', body: ['Risky strings come first.', 'Approve, edit or reject from the keyboard.'] },
  '06_glossary': { title: 'Your terms, every time', body: ['Fixed and do-not-translate terms per language.', 'CSV import and export.'] },
  '07_jobs': { title: 'Know the cost first', body: ['Every job shows an estimate and stops at your spending cap.'] },
  '08_inbox': { title: 'The AI asks instead of guessing', body: ['Answer once, and every later translation sees it.'] },
  '09_coverage': { title: 'Find text that skips localization', body: ['Player-visible strings that bypass localization, with file and line.'] },
  '10_custom_endpoint': {
    title: 'Your model, your machine',
    body: ['Any OpenAI-compatible endpoint: Ollama, LM Studio, OpenRouter, Azure OpenAI.', 'With a local model, your text never leaves your machine.'],
  },
  '11_length_check': { title: 'Text that fits your UI', body: ['Translations that would overflow the UI are flagged.', 'The AI is told the length limit up front.'] },
  '12_exchange_export': { title: 'Work with human translators', body: ['Export any culture to XLIFF for CAT tools,', 'or to CSV for spreadsheets.'] },
  '13_exchange_import': { title: 'Their work comes back checked', body: ['Every imported string passes the same format checks.', 'Preview conflicts and warnings before anything changes.'] },
};

function renderFrame(name, rawPngPath, outPngPath, logPath) {
  const query = new URLSearchParams({ title: FRAME_TEXTS[name].title, body: FRAME_TEXTS[name].body.join('|'), img: pathToFileURL(rawPngPath).href });
  const url = `${pathToFileURL(frameTemplate).href}?${query.toString()}`;
  const logFd = openSync(logPath, 'a');
  try {
    execFileSync(
      EDGE,
      [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        `--force-device-scale-factor=1`,
        `--window-size=${FRAME_SIZE.width},${FRAME_SIZE.height}`,
        '--virtual-time-budget=3000',
        `--screenshot=${outPngPath}`,
        url,
      ],
      { stdio: ['ignore', logFd, logFd] },
    );
  } finally {
    closeSync(logFd);
  }
}

// ---------------------------------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------------------------------

async function main() {
  const { out, logDir } = parseArgs(process.argv.slice(2));
  const mediaRoot = out ? resolve(out) : join(pluginRoot, 'Saved', 'Media');
  const logRoot = logDir ? resolve(logDir) : join(pluginRoot, 'Saved', 'Logs');
  const projectDir = join(mediaRoot, 'demo_project');
  const rawDir = join(mediaRoot, 'raw');
  mkdirSync(rawDir, { recursive: true });
  mkdirSync(logRoot, { recursive: true });

  console.log('Generating demo project...');
  generateDemoProject(projectDir, join(logRoot, 'shoot-demo.log'));
  exchangeSamplePath = join(projectDir, 'Localization', 'exchange_sample_de.csv');

  console.log('Starting shoot service...');
  const service = startShootService(projectDir, join(logRoot, 'shoot-service.log'));
  const base = `http://127.0.0.1:${SHOOT_PORT}`;

  let edge;
  let edgeProfileDir;
  let stopBridge;
  try {
    await waitForHttp(`${base}/api/health`, 15000);
    const health = await (await fetch(`${base}/api/health`)).json();
    if (!health.ai?.ready) throw new Error(`Shoot service ai.ready is false: ${health.ai?.detail}`);
    // The demo's stored bands were computed with SHOOT_LENGTH_CHECK; a service running another Length Check would show
    // cards whose live check disagrees with them.
    if (health.ai?.lengthArgs !== SHOOT_LENGTH_CHECK.args.join(' ')) throw new Error(`Shoot service runs another Length Check: ${health.ai?.lengthArgs}`);
    console.log(`Shoot service up (pid ${service.pid}), ai=${JSON.stringify(health.ai)}`);

    console.log('Pushing the demo coverage snapshot over HTTP (dry run first)...');
    await pushDemoSnapshot(base, projectDir);

    console.log('Holding the editor bridge stream open...');
    stopBridge = await holdBridgeStream(base);
    const connectedHealth = await (await fetch(`${base}/api/health`)).json();
    if (!connectedHealth.editorConnected) throw new Error('Bridge stream did not register as connected in /api/health');

    console.log('Launching headless Edge...');
    edgeProfileDir = mkdtempSync(join(tmpdir(), 'lochub-shoot-edge-'));
    edge = spawn(
      EDGE,
      [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        `--remote-debugging-port=${CDP_PORT}`,
        `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
        `--user-data-dir=${edgeProfileDir}`,
        'about:blank',
      ],
      { stdio: 'ignore' },
    );
    await waitForHttp(`http://127.0.0.1:${CDP_PORT}/json/version`, 10000);

    for (const shot of shotList(base)) {
      await shootOne(shot, rawDir);
    }

    console.log('Shooting 10_custom_endpoint (second service, loopback model list only)...');
    await shootCustomEndpoint(projectDir, rawDir, logRoot);

    await shootOne(lengthCheckShot(base), rawDir);

    await shootOne(exchangeExportShot(base), rawDir);
    await shootOne(exchangeImportShot(base), rawDir);

    console.log('Rendering frames...');
    for (const name of Object.keys(FRAME_TEXTS)) {
      renderFrame(name, join(rawDir, `${name}.png`), join(mediaRoot, `${name}.png`), join(logRoot, 'shoot-frames.log'));
    }
  } finally {
    // Edge (and its crashpad helper) must exit before its profile directory can be removed: killing it here,
    // ahead of the rmSync below, avoids an EBUSY on files the still-running process holds open.
    if (edge) stopByPid(edge.pid, 'headless Edge');
    if (stopBridge) stopBridge();
    stopByPid(service.pid, 'shoot service');
    if (edgeProfileDir) rmSync(edgeProfileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }

  console.log('Done.');
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
});
