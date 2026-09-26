import type { LocHubApi } from './api/client';
import type { BridgeCommandName, LiveEntry } from './api/types';

// ULocHubBrowserBridge, bound as window.ue.lochub in the editor tab. CEF lower-cases every bound name
// (SWebBrowser.h, BindUObject) and each call returns a promise-like that resolves to the UFUNCTION's bool.
export interface UeLocHubBinding {
  openorigin(origin: string): unknown;
  setpreviewculture(culture: string): unknown;
  applylive(culture: string, entriesJson: string): unknown;
  // Optional: an editor built before this change has no sync, so findBinding must not require it.
  sync?(action: string): unknown;
  // Optional: file access (CSV Import/Export) added after sync; an older editor lacks these too, and files.ts
  // falls back to a browser <input>/Blob download when they are missing.
  picktextfile?(title: string, fileTypes: string): unknown;
  savetextfile?(title: string, defaultFileName: string, fileTypes: string, text: string): unknown;
}

export type BridgeRoute = 'direct' | 'relay' | 'none';

export type SyncAction = 'push' | 'dryrun' | 'pull';

export interface SyncOutcome {
  success: boolean;
  cancelled: boolean;
  summary: string;
  details: string[];
}

const UNREADABLE_SYNC_OUTCOME: SyncOutcome = { success: false, cancelled: false, summary: 'The editor sent an unreadable sync result.', details: [] };

export type PickFileResult = { cancelled: true } | { cancelled: false; name: string; base64: string };
export type SaveFileResult = { cancelled: true } | { cancelled: false; path: string };

function isPickFileResult(value: unknown): value is PickFileResult {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<{ cancelled: boolean; name: string; base64: string }>;
  if (candidate.cancelled === true) return true;
  return candidate.cancelled === false && typeof candidate.name === 'string' && typeof candidate.base64 === 'string';
}

function isSaveFileResult(value: unknown): value is SaveFileResult {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<{ cancelled: boolean; path: string }>;
  if (candidate.cancelled === true) return true;
  return candidate.cancelled === false && typeof candidate.path === 'string';
}

// picktextfile/savetextfile resolve a JSON string, same convention as Sync: anything that does not match the
// exact shape means a broken editor build, not a crash.
function parseFileResult<T>(raw: unknown, isValid: (value: unknown) => value is T, what: string): T {
  const fail = (): never => {
    throw new Error(`The editor sent an unreadable ${what} result.`);
  };
  if (typeof raw !== 'string') return fail();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail();
  }
  if (!isValid(parsed)) return fail();
  return parsed;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

// ULocHubBrowserBridge::Sync resolves with a JSON string (CEF cannot carry a plain object across the binding);
// anything that does not match the exact shape is treated the same as a broken editor build, not a crash.
function parseSyncOutcome(raw: unknown): SyncOutcome {
  if (typeof raw !== 'string') return UNREADABLE_SYNC_OUTCOME;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return UNREADABLE_SYNC_OUTCOME;
  }
  if (parsed === null || typeof parsed !== 'object') return UNREADABLE_SYNC_OUTCOME;
  const candidate = parsed as Partial<SyncOutcome>;
  if (typeof candidate.success !== 'boolean' || typeof candidate.cancelled !== 'boolean' || typeof candidate.summary !== 'string' || !isStringArray(candidate.details))
    return UNREADABLE_SYNC_OUTCOME;
  return { success: candidate.success, cancelled: candidate.cancelled, summary: candidate.summary, details: candidate.details };
}

function rejectionText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface OriginArgs {
  unitId: string;
  namespace: string;
  key: string;
  origin: string;
}

export function findBinding(scope: unknown = globalThis): UeLocHubBinding | undefined {
  const candidate = (scope as { ue?: { lochub?: Partial<UeLocHubBinding> } } | undefined)?.ue?.lochub;
  if (!candidate) return undefined;
  const complete =
    typeof candidate.openorigin === 'function' && typeof candidate.setpreviewculture === 'function' && typeof candidate.applylive === 'function';
  return complete ? (candidate as UeLocHubBinding) : undefined;
}

// The direct binding inside the editor tab; elsewhere the service relays to an editor connected over SSE.
export function routeFor(binding: UeLocHubBinding | undefined, editorConnected: boolean): BridgeRoute {
  if (binding) return 'direct';
  return editorConnected ? 'relay' : 'none';
}

async function succeeded(result: unknown): Promise<boolean> {
  return (await Promise.resolve(result)) !== false;
}

export class EditorBridge {
  private readonly api: LocHubApi;
  private readonly binding: () => UeLocHubBinding | undefined;

  constructor(api: LocHubApi, binding: () => UeLocHubBinding | undefined = () => findBinding()) {
    this.api = api;
    this.binding = binding;
  }

  route(editorConnected: boolean): BridgeRoute {
    return routeFor(this.binding(), editorConnected);
  }

  // Sync (Push / Dry run / Pull) exists only as the direct in-tab binding, with no relay route for it: an
  // external browser, or an editor build that predates this change, must hide the buttons instead of calling it.
  canSync(): boolean {
    return typeof this.binding()?.sync === 'function';
  }

  async sync(action: SyncAction): Promise<SyncOutcome> {
    const binding = this.binding();
    if (typeof binding?.sync !== 'function') throw new Error('Push and Pull run only in the editor tab.');
    let raw: unknown;
    try {
      raw = await binding.sync(action);
    } catch (error) {
      throw new Error(rejectionText(error));
    }
    return parseSyncOutcome(raw);
  }

  // File access (CSV Import/Export) exists only as the direct in-tab binding, same reasoning as Sync: files.ts
  // uses these to feature-detect and falls back to a browser <input>/Blob download when they are missing.
  canPickFile(): boolean {
    return typeof this.binding()?.picktextfile === 'function';
  }

  canSaveFile(): boolean {
    return typeof this.binding()?.savetextfile === 'function';
  }

  async pickFile(title: string, fileTypes: string): Promise<PickFileResult> {
    const binding = this.binding();
    if (typeof binding?.picktextfile !== 'function') throw new Error('File access runs only in the editor tab.');
    let raw: unknown;
    try {
      raw = await binding.picktextfile(title, fileTypes);
    } catch (error) {
      throw new Error(rejectionText(error));
    }
    return parseFileResult(raw, isPickFileResult, 'file picker');
  }

  async saveFile(title: string, defaultFileName: string, fileTypes: string, text: string): Promise<SaveFileResult> {
    const binding = this.binding();
    if (typeof binding?.savetextfile !== 'function') throw new Error('File access runs only in the editor tab.');
    let raw: unknown;
    try {
      raw = await binding.savetextfile(title, defaultFileName, fileTypes, text);
    } catch (error) {
      throw new Error(rejectionText(error));
    }
    return parseFileResult(raw, isSaveFileResult, 'save file');
  }

  async openOrigin(args: OriginArgs, editorConnected: boolean): Promise<boolean> {
    const binding = this.binding();
    if (binding) return succeeded(binding.openorigin(args.origin));
    return this.relay('OpenOrigin', { ...args }, editorConnected);
  }

  async setPreviewCulture(culture: string, editorConnected: boolean): Promise<boolean> {
    const binding = this.binding();
    if (binding) return succeeded(binding.setpreviewculture(culture));
    return this.relay('SetPreviewCulture', { culture }, editorConnected);
  }

  async applyLive(culture: string, entries: LiveEntry[], editorConnected: boolean): Promise<boolean> {
    if (entries.length === 0) return false;
    const binding = this.binding();
    if (binding) return succeeded(binding.applylive(culture, JSON.stringify(entries)));
    return this.relay('ApplyLive', { culture, entries }, editorConnected);
  }

  // The tab never relays: the same editor would run the command twice (direct call plus SSE).
  private async relay(name: BridgeCommandName, args: Record<string, unknown>, editorConnected: boolean): Promise<boolean> {
    if (!editorConnected) return false;
    await this.api.bridgeCommand(name, args);
    return true;
  }
}
