import { describe, expect, it } from 'vitest';
import type { Cell, CellRow } from '../src/api/types';
import { exchangeToCsv } from '../src/exchange/csv';
import { parseTranslationFile } from '../src/exchange/read';
import { exchangeToXliff, LOCHUB_NS, readXliff, XLIFF_NS } from '../src/exchange/xliff';
import { makeCell, makeUnit } from './fakeApi';

function row(key: string, source: string, cell: Partial<Cell> = {}, extra: Partial<CellRow> = {}): CellRow {
  const unit = makeUnit(key, source);
  return { unit, cell: makeCell(unit.id, 'de', cell), outdated: false, lengthLimit: null, ...extra };
}

const DATE = '2026-09-27T10:00:00.000Z';
const OPTIONS = { culture: 'de', sourceCulture: 'en', date: DATE };
const parse = (xml: string) => new DOMParser().parseFromString(xml, 'application/xml');
const wrap = (units: string, targetLanguage = 'de') =>
  `<?xml version="1.0"?><xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2"><file original="x" source-language="en" target-language="${targetLanguage}" datatype="plaintext"><body>${units}</body></file></xliff>`;

describe('exchangeToXliff', () => {
  it('writes the XLIFF 1.2 header and one trans-unit per string with id, resname, revision, maxwidth, approved, state and notes', () => {
    const hint = row('Hint', 'Press {Key}', { text: 'Drücke {Key}', status: 'ai_draft', revision: 1 });
    hint.unit.devNotes = 'Prompt above the object';
    const xml = exchangeToXliff([row('Pause', 'PAUSED', { text: 'PAUSE', status: 'approved', revision: 3 }, { lengthLimit: 12 }), row('Quit', 'Quit'), hint], OPTIONS);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<xliff ')).toBe(true);
    const doc = parse(xml);
    expect(doc.getElementsByTagName('parsererror')).toHaveLength(0);
    const root = doc.documentElement;
    expect([root.namespaceURI, root.getAttribute('version'), root.lookupNamespaceURI('lochub')]).toEqual([XLIFF_NS, '1.2', LOCHUB_NS]);
    const file = doc.getElementsByTagName('file')[0]!;
    expect(['original', 'source-language', 'target-language', 'datatype', 'date'].map((name) => file.getAttribute(name))).toEqual([
      'LocHub/de',
      'en',
      'de',
      'plaintext',
      DATE,
    ]);
    const units = Array.from(doc.getElementsByTagName('trans-unit'));
    expect(
      units.map((unit) => [
        unit.getAttribute('id'),
        unit.getAttribute('resname'),
        unit.getAttributeNS(LOCHUB_NS, 'revision'),
        unit.getAttribute('maxwidth'),
        unit.getAttribute('size-unit'),
        unit.getAttribute('approved'),
      ]),
    ).toEqual([
      ['id-Pause', 'HW/Pause', '3', '12', 'char', 'yes'],
      ['id-Quit', 'HW/Quit', '0', null, null, null],
      ['id-Hint', 'HW/Hint', '1', null, null, null],
    ]);
    // xml:space="preserve": a CAT tool must not normalize the double spaces, leading/trailing spaces or line breaks
    // game strings rely on.
    expect(units.map((unit) => unit.getAttributeNS('http://www.w3.org/XML/1998/namespace', 'space'))).toEqual(['preserve', 'preserve', 'preserve']);
    expect(units.map((unit) => unit.getElementsByTagName('target')[0]?.getAttribute('state') ?? null)).toEqual(['final', null, 'needs-review-translation']);
    expect(units.map((unit) => Array.from(unit.getElementsByTagName('note')).map((note) => [note.getAttribute('from'), note.textContent]))).toEqual([
      [['location', 'Source/MyGame/Private/Pause.cpp(10)']],
      [['location', 'Source/MyGame/Private/Quit.cpp(10)']],
      [
        ['developer', 'Prompt above the object'],
        ['location', 'Source/MyGame/Private/Hint.cpp(10)'],
      ],
    ]);
  });

  it('writes revision 0 for a string empty at export, and the import reads it back as 0, not "not given"', () => {
    const xml = exchangeToXliff([row('Quit', 'Quit')], OPTIONS);
    const unit = parse(xml).getElementsByTagName('trans-unit')[0]!;
    expect(unit.getAttributeNS(LOCHUB_NS, 'revision')).toBe('0');
    expect(readXliff(xml, 'de').entries).toEqual([{ unitId: 'id-Quit', source: 'Quit', text: '', approved: false, exportedRevision: 0, exportedAt: DATE }]);
  });

  it('maps every status to its target state; an outdated string is not exported as approved', () => {
    const statuses = ['ai_draft', 'needs_fix', 'edited', 'human_edit', 'approved', 'rejected'] as const;
    const rows = statuses.map((status, i) => row(`K${i}`, `S${i}`, { text: `T${i}`, status, revision: 1 }));
    rows.push(row('Old', 'New source', { text: 'Alt', status: 'approved', revision: 1 }, { outdated: true }));
    const doc = parse(exchangeToXliff(rows, OPTIONS));
    expect(Array.from(doc.getElementsByTagName('target')).map((target) => target.getAttribute('state'))).toEqual([
      'needs-review-translation',
      'needs-review-translation',
      'translated',
      'translated',
      'final',
      'needs-translation',
      'needs-translation',
    ]);
    expect(doc.getElementsByTagName('trans-unit')[6]!.getAttribute('approved')).toBeNull();
  });

  it('protects arguments and rich-text tags as <ph>, numbered per segment, target ids matching the source', () => {
    const xml = exchangeToXliff([row('Loot', '<Bold>{Count}</> coins from {Name}', { text: '{Name}: <Bold>{Count}</> Münzen, {Extra}', status: 'edited', revision: 1 })], OPTIONS);
    expect(xml).toContain('<source><ph id="1">&lt;Bold&gt;</ph><ph id="2">{Count}</ph><ph id="3">&lt;/&gt;</ph> coins from <ph id="4">{Name}</ph></source>');
    expect(xml).toContain(
      '<target state="translated"><ph id="4">{Name}</ph>: <ph id="1">&lt;Bold&gt;</ph><ph id="2">{Count}</ph><ph id="3">&lt;/&gt;</ph> Münzen, <ph id="5">{Extra}</ph></target>',
    );
  });

  it('leaves an argument with a modifier as plain text', () => {
    const xml = exchangeToXliff([row('Bales', 'You have {Count}|plural(one={Count} bale,other={Count} bales) and {Name}')], OPTIONS);
    expect(xml).toContain('<source>You have {Count}|plural(one={Count} bale,other={Count} bales) and <ph id="1">{Name}</ph></source>');
  });

  it('refuses to export characters XML cannot store, naming the strings; CSV still exports them', () => {
    const rows = [row('Bell', 'Ding\u0007', { text: 'Dong', status: 'edited', revision: 1 }), row('Ok', 'OK')];
    expect(() => exchangeToXliff(rows, OPTIONS)).toThrow('XLIFF cannot store the control characters in 1 string(s) (HW/Bell). Export CSV instead');
    expect(exchangeToCsv(rows)).toContain('Ding\u0007');
  });
});

describe('readXliff', () => {
  it('round-trips through readXliff: text, codes, line breaks, approval, revision and date', () => {
    const rows = [
      row('Loot', '<Bold>{Count}</> coins', { text: '<Bold>{Count}</> Münzen', status: 'approved', revision: 4 }),
      row('Lines', 'One\r\nTwo', { text: 'Eins\r\nZwei & "drei"', status: 'edited', revision: 2 }),
      row('Quit', 'Quit'),
      // A backtick escape and a |plural(...) modifier both stay plain text (splitInlineCodes), not <ph>: this must
      // survive the round trip byte for byte, same as any other plain text.
      row('Bales', 'You have {Count}|plural(one={Count} bale,other={Count} bales), `{x`} <Bold>{Name}</>', {
        text: 'Du hast {Count}|plural(one={Count} Ballen,other={Count} Ballen), `{x`} <Bold>{Name}</>',
        status: 'edited',
        revision: 1,
      }),
    ];
    expect(readXliff(exchangeToXliff(rows, OPTIONS), 'de')).toEqual({
      format: 'xliff',
      ignoredColumns: [],
      labels: ['HW/Loot', 'HW/Lines', 'HW/Quit', 'HW/Bales'],
      copyOfSource: [false, false, false, false],
      entries: [
        { unitId: 'id-Loot', source: '<Bold>{Count}</> coins', text: '<Bold>{Count}</> Münzen', approved: true, exportedRevision: 4, exportedAt: DATE },
        { unitId: 'id-Lines', source: 'One\r\nTwo', text: 'Eins\r\nZwei & "drei"', approved: false, exportedRevision: 2, exportedAt: DATE },
        { unitId: 'id-Quit', source: 'Quit', text: '', approved: false, exportedRevision: 0, exportedAt: DATE },
        {
          unitId: 'id-Bales',
          source: 'You have {Count}|plural(one={Count} bale,other={Count} bales), `{x`} <Bold>{Name}</>',
          text: 'Du hast {Count}|plural(one={Count} Ballen,other={Count} Ballen), `{x`} <Bold>{Name}</>',
          approved: false,
          exportedRevision: 1,
          exportedAt: DATE,
        },
      ],
    });
  });

  it('drops a <file date> the service would refuse instead of failing the import', () => {
    const dated = (date: string) =>
      wrap('<trans-unit id="id-A"><source>A</source><target state="translated">Ä</target></trans-unit>').replace(
        'datatype="plaintext"',
        `datatype="plaintext" date="${date}"`,
      );
    for (const date of ['2026-09-27', '2026-09-27T10:00:00+0400', '2026-09-27 10:00:00Z']) {
      expect(readXliff(dated(date), 'de').entries[0]!.exportedAt).toBeUndefined();
    }
    expect(readXliff(dated('2026-09-27T10:00:00Z'), 'de').entries[0]!.exportedAt).toBe('2026-09-27T10:00:00Z');
  });

  it('falls back to "Unit N" when a trans-unit has neither resname nor id', () => {
    const xml = wrap(
      '<trans-unit><source>A</source><target state="translated">Ä</target></trans-unit>' +
        '<trans-unit><source>B</source><target state="translated">Bee</target></trans-unit>',
    );
    expect(readXliff(xml, 'de').labels).toEqual(['Unit 1', 'Unit 2']);
  });

  it('reads what CAT tools write: <g> and <mrk> unwrapped, empty <x>/<ex> filled from the source by id, CDATA, groups', () => {
    const xml = wrap(
      '<group><trans-unit id="id-Loot"><source><ph id="1">&lt;Bold&gt;</ph><ph id="2">{Count}</ph><ph id="3">&lt;/&gt;</ph> coins</source>' +
        '<target><g id="9"><x id="1"/><x id="2"/><ex id="3"/></g> <mrk mtype="term">Münzen</mrk><![CDATA[ & mehr]]></target></trans-unit></group>',
      'de-DE',
    );
    expect(readXliff(xml, 'de-de').entries).toEqual([{ unitId: 'id-Loot', source: '<Bold>{Count}</> coins', text: '<Bold>{Count}</> Münzen & mehr', approved: false }]);
  });

  it('a pre-filled copy of the source in state new or needs-translation is no translation, flagged copyOfSource unlike a genuinely blank target', () => {
    const unit = (state: string) => `<trans-unit id="id-${state}"><source>Quit</source><target state="${state}">Quit</target></trans-unit>`;
    const blank = '<trans-unit id="id-blank"><source>Quit</source></trans-unit>';
    const parsed = readXliff(wrap(unit('new') + unit('needs-translation') + unit('translated') + blank), 'de');
    expect(parsed.entries.map((entry) => entry.text)).toEqual(['', '', 'Quit', '']);
    expect(parsed.copyOfSource).toEqual([true, true, false, false]);
  });

  it('refuses a file for another culture, invalid XML, a non-XLIFF root and XLIFF 2.0', () => {
    expect(() => readXliff(wrap('', 'fr'), 'de')).toThrow('This file is for fr, not de. Switch the Grid to fr or pick the de file.');
    expect(() => readXliff('<xliff><file>', 'de')).toThrow('The file is not valid XML');
    expect(() => readXliff('<tmx version="1.4"/>', 'de')).toThrow('The file is not XLIFF');
    expect(() => readXliff('<xliff version="2.0" xmlns="urn:oasis:names:tc:xliff:document:2.0"/>', 'de')).toThrow('XLIFF 2.0 is not supported');
  });
});

describe('parseTranslationFile', () => {
  const encode = (text: string) => new TextEncoder().encode(text);
  const utf16 = (text: string, littleEndian: boolean) => {
    const out = new Uint8Array(2 + text.length * 2);
    out.set(littleEndian ? [0xff, 0xfe] : [0xfe, 0xff]);
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      out[2 + i * 2] = littleEndian ? c & 0xff : c >> 8;
      out[3 + i * 2] = littleEndian ? c >> 8 : c & 0xff;
    }
    return out;
  };
  const xml = wrap('<trans-unit id="id-A"><source>A</source><target state="translated">Ä</target></trans-unit>');

  it('picks the reader by extension, sniffs .xml and decodes UTF-16', () => {
    expect(parseTranslationFile('lochub-de.XLF', encode(xml), 'de').entries[0]!.text).toBe('Ä');
    expect(parseTranslationFile('vendor.xml', utf16(xml, true), 'de').format).toBe('xliff');
    expect(parseTranslationFile('vendor.xliff', utf16(xml, false), 'de').entries[0]!.text).toBe('Ä');
    expect(parseTranslationFile('sheet.csv', encode('lochub_id,translation\r\nid-A,Ä\r\n'), 'de').format).toBe('csv');
  });

  it('refuses an .xml file that is not XLIFF and any other extension', () => {
    expect(() => parseTranslationFile('notes.xml', encode('<notes/>'), 'de')).toThrow('This XML file is not XLIFF.');
    expect(() => parseTranslationFile('notes.txt', new Uint8Array(), 'de')).toThrow('Choose a .csv, .xlf, .xliff or .xml file.');
  });
});
