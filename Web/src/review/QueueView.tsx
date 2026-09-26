import { useEffect, useMemo, useRef, useState } from 'react';
import type { LocHubApi } from '../api/client';
import type { Cell, Unit } from '../api/types';
import type { EditorBridge } from '../bridge';
import type { GridRow } from '../grid/model';
import { CellPanel, type CellPanelHandle } from './CellPanel';
import { buildQueue, isTextField, queueAction } from './queue';

export interface QueueViewProps {
  api: LocHubApi;
  bridge: EditorBridge;
  rows: readonly GridRow[];
  culture: string;
  editorConnected: boolean;
  onCell: (cell: Cell) => void;
  onUnit?: (unit: Unit) => void;
}

export function QueueView({ api, bridge, rows, culture, editorConnected, onCell, onUnit }: QueueViewProps) {
  const queue = useMemo(() => buildQueue(rows, culture), [rows, culture]);
  const [index, setIndex] = useState(0);
  const panel = useRef<CellPanelHandle>(null);
  const lastIndex = Math.max(queue.length - 1, 0);

  // The row for the unit currently under review, re-found in a queue that may have just been rebuilt (a reload
  // after a job finishes re-sorts it, and red/needs-fix items can land ahead of wherever the reviewer currently
  // is): keeping the same card (and any in-progress draft) on screen matters more than a fixed numeric slot.
  // `index` is the fallback numeric position, used only once the tracked unit is no longer in the queue at all
  // (approved, rejected, or removed some other way) — the item that naturally slides into that same slot is
  // then shown, same as before this unit-tracking existed.
  const trackedUnitId = useRef<string | undefined>(undefined);
  const trackedIndex = trackedUnitId.current !== undefined ? queue.findIndex((row) => row.unit.id === trackedUnitId.current) : -1;
  const position = trackedIndex >= 0 ? trackedIndex : Math.min(index, lastIndex);
  const current = queue[position];

  useEffect(() => {
    trackedUnitId.current = current?.unit.id;
    setIndex(position);
  }, [position, current]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const inField = isTextField(document.activeElement);
      if (inField && event.key === 'Escape') {
        (document.activeElement as HTMLElement).blur();
        return;
      }
      const action = queueAction(event, inField);
      if (!action) return;
      event.preventDefault();
      const handle = panel.current;
      switch (action) {
        case 'next': {
          const next = Math.min(position + 1, lastIndex);
          trackedUnitId.current = queue[next]?.unit.id;
          setIndex(next);
          break;
        }
        case 'prev': {
          const prev = Math.max(position - 1, 0);
          trackedUnitId.current = queue[prev]?.unit.id;
          setIndex(prev);
          break;
        }
        case 'approve':
          handle?.approve();
          break;
        case 'edit':
          handle?.focusEdit();
          break;
        case 'alt1':
          handle?.pickAlternative(0);
          break;
        case 'alt2':
          handle?.pickAlternative(1);
          break;
        case 'alt3':
          handle?.pickAlternative(2);
          break;
        case 'reject':
          handle?.focusReject();
          break;
        case 'context':
          handle?.focusContext();
          break;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [queue, position, lastIndex]);

  if (!current) return <p className="empty">Nothing to review in {culture}.</p>;
  const neighbors = rows.filter((r) => r.unit.groupKey === current.unit.groupKey && r.unit.id !== current.unit.id).slice(0, 8);
  return (
    <div className="queue">
      <p className="queue-bar">
        {position + 1} / {queue.length} · J/K next/previous · A approve · E edit · 1-3 alternative · R reject · N ask for context · Esc leaves a field
      </p>
      <CellPanel
        key={`${current.unit.id}:${culture}`}
        handleRef={panel}
        api={api}
        bridge={bridge}
        row={current}
        culture={culture}
        editorConnected={editorConnected}
        neighbors={neighbors}
        blind
        onCell={onCell}
        onUnit={onUnit}
      />
    </div>
  );
}
