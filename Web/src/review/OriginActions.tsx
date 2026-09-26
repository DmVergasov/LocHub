import type { Unit } from '../api/types';
import type { EditorBridge } from '../bridge';
import { errorText } from '../errors';
import { originLabel, parseOrigin } from '../origin';

export interface OriginActionsProps {
  unit: Unit;
  bridge: EditorBridge;
  editorConnected: boolean;
  // Called before an action starts, so the caller can clear its own stale error/notice (CellPanel's clearMessages,
  // e.g.) the same way it already does for its other actions.
  onBeforeAction?: () => void;
  onError: (message: string) => void;
  // Overrides the default "Open <path>" button text (the popover wants a fixed "Open in editor" label instead).
  openLabel?: string;
  // Whether the disconnected branch also renders the path as a <code> element next to "Copy path" (CellPanel's
  // Context row has nowhere else to show the path; the popover already shows it in its own "Where" section).
  showPath?: boolean;
}

// Shared by CellPanel's Context section and the grid's key details popover: "Open in the editor" when a route is
// available, otherwise a copyable path. Nothing is rendered for an origin the editor cannot open (kind 'unknown').
export function OriginActions({ unit, bridge, editorConnected, onBeforeAction, onError, openLabel, showPath = true }: OriginActionsProps) {
  const origin = parseOrigin(unit.origin);
  if (origin.kind === 'unknown') return null;
  const label = originLabel(origin);
  const route = bridge.route(editorConnected);

  const openOrigin = async () => {
    onBeforeAction?.();
    try {
      const opened = await bridge.openOrigin({ unitId: unit.id, namespace: unit.namespace, key: unit.key, origin: unit.origin }, editorConnected);
      if (!opened) onError('The editor could not open this origin.');
    } catch (e) {
      onError(errorText(e));
    }
  };

  const copyPath = () => {
    onBeforeAction?.();
    void navigator.clipboard?.writeText(label).catch(() => onError('Copy failed — select the path and copy it by hand.'));
  };

  if (route !== 'none') {
    return (
      <button type="button" onClick={() => void openOrigin()}>
        {openLabel ?? `Open ${label}`}
      </button>
    );
  }

  return (
    <>
      {showPath && (
        <>
          <code>{label}</code>{' '}
        </>
      )}
      <button type="button" title="The editor is not connected" onClick={copyPath}>
        Copy path
      </button>
    </>
  );
}
