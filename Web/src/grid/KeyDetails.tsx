import { Fragment, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { Unit } from '../api/types';
import type { EditorBridge } from '../bridge';
import { describeOrigin, originLabel } from '../origin';
import { OriginActions } from '../review/OriginActions';

export interface KeyDetailsProps {
  unit: Unit;
  bridge: EditorBridge;
  editorConnected: boolean;
  // The key button's rect at the moment it was clicked (GridView rows are absolutely positioned and recycled, so
  // the popover is anchored by this snapshot, not by DOM nesting).
  anchor: DOMRect;
  onClose: (reason: 'escape' | 'outside') => void;
}

const POPOVER_WIDTH = 360;
const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP = 4;

// Below the key when the measured popover fits there, above it when it fits there instead; a popover taller than
// either gap is pinned to the bottom edge (never above the top margin) and scrolls inside its CSS max-height.
export function popoverTop(anchor: Pick<DOMRect, 'top' | 'bottom'>, height: number, viewportHeight: number): number {
  const maxTop = Math.max(VIEWPORT_MARGIN, viewportHeight - VIEWPORT_MARGIN - height);
  const below = Math.max(anchor.bottom + ANCHOR_GAP, VIEWPORT_MARGIN);
  if (below <= maxTop) return below;
  const above = anchor.top - ANCHOR_GAP - height;
  if (above >= VIEWPORT_MARGIN) return above;
  return maxTop;
}

function popoverStyle(anchor: DOMRect, height: number): CSSProperties {
  const maxLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - POPOVER_WIDTH - VIEWPORT_MARGIN);
  const left = Math.min(Math.max(anchor.left, VIEWPORT_MARGIN), maxLeft);
  return { position: 'fixed', top: popoverTop(anchor, height, window.innerHeight), left };
}

export function KeyDetails({ unit, bridge, editorConnected, anchor, onClose }: KeyDetailsProps) {
  const [error, setError] = useState('');
  const [height, setHeight] = useState(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const described = describeOrigin(unit.origin);
  const kind = unit.metadata['LocHub.Kind'];
  const otherMetadata = Object.entries(unit.metadata).filter(([metaKey]) => metaKey !== 'LocHub.Kind');

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  // Measured before paint, so a popover that would run off the bottom never shows there for a frame; re-measured
  // when the error line appears.
  useLayoutEffect(() => {
    setHeight(dialogRef.current?.getBoundingClientRect().height ?? 0);
  }, [error]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose('escape');
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (dialogRef.current?.contains(target)) return;
      // A click on another key button is handled by that button's own onClick (open/switch/toggle); do not race it.
      if (target instanceof Element && target.closest('.grid-row .key')) return;
      onClose('outside');
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [onClose]);

  const whereLabel = described.kind === 'asset' ? 'Asset' : described.kind === 'file' ? 'C++ file' : 'Unknown';

  return (
    <div ref={dialogRef} className="key-details" role="dialog" aria-label="Key details" tabIndex={-1} style={popoverStyle(anchor, height)}>
      <dl>
        <dt>Namespace</dt>
        <dd>{unit.namespace || '(none)'}</dd>
        <dt>Key</dt>
        <dd className="key-value">{unit.key}</dd>
        <dt>Where</dt>
        <dd>
          <div>{whereLabel}</div>
          {described.kind === 'asset' && (
            <>
              <div>{described.path}</div>
              <div className="where-member">
                <span className="muted">Member</span> <span>{described.member}</span>
              </div>
            </>
          )}
          {described.kind === 'file' && <div>{originLabel(described)}</div>}
          {described.kind === 'unknown' && <div>{unit.origin || 'unknown'}</div>}
        </dd>
        {kind !== undefined && (
          <>
            <dt>Kind</dt>
            <dd>{kind}</dd>
          </>
        )}
        <dt>Group</dt>
        <dd>{unit.groupKey || 'none'}</dd>
        <dt>Dev notes</dt>
        <dd>{unit.devNotes || 'none'}</dd>
        {otherMetadata.map(([metaKey, value]) => (
          <Fragment key={metaKey}>
            <dt>{metaKey}</dt>
            <dd>{value}</dd>
          </Fragment>
        ))}
      </dl>
      <div className="actions">
        <OriginActions
          unit={unit}
          bridge={bridge}
          editorConnected={editorConnected}
          onBeforeAction={() => setError('')}
          onError={setError}
          openLabel="Open in editor"
          showPath={false}
        />
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
