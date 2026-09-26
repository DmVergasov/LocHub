import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { LocHubApi } from './api/client';
import { App } from './App';
import { EditorBridge } from './bridge';
import './styles.css';

// The editor tab loads "?host=editor" (SLocHubTab::MakePageUrl): dark theme like the editor. Elsewhere follow the OS.
// A theme picked with the header's Toggle theme button (App.tsx ThemeToggle) is stored in localStorage and, once
// set, always wins over that host/OS default.
function readStoredTheme(): string | null {
  try {
    return localStorage.getItem('lochub.theme');
  } catch {
    return null; // storage may be unavailable (private mode, blocked cookies)
  }
}

const isEditorHost = new URLSearchParams(window.location.search).get('host') === 'editor';
const stored = readStoredTheme();
document.documentElement.dataset.theme = stored === 'light' || stored === 'dark' ? stored : isEditorHost ? 'dark' : 'auto';

const api = new LocHubApi();
const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App api={api} bridge={new EditorBridge(api)} />
    </StrictMode>,
  );
}
