import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CellEvent } from '../src/contract.js';
import { LocHubStore } from '../src/store.js';

const event = (unitId: string, culture: string, action: CellEvent['action'], ts: string, after = ''): CellEvent => ({
  ts,
  unitId,
  culture,
  action,
  actor: 'x',
  before: '',
  after,
});

const newStore = () => LocHubStore.load(mkdtempSync(join(tmpdir(), 'lochub-ev-')));

describe('LocHubStore.latestEventTimes', () => {
  it('keeps the newest time per unit, skipping the ignored actions and a torn last line', () => {
    const store = newStore();
    store.appendEvent(event('a', 'ru', 'edit', '2026-09-27T10:00:00.000Z'));
    store.appendEvent(event('a', 'ru', 'approve', '2026-09-27T12:00:00.000Z'));
    store.appendEvent(event('a', 'ru', 'exported', '2026-09-27T13:00:00.000Z'));
    store.appendEvent(event('b', 'ru', 'ai_draft', '2026-09-27T11:00:00.000Z'));
    store.appendEvent(event('c', 'de', 'edit', '2026-09-27T15:00:00.000Z'));
    appendFileSync(join(store.dataDir, 'events.ru.jsonl'), '{"ts":"2026-09-27T14:00:00.000Z","unitId":"b"');

    expect(store.latestEventTimes('ru', new Set(['exported']))).toEqual(
      new Map([
        ['a', Date.parse('2026-09-27T12:00:00.000Z')],
        ['b', Date.parse('2026-09-27T11:00:00.000Z')],
      ]),
    );
  });

  it('is empty for a culture without an event log', () => {
    expect(newStore().latestEventTimes('ru', new Set()).size).toBe(0);
  });

  it('skips an event whose ts does not parse as a date, keeping a later good one for the same unit', () => {
    const store = newStore();
    store.appendEvent(event('a', 'ru', 'edit', '2026-09-27T10:00:00.000Z'));
    store.appendEvent(event('a', 'ru', 'edit', 'not-a-date'));
    store.appendEvent(event('b', 'ru', 'edit', 'also-bogus'));

    expect(store.latestEventTimes('ru', new Set())).toEqual(new Map([['a', Date.parse('2026-09-27T10:00:00.000Z')]]));
  });
});

describe('LocHubStore.appendEvents', () => {
  it("appends every event after the existing ones, in order, into each culture's log", () => {
    const store = newStore();
    store.appendEvent(event('a', 'ru', 'edit', '2026-09-27T10:00:00.000Z', 'first'));
    store.appendEvents([
      event('b', 'ru', 'edit', '2026-09-27T11:00:00.000Z', 'second'),
      event('c', 'de', 'edit', '2026-09-27T11:00:00.000Z', 'other culture'),
      event('d', 'ru', 'edit', '2026-09-27T11:00:00.000Z', 'third'),
    ]);
    const afters = (culture: string) =>
      readFileSync(join(store.dataDir, `events.${culture}.jsonl`), 'utf8')
        .trim()
        .split('\n')
        .map((line) => (JSON.parse(line) as CellEvent).after);
    expect(afters('ru')).toEqual(['first', 'second', 'third']);
    expect(afters('de')).toEqual(['other culture']);
  });
});
