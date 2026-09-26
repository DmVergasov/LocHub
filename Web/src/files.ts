// File access for glossary Import/Export. Uses the editor binding (window.ue.lochub) when present, and falls
// back to a browser <input type="file"> / Blob download outside the editor tab, feature-detected the same way
// bridge.canSync() is (see bridge.ts).
import type { EditorBridge } from './bridge';

// Windows common-dialog filter syntax, as ULocHubBrowserBridge::PickTextFile/SaveTextFile expect it.
const CSV_FILE_TYPES = 'CSV files (*.csv)|*.csv|All files (*.*)|*.*';
const EXPORT_TITLE = 'Export CSV';

export interface PickedTextFile {
  name: string;
  bytes: Uint8Array;
}

export interface SavedTextFile {
  path?: string;
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Outside the editor tab: a hidden <input type="file">, resolved on its change event, or on its cancel event
// (fired by every browser this app targets when the native file dialog is dismissed without choosing a file).
function pickFileFromBrowser(accept: string): Promise<PickedTextFile | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) {
        resolve(null);
        return;
      }
      // A rejected arrayBuffer() (a removed/unreadable file) must still settle this promise — otherwise the
      // caller's `pickingImport`/`exporting` flag stays stuck forever with no error ever shown.
      void file.arrayBuffer().then(
        (buffer) => resolve({ name: file.name, bytes: new Uint8Array(buffer) }),
        () => resolve(null),
      );
    });
    input.addEventListener('cancel', () => {
      input.remove();
      resolve(null);
    });
    input.click();
  });
}

function downloadInBrowser(name: string, text: string): SavedTextFile {
  // Excel needs a BOM to read a plain .csv as UTF-8; the editor path never adds one here since the editor
  // writes the BOM itself (see ULocHubBrowserBridge::SaveTextFile). Written as the escape, not the literal
  // character: an invisible U+FEFF inside a string literal is indistinguishable from an empty prefix on sight.
  const blob = new Blob(['\uFEFF' + text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  return {};
}

export async function pickTextFile(bridge: EditorBridge, title: string, accept: string): Promise<PickedTextFile | null> {
  if (!bridge.canPickFile()) return pickFileFromBrowser(accept);
  const result = await bridge.pickFile(title, CSV_FILE_TYPES);
  if (result.cancelled) return null;
  return { name: result.name, bytes: base64ToBytes(result.base64) };
}

export async function saveTextFile(bridge: EditorBridge, name: string, text: string): Promise<SavedTextFile | null> {
  if (!bridge.canSaveFile()) return downloadInBrowser(name, text);
  const result = await bridge.saveFile(EXPORT_TITLE, name, CSV_FILE_TYPES, text);
  if (result.cancelled) return null;
  return { path: result.path };
}
