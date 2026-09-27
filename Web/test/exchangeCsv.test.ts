import { describe, expect, it } from 'vitest';
import type { Cell, CellRow } from '../src/api/types';
import { exchangeToCsv, readExchangeCsv } from '../src/exchange/csv';
import { decodeUtf8 } from '../src/glossary/csv';
import { makeCell, makeUnit } from './fakeApi';

function row(key: string, source: string, cell: Partial<Cell> = {}, extra: Partial<CellRow> = {}): CellRow {
  const unit = makeUnit(key, source);
  return { unit, cell: makeCell(unit.id, 'de', cell), outdated: false, lengthLimit: null, ...extra };
}

const HEADER = 'namespace,key,source,translation,status,context,notes,max_length,lochub_id,lochub_revision\r\n';

describe('exchangeToCsv', () => {
  it('writes the exact header and one line per string: status, limit and revision', () => {
    const hint = row('Hint', 'Press {Key}', { text: 'Drücke {Key}', status: 'ai_draft', revision: 1 }, { outdated: true });
    hint.unit.devNotes = 'Shown, above the button';
    const rows = [row('Pause', 'PAUSED', { text: 'PAUSE', status: 'approved', revision: 3 }, { lengthLimit: 12 }), row('Quit', 'Quit'), hint];
    expect(exchangeToCsv(rows)).toBe(
      HEADER +
        'HW,Pause,PAUSED,PAUSE,approved,Source/MyGame/Private/Pause.cpp(10),,12,id-Pause,3\r\n' +
        'HW,Quit,Quit,,empty,Source/MyGame/Private/Quit.cpp(10),,,id-Quit,0\r\n' +
        'HW,Hint,Press {Key},Drücke {Key},outdated,Source/MyGame/Private/Hint.cpp(10),"Shown, above the button",,id-Hint,1\r\n',
    );
  });

  it('writes revision 0 for a string empty at export, and the import reads it back as 0, not "not given"', () => {
    const csv = exchangeToCsv([row('Quit', 'Quit')]);
    expect(csv).toContain('HW,Quit,Quit,,empty,Source/MyGame/Private/Quit.cpp(10),,,id-Quit,0\r\n');
    expect(readExchangeCsv(csv).entries).toEqual([{ unitId: 'id-Quit', namespace: 'HW', key: 'Quit', source: 'Quit', text: '', approved: false, exportedRevision: 0 }]);
  });

  it('quotes, doubles quotes, keeps line breaks and guards formulas; the import undoes exactly that', () => {
    const tricky = ['=SUM(A1)', '+1', '-5 HP', '@home', '\tindent', 'say "hi", then\r\nleave', 'plain'];
    const csv = exchangeToCsv(tricky.map((text, i) => row(`K${i}`, `Source ${i}`, { text, status: 'edited', revision: 1 })));
    expect(csv).toContain(',\t=SUM(A1),');
    expect(csv).toContain(',"say ""hi"", then\r\nleave",');
    expect(readExchangeCsv(csv).entries.map((entry) => entry.text)).toEqual(tricky);
  });
});

describe('readExchangeCsv', () => {
  it('round-trips an export saved with a BOM: ids, sources, revisions, approval', () => {
    const rows = [row('Pause', 'PAUSED', { text: 'PAUSE', status: 'approved', revision: 3 }), row('Quit', 'Quit'), row('Go', 'Go', { text: 'Los', status: 'edited', revision: 2 })];
    const bytes = new TextEncoder().encode('﻿' + exchangeToCsv(rows));
    expect(readExchangeCsv(decodeUtf8(bytes))).toEqual({
      format: 'csv',
      ignoredColumns: [],
      labels: ['Row 2: HW/Pause', 'Row 3: HW/Quit', 'Row 4: HW/Go'],
      copyOfSource: [false, false, false],
      entries: [
        { unitId: 'id-Pause', namespace: 'HW', key: 'Pause', source: 'PAUSED', text: 'PAUSE', approved: true, exportedRevision: 3 },
        { unitId: 'id-Quit', namespace: 'HW', key: 'Quit', source: 'Quit', text: '', approved: false, exportedRevision: 0 },
        { unitId: 'id-Go', namespace: 'HW', key: 'Go', source: 'Go', text: 'Los', approved: false, exportedRevision: 2 },
      ],
    });
  });

  it('reads any column order, lists extra columns, and detects the delimiter', () => {
    expect(readExchangeCsv('Comment,TRANSLATION,key,namespace,Reviewer\r\nfix later,Neu,Pause,HW,Ann\r\n')).toEqual({
      format: 'csv',
      ignoredColumns: ['Comment', 'Reviewer'],
      labels: ['Row 2: HW/Pause'],
      copyOfSource: [false],
      entries: [{ namespace: 'HW', key: 'Pause', text: 'Neu', approved: false }],
    });
    expect(readExchangeCsv('lochub_id;translation\r\nid-Pause;Neu\r\n').entries).toEqual([{ unitId: 'id-Pause', text: 'Neu', approved: false }]);
  });

  it('needs a translation column and either lochub_id or both namespace and key', () => {
    const message = 'The CSV needs a "translation" column and either "lochub_id" or both "namespace" and "key" (the header row LocHub exports).';
    expect(() => readExchangeCsv('key,translation\r\nPause,Neu\r\n')).toThrow(message);
    expect(() => readExchangeCsv('lochub_id,notes\r\nid-Pause,x\r\n')).toThrow(message);
    expect(() => readExchangeCsv('')).toThrow(message);
  });

  it('skips blank spreadsheet rows; an empty source or revision cell means "not given"', () => {
    const parsed = readExchangeCsv('lochub_id,source,translation,lochub_revision,status\r\nid-A,,Neu,,Approved \r\n,,,,\r\nid-B,Src,Alt,x3,\r\n');
    expect(parsed.entries).toEqual([
      { unitId: 'id-A', text: 'Neu', approved: true },
      { unitId: 'id-B', source: 'Src', text: 'Alt', approved: false },
    ]);
    expect(parsed.labels).toEqual(['Row 2', 'Row 4']);
  });
});
