import { describe, expect, it, vi } from 'vitest';
import { LocHubApi } from '../src/api/client';
import { EditorBridge } from '../src/bridge';
import { pickTextFile, saveTextFile } from '../src/files';
import { createFakeApi } from './fakeApi';

const noop = () => true;

describe('pickTextFile', () => {
  it('decodes the base64 payload from the editor binding into bytes', async () => {
    const fake = createFakeApi();
    // btoa only handles Latin1, so the UTF-8 bytes are turned into a binary string byte-by-byte first, exactly
    // as the editor's own base64 encoding of raw file bytes must be decoded on the way back.
    const text = 'term,translation\r\nbale,тюк\r\n';
    let binary = '';
    for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
    const base64 = btoa(binary);
    const bridge = new EditorBridge(new LocHubApi('', fake.fetch), () => ({
      openorigin: noop,
      setpreviewculture: noop,
      applylive: noop,
      picktextfile: () => JSON.stringify({ cancelled: false, name: 'glossary-ru.csv', base64 }),
    }));
    const result = await pickTextFile(bridge, 'Import glossary CSV', '.csv,text/csv');
    expect(result?.name).toBe('glossary-ru.csv');
    expect(new TextDecoder('utf-8').decode(result!.bytes)).toBe(text);
  });

  it('returns null when the editor picker is cancelled', async () => {
    const fake = createFakeApi();
    const bridge = new EditorBridge(new LocHubApi('', fake.fetch), () => ({
      openorigin: noop,
      setpreviewculture: noop,
      applylive: noop,
      picktextfile: () => JSON.stringify({ cancelled: true }),
    }));
    expect(await pickTextFile(bridge, 'Import glossary CSV', '.csv,text/csv')).toBeNull();
  });
});

describe('saveTextFile', () => {
  it('calls the editor binding with the CSV text and returns the written path', async () => {
    const fake = createFakeApi();
    const seen: unknown[] = [];
    const bridge = new EditorBridge(new LocHubApi('', fake.fetch), () => ({
      openorigin: noop,
      setpreviewculture: noop,
      applylive: noop,
      savetextfile: (title: string, defaultFileName: string, fileTypes: string, text: string) => {
        seen.push([title, defaultFileName, fileTypes, text]);
        return JSON.stringify({ cancelled: false, path: 'D:/x/glossary-ru.csv' });
      },
    }));
    const result = await saveTextFile(bridge, 'glossary-ru.csv', 'term,translation,dnt,note\r\n');
    expect(result).toEqual({ path: 'D:/x/glossary-ru.csv' });
    expect(seen).toEqual([
      ['Export CSV', 'glossary-ru.csv', 'CSV files (*.csv)|*.csv|All files (*.*)|*.*', 'term,translation,dnt,note\r\n'],
    ]);
  });

  it('returns null when the editor save dialog is cancelled', async () => {
    const fake = createFakeApi();
    const bridge = new EditorBridge(new LocHubApi('', fake.fetch), () => ({
      openorigin: noop,
      setpreviewculture: noop,
      applylive: noop,
      savetextfile: () => JSON.stringify({ cancelled: true }),
    }));
    expect(await saveTextFile(bridge, 'glossary-ru.csv', 'text')).toBeNull();
  });
});

// No editor binding (window.ue.lochub absent): falls back to a hidden <input type="file"> / Blob download.
describe('pickTextFile browser fallback', () => {
  it('resolves with the file text on the input\'s change event and removes the input', async () => {
    const fake = createFakeApi();
    const bridge = new EditorBridge(new LocHubApi('', fake.fetch), () => undefined);
    const promise = pickTextFile(bridge, 'Import glossary CSV', '.csv,text/csv');

    const input = document.querySelector('input[type="file"]') as HTMLInputElement | null;
    expect(input).not.toBeNull();
    const text = 'term,translation\r\nbale,тюк\r\n';
    // jsdom's File does not implement arrayBuffer(); a minimal duck-typed stand-in is enough since files.ts
    // only reads .name and calls .arrayBuffer().
    const bytes = new TextEncoder().encode(text);
    const file = { name: 'glossary.csv', arrayBuffer: async () => bytes.buffer } as unknown as File;
    Object.defineProperty(input, 'files', { value: [file] });
    input!.dispatchEvent(new Event('change'));

    const result = await promise;
    expect(result?.name).toBe('glossary.csv');
    expect(new TextDecoder('utf-8').decode(result!.bytes)).toBe(text);
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });

  it('resolves null on the input\'s cancel event and removes the input', async () => {
    const fake = createFakeApi();
    const bridge = new EditorBridge(new LocHubApi('', fake.fetch), () => undefined);
    const promise = pickTextFile(bridge, 'Import glossary CSV', '.csv,text/csv');

    const input = document.querySelector('input[type="file"]') as HTMLInputElement | null;
    expect(input).not.toBeNull();
    input!.dispatchEvent(new Event('cancel'));

    expect(await promise).toBeNull();
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });

  it('resolves null (instead of never settling) when the picked file\'s arrayBuffer() rejects', async () => {
    const fake = createFakeApi();
    const bridge = new EditorBridge(new LocHubApi('', fake.fetch), () => undefined);
    const promise = pickTextFile(bridge, 'Import glossary CSV', '.csv,text/csv');

    const input = document.querySelector('input[type="file"]') as HTMLInputElement | null;
    expect(input).not.toBeNull();
    const file = {
      name: 'glossary.csv',
      arrayBuffer: () => Promise.reject(new Error('read failed')),
    } as unknown as File;
    Object.defineProperty(input, 'files', { value: [file] });
    input!.dispatchEvent(new Event('change'));

    await expect(promise).resolves.toBeNull();
  });
});

describe('saveTextFile browser fallback', () => {
  it('creates and revokes an object URL for a download that is exactly the CSV text plus a 3-byte UTF-8 BOM', async () => {
    const fake = createFakeApi();
    const bridge = new EditorBridge(new LocHubApi('', fake.fetch), () => undefined);
    let blob: Blob | undefined;
    const createSpy = vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => {
      blob = b as Blob;
      return 'blob:mock';
    });
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);

    const text = 'term,translation,dnt,note\r\n';
    const result = await saveTextFile(bridge, 'glossary-ru.csv', text);

    expect(result).toEqual({});
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(revokeSpy).toHaveBeenCalledWith('blob:mock');
    // A U+FEFF BOM is 3 bytes in UTF-8: this is the runtime proof that a BOM (and only one) precedes the
    // text, without reading the Blob's own bytes back (a correct decode strips a genuine BOM, which would
    // make a present and an absent BOM indistinguishable at that point).
    expect(blob?.size).toBe(new TextEncoder().encode(text).length + 3);
    createSpy.mockRestore();
    revokeSpy.mockRestore();
  });
});
