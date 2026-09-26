import { describe, expect, it } from 'vitest';
import { LocHubApi } from '../src/api/client';
import { EditorBridge, findBinding, routeFor, type UeLocHubBinding } from '../src/bridge';
import { createFakeApi } from './fakeApi';

const args = { unitId: 'id-A', namespace: 'HW', key: 'A', origin: 'Source/A.cpp(3)' };
const entry = { namespace: 'HW', key: 'A', source: 'PAUSED', translation: 'ПАУЗА' };

describe('EditorBridge', () => {
  it('uses the editor binding inside the tab and never relays', async () => {
    const fake = createFakeApi({ editorConnected: true });
    const seen: string[] = [];
    const binding: UeLocHubBinding = {
      openorigin: (origin) => {
        seen.push(`open ${origin}`);
        return Promise.resolve(true);
      },
      setpreviewculture: () => true,
      applylive: (culture, json) => {
        seen.push(`live ${culture} ${json}`);
        return Promise.resolve(false);
      },
    };
    const bridge = new EditorBridge(new LocHubApi('', fake.fetch), () => binding);
    expect(bridge.route(false)).toBe('direct');
    expect(await bridge.openOrigin(args, true)).toBe(true);
    expect(await bridge.applyLive('ru', [entry], true)).toBe(false);
    expect(seen).toEqual(['open Source/A.cpp(3)', `live ru ${JSON.stringify([entry])}`]);
    expect(fake.calls.filter((call) => call.includes('/api/bridge/command'))).toEqual([]);
  });

  it('relays through the service when an editor is connected', async () => {
    const fake = createFakeApi({ editorConnected: true });
    const bridge = new EditorBridge(new LocHubApi('', fake.fetch), () => undefined);
    expect(bridge.route(true)).toBe('relay');
    expect(await bridge.openOrigin(args, true)).toBe(true);
    expect(await bridge.applyLive('ru', [entry], true)).toBe(true);
    expect(fake.state.commands).toEqual([
      { name: 'OpenOrigin', args },
      { name: 'ApplyLive', args: { culture: 'ru', entries: [entry] } },
    ]);
  });

  it('does nothing without an editor', async () => {
    const fake = createFakeApi({ editorConnected: false });
    const bridge = new EditorBridge(new LocHubApi('', fake.fetch), () => undefined);
    expect(bridge.route(false)).toBe('none');
    expect(await bridge.setPreviewCulture('ru', false)).toBe(false);
    expect(await bridge.applyLive('ru', [], true)).toBe(false);
    expect(fake.calls).toEqual([]);
  });

  it('accepts only a complete binding', () => {
    const noop = () => true;
    expect(findBinding({ ue: { lochub: { openorigin: noop, setpreviewculture: noop, applylive: noop } } })).toBeDefined();
    expect(findBinding({ ue: { lochub: { openorigin: noop } } })).toBeUndefined();
    expect(findBinding({})).toBeUndefined();
    expect(routeFor(undefined, false)).toBe('none');
  });

  it('still accepts a binding without sync (an editor built before this change)', () => {
    const noop = () => true;
    expect(findBinding({ ue: { lochub: { openorigin: noop, setpreviewculture: noop, applylive: noop } } })).toBeDefined();
  });

  describe('sync', () => {
    const outcome = { success: true, cancelled: false, summary: 'Pushed 3 strings.', details: ['A', 'B'] };
    const noop = () => true;

    it('canSync is true only when the binding has a sync function', () => {
      const fake = createFakeApi();
      const api = new LocHubApi('', fake.fetch);
      const withSync = new EditorBridge(api, () => ({ openorigin: noop, setpreviewculture: noop, applylive: noop, sync: () => '{}' }));
      const withoutSync = new EditorBridge(api, () => ({ openorigin: noop, setpreviewculture: noop, applylive: noop }));
      const noBinding = new EditorBridge(api, () => undefined);
      expect(withSync.canSync()).toBe(true);
      expect(withoutSync.canSync()).toBe(false);
      expect(noBinding.canSync()).toBe(false);
    });

    it('parses a well-formed JSON result', async () => {
      const fake = createFakeApi();
      const api = new LocHubApi('', fake.fetch);
      const bridge = new EditorBridge(api, () => ({
        openorigin: noop,
        setpreviewculture: noop,
        applylive: noop,
        sync: (action) => (action === 'push' ? JSON.stringify(outcome) : undefined),
      }));
      expect(await bridge.sync('push')).toEqual(outcome);
    });

    it('rethrows a rejected promise as an Error with the rejection text', async () => {
      const fake = createFakeApi();
      const api = new LocHubApi('', fake.fetch);
      const bridge = new EditorBridge(api, () => ({
        openorigin: noop,
        setpreviewculture: noop,
        applylive: noop,
        sync: () => Promise.reject(new Error('Push failed: disk full')),
      }));
      await expect(bridge.sync('pull')).rejects.toThrow('Push failed: disk full');
    });

    it('rethrows a string rejection as an Error with that text', async () => {
      const fake = createFakeApi();
      const api = new LocHubApi('', fake.fetch);
      const bridge = new EditorBridge(api, () => ({
        openorigin: noop,
        setpreviewculture: noop,
        applylive: noop,
        sync: () => Promise.reject('boom'),
      }));
      await expect(bridge.sync('dryrun')).rejects.toThrow('boom');
    });

    it('falls back to an unreadable-result outcome for garbage (non-string, unparsable, or missing field)', async () => {
      const fake = createFakeApi();
      const api = new LocHubApi('', fake.fetch);
      const unreadable = { success: false, cancelled: false, summary: 'The editor sent an unreadable sync result.', details: [] };
      const bindingReturning = (value: unknown) =>
        new EditorBridge(api, () => ({ openorigin: noop, setpreviewculture: noop, applylive: noop, sync: () => value }));

      expect(await bindingReturning(42).sync('push')).toEqual(unreadable);
      expect(await bindingReturning('not json').sync('push')).toEqual(unreadable);
      expect(await bindingReturning(JSON.stringify({ success: true, cancelled: false, details: [] })).sync('push')).toEqual(unreadable);
      expect(await bindingReturning(JSON.stringify({ success: true, cancelled: false, summary: 'ok', details: ['x', 2] })).sync('push')).toEqual(unreadable);
    });

    it('throws when there is no binding at all', async () => {
      const fake = createFakeApi();
      const api = new LocHubApi('', fake.fetch);
      const bridge = new EditorBridge(api, () => undefined);
      await expect(bridge.sync('push')).rejects.toThrow('Push and Pull run only in the editor tab.');
    });
  });

  describe('file access', () => {
    const noop = () => true;

    it('canPickFile/canSaveFile are true only when the binding has the matching function', () => {
      const fake = createFakeApi();
      const api = new LocHubApi('', fake.fetch);
      const withFiles = new EditorBridge(api, () => ({
        openorigin: noop,
        setpreviewculture: noop,
        applylive: noop,
        picktextfile: () => '{}',
        savetextfile: () => '{}',
      }));
      const withoutFiles = new EditorBridge(api, () => ({ openorigin: noop, setpreviewculture: noop, applylive: noop }));
      const noBinding = new EditorBridge(api, () => undefined);
      expect(withFiles.canPickFile()).toBe(true);
      expect(withFiles.canSaveFile()).toBe(true);
      expect(withoutFiles.canPickFile()).toBe(false);
      expect(withoutFiles.canSaveFile()).toBe(false);
      expect(noBinding.canPickFile()).toBe(false);
      expect(noBinding.canSaveFile()).toBe(false);
    });

    it('pickFile resolves a well-formed JSON result and passes title/fileTypes through', async () => {
      const fake = createFakeApi();
      const api = new LocHubApi('', fake.fetch);
      const seen: unknown[] = [];
      const bridge = new EditorBridge(api, () => ({
        openorigin: noop,
        setpreviewculture: noop,
        applylive: noop,
        picktextfile: (title: string, fileTypes: string) => {
          seen.push([title, fileTypes]);
          return JSON.stringify({ cancelled: false, name: 'glossary-ru.csv', base64: 'YQ==' });
        },
      }));
      expect(await bridge.pickFile('Import glossary CSV', 'CSV files (*.csv)|*.csv')).toEqual({
        cancelled: false,
        name: 'glossary-ru.csv',
        base64: 'YQ==',
      });
      expect(seen).toEqual([['Import glossary CSV', 'CSV files (*.csv)|*.csv']]);
    });

    it('pickFile resolves a cancelled result', async () => {
      const fake = createFakeApi();
      const api = new LocHubApi('', fake.fetch);
      const bridge = new EditorBridge(api, () => ({
        openorigin: noop,
        setpreviewculture: noop,
        applylive: noop,
        picktextfile: () => JSON.stringify({ cancelled: true }),
      }));
      expect(await bridge.pickFile('t', 'f')).toEqual({ cancelled: true });
    });

    it('pickFile rethrows a rejected promise as an Error with the rejection text', async () => {
      const fake = createFakeApi();
      const api = new LocHubApi('', fake.fetch);
      const bridge = new EditorBridge(api, () => ({
        openorigin: noop,
        setpreviewculture: noop,
        applylive: noop,
        picktextfile: () => Promise.reject(new Error('disk error')),
      }));
      await expect(bridge.pickFile('t', 'f')).rejects.toThrow('disk error');
    });

    it('pickFile throws when there is no binding at all', async () => {
      const fake = createFakeApi();
      const api = new LocHubApi('', fake.fetch);
      const bridge = new EditorBridge(api, () => undefined);
      await expect(bridge.pickFile('t', 'f')).rejects.toThrow('File access runs only in the editor tab.');
    });

    it('saveFile resolves a well-formed JSON result and passes every argument through', async () => {
      const fake = createFakeApi();
      const api = new LocHubApi('', fake.fetch);
      const seen: unknown[] = [];
      const bridge = new EditorBridge(api, () => ({
        openorigin: noop,
        setpreviewculture: noop,
        applylive: noop,
        savetextfile: (title: string, defaultFileName: string, fileTypes: string, text: string) => {
          seen.push([title, defaultFileName, fileTypes, text]);
          return JSON.stringify({ cancelled: false, path: 'D:/x/glossary-ru.csv' });
        },
      }));
      expect(await bridge.saveFile('Export CSV', 'glossary-ru.csv', 'CSV files (*.csv)|*.csv', 'term,translation,dnt,note\r\n')).toEqual({
        cancelled: false,
        path: 'D:/x/glossary-ru.csv',
      });
      expect(seen).toEqual([['Export CSV', 'glossary-ru.csv', 'CSV files (*.csv)|*.csv', 'term,translation,dnt,note\r\n']]);
    });

    it('saveFile resolves a cancelled result', async () => {
      const fake = createFakeApi();
      const api = new LocHubApi('', fake.fetch);
      const bridge = new EditorBridge(api, () => ({
        openorigin: noop,
        setpreviewculture: noop,
        applylive: noop,
        savetextfile: () => JSON.stringify({ cancelled: true }),
      }));
      expect(await bridge.saveFile('t', 'd', 'f', 'text')).toEqual({ cancelled: true });
    });

    it('saveFile throws when there is no binding at all', async () => {
      const fake = createFakeApi();
      const api = new LocHubApi('', fake.fetch);
      const bridge = new EditorBridge(api, () => undefined);
      await expect(bridge.saveFile('t', 'd', 'f', 'text')).rejects.toThrow('File access runs only in the editor tab.');
    });

    it('rejects a garbage result the same way for pickFile and saveFile', async () => {
      const fake = createFakeApi();
      const api = new LocHubApi('', fake.fetch);
      const pickBridge = new EditorBridge(api, () => ({ openorigin: noop, setpreviewculture: noop, applylive: noop, picktextfile: () => 'not json' }));
      const saveBridge = new EditorBridge(api, () => ({ openorigin: noop, setpreviewculture: noop, applylive: noop, savetextfile: () => 42 }));
      await expect(pickBridge.pickFile('t', 'f')).rejects.toThrow();
      await expect(saveBridge.saveFile('t', 'd', 'f', 'x')).rejects.toThrow();
    });
  });
});
