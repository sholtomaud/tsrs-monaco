import { Store } from '../core/store.ts';
import { ENTRY, type ProjectFiles } from '../compiler/project.ts';
import { DEFAULT_EXAMPLE, type Example } from '../examples/index.ts';

const STORAGE_KEY = 'tsrs-monaco:project';

export interface PlaygroundState {
  files: ProjectFiles;
  activeFile: string;
  /** The example the files were loaded from. */
  exampleId: string;
}

function fromExample(example: Example): PlaygroundState {
  return { files: { ...example.files }, activeFile: ENTRY, exampleId: example.id };
}

function load(): PlaygroundState {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (saved?.files && typeof saved.files === 'object') {
      const activeFile = saved.files[saved.activeFile] !== undefined ? saved.activeFile : Object.keys(saved.files)[0];
      return {
        files: saved.files,
        activeFile,
        exampleId: String(saved.exampleId ?? DEFAULT_EXAMPLE.id),
      };
    }
  } catch {
    // Storage can be unavailable (private mode) or hold stale data.
  }
  return fromExample(DEFAULT_EXAMPLE);
}

export const playgroundStore = new Store<PlaygroundState>(load());

playgroundStore.addEventListener('change', ((e: CustomEvent<PlaygroundState>) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(e.detail));
  } catch {
    // Ignore quota and privacy errors; persistence is a convenience.
  }
}) as EventListener);

export function loadExample(example: Example) {
  playgroundStore.setState(fromExample(example));
}
