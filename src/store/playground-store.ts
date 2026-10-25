import { Store } from '../core/store.ts';
import { DEFAULT_FILES, ENTRY, type ProjectFiles } from '../compiler/project.ts';

const STORAGE_KEY = 'tsrs-monaco:project';

export interface PlaygroundState {
  files: ProjectFiles;
  activeFile: string;
}

function load(): PlaygroundState {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (saved?.files && typeof saved.files === 'object') {
      const activeFile = saved.files[saved.activeFile] !== undefined ? saved.activeFile : Object.keys(saved.files)[0];
      return { files: saved.files, activeFile };
    }
  } catch {
    // Storage can be unavailable (private mode) or hold stale data.
  }
  return { files: { ...DEFAULT_FILES }, activeFile: ENTRY };
}

export const playgroundStore = new Store<PlaygroundState>(load());

playgroundStore.addEventListener('change', ((e: CustomEvent<PlaygroundState>) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(e.detail));
  } catch {
    // Ignore quota and privacy errors; persistence is a convenience.
  }
}) as EventListener);

export function resetProject() {
  playgroundStore.setState({ files: { ...DEFAULT_FILES }, activeFile: ENTRY });
}
