import { Store } from '../core/store.ts';
import {
  LEGACY_STORAGE_KEY,
  STORAGE_KEY,
  restore,
  type WorkspaceState,
} from '../workspace/workspace.ts';

const SAVE_DELAY_MS = 300;

function read(key: string): unknown {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null');
  } catch {
    // Storage can be unavailable (private mode) or hold stale data.
    return null;
  }
}

export const workspaceStore = new Store<WorkspaceState>(
  restore(read(STORAGE_KEY), read(LEGACY_STORAGE_KEY))
);

// Every keystroke updates the store, so saving is debounced, and flushed
// when the page is hidden or closed.
let saveTimer = 0;
function save() {
  window.clearTimeout(saveTimer);
  saveTimer = 0;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(workspaceStore.getState()));
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    // Ignore quota and privacy errors; persistence is a convenience.
  }
}

workspaceStore.addEventListener('change', () => {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(save, SAVE_DELAY_MS);
});
window.addEventListener('pagehide', () => saveTimer && save());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && saveTimer) save();
});
