import type { GridRow } from '../grid/model';

export type QueueAction = 'next' | 'prev' | 'approve' | 'edit' | 'alt1' | 'alt2' | 'alt3' | 'reject' | 'context';

const KEYMAP: Record<string, QueueAction> = {
  j: 'next',
  k: 'prev',
  a: 'approve',
  e: 'edit',
  '1': 'alt1',
  '2': 'alt2',
  '3': 'alt3',
  r: 'reject',
  n: 'context',
};

// Hotkeys act only while no text field has focus, so typing a translation never approves or rejects it.
export function queueAction(event: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }, inTextField: boolean): QueueAction | undefined {
  if (inTextField || event.ctrlKey || event.metaKey || event.altKey) return undefined;
  return KEYMAP[event.key.toLowerCase()];
}

export function isTextField(element: Element | null): boolean {
  if (!element) return false;
  const tag = element.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (element as HTMLElement).isContentEditable === true;
}

const IN_REVIEW: ReadonlySet<string> = new Set(['ai_draft', 'needs_fix']);
const BAND_RANK: Record<string, number> = { R: 1, Y: 2, G: 3 };

function rank(row: GridRow, culture: string): number {
  const cell = row.cells[culture]?.cell;
  if (!cell) return 9;
  if (cell.status === 'needs_fix') return 0;
  return BAND_RANK[cell.band] ?? 4;
}

// Red, then yellow, then the 3-5% blind-audit greens; other greens ship without review.
export function buildQueue(rows: readonly GridRow[], culture: string): GridRow[] {
  return rows
    .filter((row) => {
      const cell = row.cells[culture]?.cell;
      if (!cell || !IN_REVIEW.has(cell.status)) return false;
      return cell.status === 'needs_fix' || cell.band !== 'G' || cell.qaFlags.includes('audit');
    })
    .sort((a, b) => rank(a, culture) - rank(b, culture));
}
