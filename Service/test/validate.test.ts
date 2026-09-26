import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { emptyCell } from '../src/contract.js';
import { LocHubStore } from '../src/store.js';
import { checkCulture, CULTURE_RE, validateAccept, validateAck, validateSnapshot } from '../src/validate.js';

const tempStore = () => LocHubStore.load(mkdtempSync(join(tmpdir(), 'lochub-validate-')));

describe('CULTURE_RE', () => {
  it('accepts BCP-47-ish tags and rejects path traversal and other malformed values', () => {
    for (const good of ['ru', 'en', 'pt-BR', 'zh-Hans-CN', 'abc']) expect(CULTURE_RE.test(good)).toBe(true);
    for (const bad of ['', 'r', 'RUSSIA', 'ru/..', 'ru..', 'ru ', '../ru', 'x/../../TRUNC']) expect(CULTURE_RE.test(bad)).toBe(false);
  });
});

describe('checkCulture', () => {
  it('rejects a non-string or malformed culture', () => {
    expect(checkCulture(tempStore(), undefined)).toBe('Invalid culture');
    expect(checkCulture(tempStore(), 123)).toBe('Invalid culture');
    expect(checkCulture(tempStore(), 'x/../../../PWNED')).toBe('Invalid culture');
  });

  it('accepts a fresh well-formed culture', () => {
    expect(checkCulture(tempStore(), 'ru')).toBeNull();
  });

  it('rejects a spelling that only differs in case from an existing culture', () => {
    const store = tempStore();
    store.putCell({ ...emptyCell('u1', 'ru'), text: 'ПАУЗА', status: 'ai_draft', basedOnSourceRev: 1 });
    expect(checkCulture(store, 'RU')).toBe('Culture must be spelled "ru"');
    expect(checkCulture(store, 'ru')).toBeNull();
  });

  // A culture with no cells/glossary/style yet (a job just started for it) must still block a
  // differently-cased spelling elsewhere, via the extra iterable the server passes in.
  it('rejects a spelling that only differs in case from an extra (in-flight job) culture', () => {
    const store = tempStore();
    expect(checkCulture(store, 'pt-BR', ['pt-br'])).toBe('Culture must be spelled "pt-br"');
    expect(checkCulture(store, 'pt-br', ['pt-br'])).toBeNull();
    expect(checkCulture(store, 'pt-BR')).toBeNull();
  });
});

describe('validateSnapshot', () => {
  const entry = { namespace: 'HW', key: 'A', source: 'PAUSED', origin: 'o', devNotes: '', metadata: {}, groupKey: 'g' };

  it('accepts a well-formed snapshot', () => {
    expect(validateSnapshot({ entries: [entry] })).toBeNull();
  });

  it('reports the first offending entry field by index', () => {
    expect(validateSnapshot({ entries: [entry, { ...entry, source: 1 }] })).toBe('entries[1].source must be a string');
  });

  it('reports a non-string-valued metadata object', () => {
    expect(validateSnapshot({ entries: [{ ...entry, metadata: { k: 1 } }] })).toBe('entries[0].metadata must be an object of strings');
  });

  // The plugin dropped headSha/dirty (LocHub no longer depends on git); an old client that still sends them
  // must not be rejected over fields the contract no longer defines.
  it('accepts a snapshot that still carries the retired headSha/dirty fields', () => {
    expect(validateSnapshot({ entries: [entry], headSha: 'abc', dirty: true })).toBeNull();
  });

  it('validates archives keys and entries', () => {
    expect(validateSnapshot({ entries: [], archives: { 'x/..': [] } })).toBe('archives key "x/.." is not a valid culture');
    expect(validateSnapshot({ entries: [], archives: { ru: [{ namespace: 'HW', key: 'A', translation: 1, source: 'PAUSED' }] } })).toBe(
      'archives.ru[0].translation must be a string',
    );
    // `source` is required.
    expect(validateSnapshot({ entries: [], archives: { ru: [{ namespace: 'HW', key: 'A', translation: 'ПАУЗА' }] } })).toBe(
      'archives.ru[0].source must be a string',
    );
    expect(
      validateSnapshot({ entries: [], archives: { ru: [{ namespace: 'HW', key: 'A', translation: 'ПАУЗА', source: 'PAUSED' }] } }),
    ).toBeNull();
  });

  // A snapshot that carries two archive keys colliding only in case has no committed culture to compare
  // against yet, so the per-request check must look within the payload itself, not just at the store.
  it('rejects two archives keys that differ only in case within the same snapshot', () => {
    expect(
      validateSnapshot({
        entries: [],
        archives: { ru: [], RU: [] },
      }),
    ).toMatch(/ru.*RU|RU.*ru/);
  });

  it('validates coverage entries', () => {
    expect(validateSnapshot({ entries: [], coverage: [{ kind: 'FromString', file: 'a.cpp', line: '42', text: 'x' }] })).toBe(
      'coverage[0].line must be a number',
    );
    expect(validateSnapshot({ entries: [], coverage: [{ kind: 'FromString', file: 'a.cpp', line: 42, text: 'x' }] })).toBeNull();
  });

  it('rejects a non-object body and a missing entries array', () => {
    expect(validateSnapshot(null)).toBe('Snapshot must be an object');
    expect(validateSnapshot({})).toBe('entries must be an array');
  });

  // pluralForms is optional: an older plugin does not send it, and the service then falls back to Node's ICU.
  it('accepts a snapshot with and without pluralForms', () => {
    expect(validateSnapshot({ entries: [entry] })).toBeNull();
    expect(
      validateSnapshot({
        entries: [entry],
        pluralForms: { fr: { cardinal: ['one', 'other'], ordinal: ['one', 'other'] }, ja: { cardinal: ['other'], ordinal: ['other'] } },
      }),
    ).toBeNull();
  });

  it('rejects malformed pluralForms', () => {
    const forms = { cardinal: ['one', 'other'], ordinal: ['other'] };
    const check = (pluralForms: unknown) => validateSnapshot({ entries: [], pluralForms });
    expect(check([])).toBe('pluralForms must be an object');
    expect(check({ 'x/..': forms })).toBe('pluralForms key "x/.." is not a valid culture');
    expect(check({ fr: forms, FR: forms })).toMatch(/fr.*FR|FR.*fr/);
    expect(check({ fr: 'one,other' })).toBe('pluralForms.fr must be an object');
    expect(check({ fr: { cardinal: ['one', 'other'] } })).toBe('pluralForms.fr.ordinal must be a non-empty array of plural categories');
    expect(check({ fr: { ...forms, cardinal: [] } })).toBe('pluralForms.fr.cardinal must be a non-empty array of plural categories');
    expect(check({ fr: { ...forms, cardinal: ['one', 'several'] } })).toBe('pluralForms.fr.cardinal must be a non-empty array of plural categories');
    expect(check({ fr: { ...forms, ordinal: [1] } })).toBe('pluralForms.fr.ordinal must be a non-empty array of plural categories');
  });
});

describe('validateAck', () => {
  it('accepts a well-formed ack', () => {
    expect(validateAck({ culture: 'ru', written: [{ unitId: 'u1', translation: 'ПАУЗА' }], rejected: [] })).toBeNull();
  });

  it('reports a written row missing translation', () => {
    expect(validateAck({ culture: 'ru', written: [{ unitId: 'u1' }], rejected: [] })).toBe('written[0] must have string unitId and translation');
  });

  it('reports a rejected row with non-string errors', () => {
    expect(validateAck({ culture: 'ru', written: [], rejected: [{ unitId: 'u1', translation: 'x', errors: [1] }] })).toBe(
      'rejected[0].errors must be a string array',
    );
  });

  it('reports a rejected row missing translation', () => {
    expect(validateAck({ culture: 'ru', written: [], rejected: [{ unitId: 'u1', errors: [] }] })).toBe('rejected[0] must have string unitId and translation');
  });

  it('requires culture, written and rejected', () => {
    expect(validateAck({})).toBe('culture must be a string');
    expect(validateAck({ culture: 'ru' })).toBe('written must be an array');
    expect(validateAck({ culture: 'ru', written: [] })).toBe('rejected must be an array');
  });
});

// Check tiers: approve/edit take an optional `accept`, the confirm issue codes the reviewer saw and approves anyway.
describe('validateAccept', () => {
  it('accepts an absent accept and an array of strings', () => {
    expect(validateAccept({})).toBeNull();
    expect(validateAccept({ accept: [] })).toBeNull();
    expect(validateAccept({ accept: ['args_missing', 'dnt'] })).toBeNull();
  });

  it('rejects anything else', () => {
    expect(validateAccept({ accept: 'args_missing' })).toBe('accept must be an array of strings');
    expect(validateAccept({ accept: [1] })).toBe('accept must be an array of strings');
  });
});
