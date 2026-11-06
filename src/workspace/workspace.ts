// The workspace: every example is a project folder. The Explorer shows them
// all; the project of the file being edited is the one that is checked,
// compiled and run. Projects keep their own edits, so moving between them
// loses nothing, and Reset restores one project's original files.

import { INDEX_HTML } from '../preview/site.ts';
import { DEFAULT_TSCONFIG, ENTRY, TSCONFIG, entryFile, type ProjectFiles } from '../compiler/project.ts';
import { DEFAULT_EXAMPLE, EXAMPLES, findExample } from '../examples/index.ts';
import { PLAYGROUND_DTS } from '../examples/playground-dts.ts';

export interface OpenFile {
  project: string;
  path: string;
}

/** A project folder the user made (examples are the others). */
export interface UserProject {
  id: string;
  /** Created from: a template, or the project it duplicates. */
  from: string;
}

export interface WorkspaceState {
  /** Files of each project that has been opened; the others are their example's. */
  projects: Record<string, ProjectFiles>;
  /** The user's own projects, in the order they were made. */
  userProjects: UserProject[];
  /** The project that is checked, compiled and run. */
  activeProject: string;
  /** Open editor tabs, in order. */
  tabs: OpenFile[];
  /** The tab in the editor, or null when every tab is closed. */
  activeTab: OpenFile | null;
  /** Expanded folders in the Explorer, by node id. */
  expanded: string[];
  sidebarVisible: boolean;
  sidebarWidth: number;
  panelVisible: boolean;
  /** The output panel's share of the width beside the editor. */
  panelFraction: number;
}

export const STORAGE_KEY = 'tsrs-monaco:workspace';
/** Where the single-project playground kept its files. */
export const LEGACY_STORAGE_KEY = 'tsrs-monaco:project';

export const SIDEBAR_WIDTH = { min: 170, default: 260, max: 520 };
export const PANEL_FRACTION = { min: 0.2, default: 0.42, max: 0.8 };

/** Tree node id: "project" or "project/dir/file". */
export const nodeId = (project: string, path = '') => (path ? `${project}/${path}` : project);

export const sameFile = (a: OpenFile | null, b: OpenFile | null) =>
  !!a && !!b && a.project === b.project && a.path === b.path;

export function projectTitle(project: string, state?: WorkspaceState): string {
  const mine = state?.userProjects.find((p) => p.id === project);
  if (mine) return mine.from.startsWith('template:') ? `My project (${mine.from.slice(9)})` : `Copy of ${mine.from}`;
  return findExample(project)?.title ?? project;
}

export const isExample = (project: string) => !!findExample(project);

/** Every project folder: the user's first, then the examples. */
export function projectIds(state: WorkspaceState): string[] {
  return [...state.userProjects.map((p) => p.id), ...EXAMPLES.map((e) => e.id)];
}

export type Template = 'blank' | 'fluxkit';

/** The files a new project starts with. */
export function templateFiles(template: Template, name: string): ProjectFiles {
  const index =
    template === 'fluxkit'
      ? `import * as fx from 'fluxkit';

// A fluxkit model: write the rates as plain TypeScript. Each swept value is
// one run (one GPU thread when this browser has WebGPU).
const decay = new fx.Model('${name}', {
  params: { k: fx.sweep(0.1, 1, 10) },
  state: { x: 1 },
  rates: (s, p) => ({ x: -p.k * s.x }),
  outputs: (s) => ({ remaining: s.x }),
  dt: 0.01,
  tEnd: 5,
});

const run = await decay.run();
console.info(\`\${run.rows.length} runs on \${run.description}\`);
plot({ name: 'x(5)', points: run.series('k', 'remaining') }, { title: 'Exponential decay', xLabel: 'k', yLabel: 'x at t = 5' });
`
      : `// ${name}: press Run (Ctrl/⌘ + Enter). Add files from the Explorer.
console.log('Hello from ${name}');
`;
  return { [TSCONFIG]: DEFAULT_TSCONFIG, [ENTRY]: index, 'src/playground.d.ts': PLAYGROUND_DTS };
}

/** A new project folder's name, or why it can't be used. */
export function checkProjectName(input: string, state: WorkspaceState): { id: string } | { error: string } {
  const id = input.trim();
  if (!id) return { error: 'A project name must be provided.' };
  if (!/^[A-Za-z0-9][\w.-]*$/.test(id)) {
    return { error: 'Use letters, digits, -, _ and . (starting with a letter or digit).' };
  }
  if (id.length > 64) return { error: 'Keep the name under 64 characters.' };
  if (projectIds(state).some((p) => p.toLowerCase() === id.toLowerCase())) {
    return { error: `A project ${id} already exists.` };
  }
  return { id };
}

/** A free name like base-2 for a copy. */
export function freeProjectName(base: string, state: WorkspaceState): string {
  const taken = new Set(projectIds(state).map((p) => p.toLowerCase()));
  for (let i = 1; ; i++) {
    const name = i === 1 ? base : `${base}-${i}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

/** A fresh workspace: the default example open at its entry file. */
export function initialState(): WorkspaceState {
  const project = DEFAULT_EXAMPLE.id;
  const files = { ...DEFAULT_EXAMPLE.files };
  const entry = { project, path: entryFile(files) };
  return {
    projects: { [project]: files },
    userProjects: [],
    activeProject: project,
    tabs: [entry],
    activeTab: entry,
    expanded: [nodeId(project), ...parentFolders(project, entry.path)],
    sidebarVisible: true,
    sidebarWidth: SIDEBAR_WIDTH.default,
    panelVisible: true,
    panelFraction: PANEL_FRACTION.default,
  };
}

/** Node ids of the folders that contain `path`. */
export function parentFolders(project: string, path: string): string[] {
  const parts = path.split('/').slice(0, -1);
  return parts.map((_, i) => nodeId(project, parts.slice(0, i + 1).join('/')));
}

/** The files of a project: its edited copy, or its example's originals. */
export function projectFiles(state: WorkspaceState, project: string): ProjectFiles {
  return state.projects[project] ?? { ...findExample(project)?.files };
}

const clamp = (n: unknown, { min, max, default: d }: { min: number; max: number; default: number }) =>
  typeof n === 'number' && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;

const isOpenFile = (value: unknown): value is OpenFile =>
  !!value &&
  typeof (value as OpenFile).project === 'string' &&
  typeof (value as OpenFile).path === 'string';

/**
 * Restores a saved workspace, dropping anything that no longer exists (a
 * removed example, a deleted file), or migrates the single-project
 * playground's storage. Falls back to a fresh workspace.
 */
export function restore(saved: unknown, legacy?: unknown): WorkspaceState {
  const fresh = initialState();
  const known = new Set(EXAMPLES.map((e) => e.id));

  if (saved && typeof saved === 'object' && (saved as WorkspaceState).projects) {
    const s = saved as Partial<WorkspaceState>;
    const projects: Record<string, ProjectFiles> = {};
    // The user's projects that still have their files.
    const userProjects = (Array.isArray(s.userProjects) ? s.userProjects : []).filter(
      (p): p is UserProject =>
        !!p && typeof p.id === 'string' && typeof p.from === 'string' && !known.has(p.id) &&
        !!s.projects?.[p.id] && typeof s.projects[p.id] === 'object'
    );
    for (const p of userProjects) known.add(p.id);
    for (const [id, files] of Object.entries(s.projects ?? {})) {
      if (known.has(id) && files && typeof files === 'object') projects[id] = files;
    }
    const exists = (f: OpenFile) => {
      const files = projects[f.project];
      return !!files && typeof files[f.path] === 'string';
    };
    const tabs = (Array.isArray(s.tabs) ? s.tabs : []).filter(isOpenFile).filter(exists);
    const activeTab = isOpenFile(s.activeTab) && tabs.some((t) => sameFile(t, s.activeTab!)) ? s.activeTab : (tabs[0] ?? null);
    const activeProject =
      activeTab?.project ??
      (typeof s.activeProject === 'string' && known.has(s.activeProject) ? s.activeProject : fresh.activeProject);
    if (!projects[activeProject]) projects[activeProject] = projectFiles(fresh, activeProject);
    return {
      projects,
      userProjects,
      activeProject,
      tabs,
      activeTab,
      expanded: Array.isArray(s.expanded) ? s.expanded.filter((x): x is string => typeof x === 'string') : fresh.expanded,
      sidebarVisible: s.sidebarVisible !== false,
      sidebarWidth: clamp(s.sidebarWidth, SIDEBAR_WIDTH),
      panelVisible: s.panelVisible !== false,
      panelFraction: clamp(s.panelFraction, PANEL_FRACTION),
    };
  }

  // The single-project playground: { files, activeFile, exampleId }.
  const old = legacy as { files?: unknown; activeFile?: unknown; exampleId?: unknown } | undefined;
  if (old?.files && typeof old.files === 'object') {
    const project = typeof old.exampleId === 'string' && known.has(old.exampleId) ? old.exampleId : DEFAULT_EXAMPLE.id;
    const files = old.files as ProjectFiles;
    const path =
      typeof old.activeFile === 'string' && typeof files[old.activeFile] === 'string'
        ? old.activeFile
        : entryFile(files);
    const tab = typeof files[path] === 'string' ? { project, path } : null;
    return {
      ...fresh,
      projects: { [project]: files },
      activeProject: project,
      tabs: tab ? [tab] : [],
      activeTab: tab,
      expanded: [nodeId(project), ...(tab ? parentFolders(project, tab.path) : [])],
    };
  }
  return fresh;
}

/** Files a project can't build without. */
export function isProtected(files: ProjectFiles, path: string): boolean {
  return path === TSCONFIG || path === INDEX_HTML || path === entryFile(files);
}

export interface FileNode {
  kind: 'file';
  id: string;
  name: string;
  path: string;
}

export interface FolderNode {
  kind: 'folder';
  id: string;
  name: string;
  /** '' for the project root. */
  path: string;
  children: TreeNode[];
}

export type TreeNode = FileNode | FolderNode;

/** A project's files as a tree: folders first, then files, each A–Z. */
export function buildTree(project: string, files: ProjectFiles): FolderNode {
  const root: FolderNode = { kind: 'folder', id: nodeId(project), name: project, path: '', children: [] };
  for (const path of Object.keys(files)) {
    const parts = path.split('/');
    let folder = root;
    parts.slice(0, -1).forEach((name, i) => {
      const folderPath = parts.slice(0, i + 1).join('/');
      let next = folder.children.find(
        (c): c is FolderNode => c.kind === 'folder' && c.name === name
      );
      if (!next) {
        next = { kind: 'folder', id: nodeId(project, folderPath), name, path: folderPath, children: [] };
        folder.children.push(next);
      }
      folder = next;
    });
    folder.children.push({ kind: 'file', id: nodeId(project, path), name: parts[parts.length - 1], path });
  }
  const sort = (folder: FolderNode) => {
    folder.children.sort((a, b) =>
      a.kind !== b.kind ? (a.kind === 'folder' ? -1 : 1) : a.name.localeCompare(b.name, undefined, { numeric: true })
    );
    folder.children.forEach((c) => c.kind === 'folder' && sort(c));
  };
  sort(root);
  return root;
}

/**
 * Normalises a name typed into the Explorer, relative to `folder`. A name
 * without an extension becomes a .ts file. Returns an error message for
 * names that can't be used.
 */
export function resolveNewPath(
  folder: string,
  input: string,
  files: ProjectFiles
): { path: string } | { error: string } {
  const name = input.trim();
  if (!name) return { error: 'A file name must be provided.' };
  if (/[\\:*?"<>|]/.test(name)) return { error: `The name "${name}" contains characters that can't be used.` };
  const parts = [...folder.split('/'), ...name.split('/')].filter(Boolean);
  if (parts.some((p) => p === '.' || p === '..')) return { error: "A file name can't contain '.' or '..' folders." };
  if (!parts.length) return { error: 'A file name must be provided.' };
  const last = parts[parts.length - 1];
  if (!/\.[A-Za-z0-9]+$/.test(last)) parts[parts.length - 1] = `${last}.ts`;
  const path = parts.join('/');
  if (typeof files[path] === 'string') return { error: `A file ${path} already exists.` };
  if (Object.keys(files).some((f) => f.startsWith(`${path}/`))) {
    return { error: `A folder ${path} already exists.` };
  }
  return { path };
}

/** Labels for tabs: the file name, plus its folder where names clash. */
export function tabLabels(tabs: OpenFile[]): { name: string; description: string }[] {
  const names = tabs.map((t) => t.path.split('/').pop()!);
  return tabs.map((tab, i) => {
    const clash = names.some((n, j) => j !== i && n === names[i]);
    const dir = tab.path.split('/').slice(0, -1).join('/');
    const sameName = tabs.filter((_, j) => names[j] === names[i]);
    const projects = new Set(sameName.map((t) => t.project));
    const description = !clash
      ? ''
      : projects.size > 1
        ? [tab.project, dir].filter(Boolean).join('/')
        : dir || tab.project;
    return { name: names[i], description };
  });
}
