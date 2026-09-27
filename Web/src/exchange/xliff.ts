// XLIFF 1.2 for the translation exchange (CAT tools: Trados, memoQ, Phrase, Crowdin), built and read with the
// browser's own DOMParser and XMLSerializer. Pure apart from those: file picking and saving live in ../files.
import { EXPORTED_AT_PATTERN } from '../../../Service/src/contract';
import type { CellRow, ImportEntry } from '../api/types';
import { splitInlineCodes } from './inline';
import { exportStatus, sameCulture, type ParsedImport } from './model';

export const XLIFF_NS = 'urn:oasis:names:tc:xliff:document:1.2';
export const LOCHUB_NS = 'urn:lochub:xliff';
const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';

const TARGET_STATE: Record<string, string> = {
  ai_draft: 'needs-review-translation',
  needs_fix: 'needs-review-translation',
  edited: 'translated',
  human_edit: 'translated',
  approved: 'final',
  rejected: 'needs-translation',
  outdated: 'needs-translation',
};

// Characters XML 1.0 cannot carry at all, not even as a character reference.
const XML_INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// Inline codes a source segment protects, and the empty CAT-tool forms of them resolved by id on import.
const CODE_ELEMENTS: ReadonlySet<string> = new Set(['ph', 'x', 'bx', 'ex', 'it', 'bpt', 'ept']);
const EMPTY_BY_ID: ReadonlySet<string> = new Set(['x', 'bx', 'ex']);
// A CAT tool that pre-fills untranslated targets with the source ("copy source to target") leaves them in these states.
const COPY_SOURCE_STATES: ReadonlySet<string> = new Set(['new', 'needs-translation']);

export interface XliffExportOptions {
  culture: string;
  sourceCulture: string;
  // ISO 8601 UTC; the import's conflict check by date compares cell events against it.
  date: string;
}

interface SourceCode {
  id: number;
  text: string;
}

function element(doc: XMLDocument, name: string, attributes: Record<string, string> = {}): Element {
  const el = doc.createElementNS(XLIFF_NS, name);
  for (const [attribute, value] of Object.entries(attributes)) el.setAttribute(attribute, value);
  return el;
}

// Source codes are numbered 1..n in order. A target code reuses the id of the first unused source code with the
// same text (CAT tools match codes across source and target by id); a code the source lacks gets the next id.
function appendSegment(doc: XMLDocument, parent: Element, text: string, sourceCodes: readonly SourceCode[] | null): SourceCode[] {
  const codes: SourceCode[] = [];
  const unused = sourceCodes ? [...sourceCodes] : [];
  let nextId = sourceCodes ? sourceCodes.length : 0;
  for (const part of splitInlineCodes(text)) {
    if (!part.code) {
      parent.appendChild(doc.createTextNode(part.text));
      continue;
    }
    const match = unused.findIndex((code) => code.text === part.text);
    const id = match >= 0 ? unused.splice(match, 1)[0]!.id : ++nextId;
    const ph = element(doc, 'ph', { id: String(id) });
    ph.textContent = part.text;
    parent.appendChild(ph);
    codes.push({ id, text: part.text });
  }
  return codes;
}

export function exchangeToXliff(rows: readonly CellRow[], options: XliffExportOptions): string {
  const broken = rows.filter((row) => [row.unit.source, row.cell.text, row.unit.devNotes, row.unit.origin].some((text) => XML_INVALID.test(text)));
  if (broken.length > 0) {
    const names = broken.slice(0, 5).map((row) => `${row.unit.namespace}/${row.unit.key}`).join(', ');
    throw new Error(
      `XLIFF cannot store the control characters in ${broken.length} string(s) (${names}${broken.length > 5 ? ', …' : ''}). Export CSV instead, or filter these strings out.`,
    );
  }
  const doc = document.implementation.createDocument(XLIFF_NS, 'xliff', null);
  const root = doc.documentElement;
  root.setAttribute('version', '1.2');
  root.setAttributeNS(XMLNS_NS, 'xmlns:lochub', LOCHUB_NS);
  const file = element(doc, 'file', {
    original: `LocHub/${options.culture}`,
    'source-language': options.sourceCulture,
    'target-language': options.culture,
    datatype: 'plaintext',
    date: options.date,
  });
  const body = element(doc, 'body');
  for (const row of rows) {
    const status = exportStatus(row);
    const unit = element(doc, 'trans-unit', { id: row.unit.id, resname: `${row.unit.namespace}/${row.unit.key}` });
    // A CAT tool is otherwise free to normalize whitespace; game strings rely on double spaces, leading/trailing
    // spaces and line breaks, so a normalized <source> must not read back as "stale".
    unit.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve');
    // Always written, including 0 for a string that was empty at export: the import's conflict check (the conflict
    // rule) needs the revision to notice a LocHub write made after the export to a string that was empty then.
    unit.setAttributeNS(LOCHUB_NS, 'lochub:revision', String(row.cell.revision));
    const limit = row.lengthLimit ?? null;
    if (limit !== null) {
      unit.setAttribute('maxwidth', String(limit));
      unit.setAttribute('size-unit', 'char');
    }
    if (status === 'approved') unit.setAttribute('approved', 'yes');
    const source = element(doc, 'source');
    const codes = appendSegment(doc, source, row.unit.source, null);
    unit.appendChild(source);
    if (row.cell.text.length > 0) {
      const target = element(doc, 'target', { state: TARGET_STATE[status] ?? 'needs-review-translation' });
      appendSegment(doc, target, row.cell.text, codes);
      unit.appendChild(target);
    }
    if (row.unit.devNotes) {
      const developer = element(doc, 'note', { from: 'developer' });
      developer.textContent = row.unit.devNotes;
      unit.appendChild(developer);
    }
    const location = element(doc, 'note', { from: 'location' });
    location.textContent = row.unit.origin;
    unit.appendChild(location);
    body.appendChild(doc.createTextNode('\n'));
    body.appendChild(unit);
  }
  body.appendChild(doc.createTextNode('\n'));
  file.appendChild(body);
  root.appendChild(file);
  // An XML parser turns a raw CR into LF, so a CR in a string travels as a character reference.
  const xml = new XMLSerializer().serializeToString(doc).replace(/\r/g, '&#13;');
  return `<?xml version="1.0" encoding="UTF-8"?>\n${xml}\n`;
}

function childElement(parent: Element, name: string): Element | undefined {
  return Array.from(parent.children).find((child) => child.localName === name);
}

function descendants(parent: Element | Document, name: string): Element[] {
  return Array.from(parent.getElementsByTagName('*')).filter((el) => el.localName === name);
}

// The plain text of a segment: text and CDATA as written, every inline element unwrapped to its text (<g>, <mrk>,
// <ph>, <it>, ...), and an empty <x>/<bx>/<ex> replaced by the source code with the same id.
function segmentText(node: Element, sourceCodes: ReadonlyMap<string, string>): string {
  let out = '';
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE || child.nodeType === Node.CDATA_SECTION_NODE) out += child.nodeValue ?? '';
    else if (child.nodeType === Node.ELEMENT_NODE) {
      const el = child as Element;
      const inner = segmentText(el, sourceCodes);
      out += inner === '' && EMPTY_BY_ID.has(el.localName) ? (sourceCodes.get(el.getAttribute('id') ?? '') ?? '') : inner;
    }
  }
  return out;
}

function codesById(source: Element): Map<string, string> {
  const codes = new Map<string, string>();
  for (const el of Array.from(source.getElementsByTagName('*'))) {
    const id = el.getAttribute('id');
    if (id !== null && CODE_ELEMENTS.has(el.localName) && !codes.has(id)) codes.set(id, segmentText(el, new Map()));
  }
  return codes;
}

export function readXliff(text: string, culture: string): ParsedImport {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) throw new Error('The file is not valid XML, so it cannot be read as XLIFF.');
  const root = doc.documentElement;
  if (root.localName !== 'xliff') throw new Error('The file is not XLIFF (no <xliff> root element).');
  const version = root.getAttribute('version') ?? '';
  if (version !== '' && !version.startsWith('1.')) throw new Error(`XLIFF ${version} is not supported. Export XLIFF 1.2 from your translation tool.`);

  const entries: ImportEntry[] = [];
  const labels: string[] = [];
  const copyOfSource: boolean[] = [];
  for (const file of descendants(root, 'file')) {
    const target = file.getAttribute('target-language');
    if (target && !sameCulture(target, culture)) throw new Error(`This file is for ${target}, not ${culture}. Switch the Grid to ${target} or pick the ${culture} file.`);
    const date = file.getAttribute('date');
    // A CAT tool can rewrite <file date> in a shape POST /api/import would refuse (a plain date, a space instead of
    // "T", a numeric offset with no colon); dropping it here loses only the date-based conflict check, never the
    // whole import, and lochub:revision still catches every conflict a translator's exportedAt would have.
    const exportedAt = date && EXPORTED_AT_PATTERN.test(date) && !Number.isNaN(Date.parse(date)) ? date : undefined;
    for (const unit of descendants(file, 'trans-unit')) {
      const sourceEl = childElement(unit, 'source');
      const targetEl = childElement(unit, 'target');
      const codes = sourceEl ? codesById(sourceEl) : new Map<string, string>();
      const source = sourceEl ? segmentText(sourceEl, codes) : undefined;
      let translation = targetEl ? segmentText(targetEl, codes) : '';
      // A pre-filled copy of the source is not a translation: importing it would write English as human work.
      const isCopyOfSource = targetEl !== undefined && translation === source && COPY_SOURCE_STATES.has(targetEl.getAttribute('state') ?? '');
      if (isCopyOfSource) translation = '';
      const entry: ImportEntry = { text: translation, approved: unit.getAttribute('approved') === 'yes' };
      const id = unit.getAttribute('id');
      if (id) entry.unitId = id;
      if (source !== undefined) entry.source = source;
      const revision = unit.getAttributeNS(LOCHUB_NS, 'revision');
      if (revision !== null && /^\d+$/.test(revision)) entry.exportedRevision = Number(revision);
      if (exportedAt) entry.exportedAt = exportedAt;
      entries.push(entry);
      labels.push(unit.getAttribute('resname') || id || `Unit ${entries.length}`);
      copyOfSource.push(isCopyOfSource);
    }
  }
  return { format: 'xliff', entries, labels, ignoredColumns: [], copyOfSource };
}
