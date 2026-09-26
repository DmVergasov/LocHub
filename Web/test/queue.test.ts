import { describe, expect, it } from 'vitest';
import type { GridRow } from '../src/grid/model';
import { buildQueue, isTextField, queueAction } from '../src/review/queue';
import { makeCell, makeUnit } from './fakeApi';

const plain = { ctrlKey: false, metaKey: false, altKey: false };

function row(key: string, extra: Parameters<typeof makeCell>[2]): GridRow {
  const unit = makeUnit(key, key);
  return { unit, cells: { ru: { cell: makeCell(unit.id, 'ru', { text: key, ...extra }), outdated: false } } };
}

describe('queue keys', () => {
  it('maps J/K, A, E, 1-3, R, N', () => {
    const keys = ['j', 'K', 'a', 'e', '1', '2', '3', 'r', 'n'].map((key) => queueAction({ key, ...plain }, false));
    expect(keys).toEqual(['next', 'prev', 'approve', 'edit', 'alt1', 'alt2', 'alt3', 'reject', 'context']);
  });

  it('ignores keys typed into a field or held with a modifier', () => {
    expect(queueAction({ key: 'a', ...plain }, true)).toBeUndefined();
    expect(queueAction({ key: 'a', ...plain, ctrlKey: true }, false)).toBeUndefined();
    expect(queueAction({ key: 'x', ...plain }, false)).toBeUndefined();
  });

  it('knows which elements take text', () => {
    expect(isTextField(document.createElement('textarea'))).toBe(true);
    expect(isTextField(document.createElement('input'))).toBe(true);
    expect(isTextField(document.createElement('button'))).toBe(false);
    expect(isTextField(null)).toBe(false);
  });
});

describe('buildQueue', () => {
  it('puts needs_fix first, then red, yellow and the blind-audit greens', () => {
    const rows = [
      row('GreenPlain', { status: 'ai_draft', band: 'G' }),
      row('Yellow', { status: 'ai_draft', band: 'Y' }),
      row('GreenAudit', { status: 'ai_draft', band: 'G', qaFlags: ['audit'] }),
      row('Approved', { status: 'approved', band: 'R' }),
      row('Red', { status: 'ai_draft', band: 'R' }),
      row('Broken', { status: 'needs_fix', band: 'R' }),
    ];
    expect(buildQueue(rows, 'ru').map((r) => r.unit.key)).toEqual(['Broken', 'Red', 'Yellow', 'GreenAudit']);
    expect(buildQueue(rows, 'de')).toEqual([]);
  });
});
