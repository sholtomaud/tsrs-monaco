import { BaseComponent } from '../../core/base-component.ts';
import { Router } from '../../core/router/router.ts';
import { monaco, languageOf } from '../../editor/monaco.ts';
import { getCompiler } from '../../compiler/compiler.ts';
import {
  TEST_FILE,
  entryFile,
  isSourceFile,
  outputPathFor,
  type ProjectFiles,
} from '../../compiler/project.ts';
import type { CompileResult } from '../../compiler/protocol.ts';
import {
  toProblem,
  type Problem,
  type Severity,
} from '../../compiler/diagnostics.ts';
import { Runner } from '../../runtime/runner.ts';
import { renderChart } from '../../runtime/chart.ts';
import type { RunMessage, RunRequest, TestResult } from '../../runtime/protocol.ts';
import { EXAMPLES, findExample } from '../../examples/index.ts';
import { workspaceStore } from '../../store/workspace-store.ts';
import {
  PANEL_FRACTION,
  SIDEBAR_WIDTH,
  buildTree,
  checkProjectName,
  freeProjectName,
  isExample,
  projectIds,
  templateFiles,
  type Template,
  isProtected,
  nodeId,
  parentFolders,
  projectFiles,
  projectTitle,
  resolveNewPath,
  sameFile,
  tabLabels,
  type FolderNode,
  type OpenFile,
  type TreeNode,
  type WorkspaceState,
} from '../../workspace/workspace.ts';
import { CODICON, codicon, fileIcon, type CodiconName } from '../../workspace/icons.ts';
import { keys, showMenu, type MenuEntry } from '../../workspace/menu.ts';
import {
  getPackageManager,
  projectImports,
} from '../../packages/package-manager.ts';
import type { Acquisition } from '../../packages/type-acquisition.ts';
import { publish } from '../../preview/preview-client.ts';
import {
  INDEX_HTML,
  contentSecurityPolicy,
  importOrigins,
  isWebApp,
  type PreviewConsoleMessage,
} from '../../preview/site.ts';
import tsrsPackage from '@tsrs/wasm/package.json' with { type: 'json' };
import template from './playground-page.html?raw';
import style from './playground-page.css?raw';

const CHECK_DELAY_MS = 400;

const MARKER_SEVERITY: Record<Severity, monaco.MarkerSeverity> = {
  error: monaco.MarkerSeverity.Error,
  warning: monaco.MarkerSeverity.Warning,
  info: monaco.MarkerSeverity.Info,
  hint: monaco.MarkerSeverity.Hint,
};

type Panel = 'console' | 'preview' | 'tests' | 'plot' | 'js' | 'problems';
type Mode = RunRequest['mode'];
type StatusState = 'loading' | 'ready' | 'busy' | 'error';

/** An inline name box in the Explorer: a new file, or renaming one. */
type Editing =
  | { kind: 'new'; project: string; folder: string }
  | { kind: 'rename'; project: string; path: string }
  | { kind: 'project'; from: { template: Template } | { project: string }; suggested: string };

/** What a project's output panels showed when another project took over. */
interface SavedOutput {
  console: Node[];
  plots: Node[];
  tests: Node[];
  summary: string;
  count: string;
  severity: string;
}

const TEST_HINT = "Press Test to run the project's *.test.ts files with test() and expect().";

const modelKey = (project: string, path: string) => `${project}\u0000${path}`;

export class PlaygroundPageComponent extends BaseComponent {
  static tagName = 'playground-page';

  private editor!: monaco.editor.IStandaloneCodeEditor;
  private output!: monaco.editor.IStandaloneCodeEditor;
  private models = new Map<string, monaco.editor.ITextModel>();
  private modelListeners = new Map<string, monaco.IDisposable>();
  private viewStates = new Map<string, monaco.editor.ICodeEditorViewState | null>();
  private compiler = getCompiler();
  private packages = getPackageManager();
  private acquisition: Acquisition = { files: {}, versions: {}, errors: [] };
  private runner = new Runner();
  private checkTimer = 0;
  private checkSeq = 0;
  private runAfterCheck: Mode | null = null;
  private plotted = false;
  private mode: Mode = 'run';
  private lastResult: CompileResult | null = null;
  private previewSeq = 0;
  /** Worst problem per file of the active project, for the Explorer. */
  private problemFiles = new Map<string, 'error' | 'warning'>();
  /** The Explorer row with the keyboard selection. */
  private selected: string | null = null;
  private editing: Editing | null = null;
  /** Each project's last console, plots and test results, kept when switching. */
  private savedOutputs = new Map<string, SavedOutput>();
  private onPreviewMessage = (e: MessageEvent<PreviewConsoleMessage>) => {
    const frame = this.$<HTMLIFrameElement>('#preview-frame');
    if (e.source !== frame.contentWindow || e.data?.source !== 'tsrs-preview') return;
    this.log(e.data.level, e.data.text);
  };
  private onCompilerReady = (e: Event) => {
    if (this.lastResult) return;
    const ms = Math.round((e as CustomEvent<number>).detail);
    this.$('#stats').textContent = `tsrs.wasm compiled in ${ms} ms`;
  };
  private onKeydown = (e: KeyboardEvent) => this.handleShortcut(e);

  constructor() {
    super(template, style);
  }

  init() {
    this.$('#version').textContent =
      `@tsrs/wasm ${tsrsPackage.version.replace(/-ts.*/, '')} · TypeScript ${tsrsPackage.tsrs.typescriptVersion}`;
    this.renderIcons();

    const common: monaco.editor.IStandaloneEditorConstructionOptions = {
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 14,
      tabSize: 2,
      scrollBeyondLastLine: false,
      fixedOverflowWidgets: true,
      padding: { top: 8 },
      smoothScrolling: true,
      stickyScroll: { enabled: false },
      overviewRulerBorder: false,
    };
    this.editor = monaco.editor.create(this.$('#editor'), { ...common, model: null });
    this.output = monaco.editor.create(this.$('#js-output'), {
      ...common,
      readOnly: true,
      language: 'javascript',
      lineNumbers: 'off',
      renderLineHighlight: 'none',
    });

    const state = this.ws();
    this.ensureProject(state.activeProject);
    for (const tab of state.tabs) this.ensureProject(tab.project);
    this.selected = state.activeTab ? nodeId(state.activeTab.project, state.activeTab.path) : null;
    this.applyLayout();
    this.showTab(state.activeTab);

    this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => this.run());
    this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter, () =>
      this.run('test')
    );
    this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyB, () => this.toggleSidebar());
    this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyJ, () => this.togglePanel());
    // The same shortcuts when focus is outside the editor.
    document.addEventListener('keydown', this.onKeydown);

    this.$('#run').addEventListener('click', () => this.run());
    this.$('#test').addEventListener('click', () => this.run('test'));
    this.$('#stop').addEventListener('click', () => this.stop());
    this.$('#toggle-panel').addEventListener('click', () => this.togglePanel());
    this.$('#add-file').addEventListener('click', () => this.startNewFile());
    this.$('#add-project').addEventListener('click', () => this.startNewProject({ template: 'blank' }));
    this.$('#collapse-all').addEventListener('click', () => this.collapseAll());
    this.$('#view-explorer').addEventListener('click', () => this.toggleSidebar());
    this.$('#menu-button').addEventListener('click', () => this.openAppMenu());
    this.$('#status-problems').addEventListener('click', () => {
      this.setPanelVisible(true);
      this.showPanel('problems');
    });
    this.$<HTMLAnchorElement>('#about-link').addEventListener('click', (e) => {
      e.preventDefault();
      Router.getInstance().navigate('/about');
    });
    this.querySelectorAll<HTMLElement>('.tabs [data-panel]').forEach((tab) =>
      tab.addEventListener('click', () => this.showPanel(tab.dataset.panel as Panel))
    );
    this.initExplorer();
    this.initSashes();

    this.compiler.addEventListener('ready', this.onCompilerReady);
    window.addEventListener('message', this.onPreviewMessage);
    this.setStatus('loading', 'Loading tsrs.wasm…');
    this.check();
  }

  disconnectedCallback() {
    window.clearTimeout(this.checkTimer);
    this.compiler.removeEventListener('ready', this.onCompilerReady);
    window.removeEventListener('message', this.onPreviewMessage);
    document.removeEventListener('keydown', this.onKeydown);
    this.runner.stop();
    this.modelListeners.forEach((d) => d.dispose());
    this.models.forEach((m) => m.dispose());
    this.models.clear();
    this.modelListeners.clear();
    this.editor?.dispose();
    this.output?.dispose();
  }

  private $<T extends HTMLElement = HTMLElement>(selector: string): T {
    return this.querySelector<T>(selector)!;
  }

  private ws(): WorkspaceState {
    return workspaceStore.getState();
  }

  /** The files of the active project (the one that is checked and run). */
  private files(): ProjectFiles {
    const state = this.ws();
    return projectFiles(state, state.activeProject);
  }

  private entry(): string {
    return entryFile(this.files());
  }

  private renderIcons() {
    this.querySelectorAll<HTMLElement>('[data-icon]').forEach((el) => {
      el.prepend(codicon(el.dataset.icon as CodiconName));
    });
    this.querySelectorAll<HTMLElement>('[data-glyph]').forEach((el) => {
      el.textContent = CODICON[el.dataset.glyph as CodiconName];
    });
    this.querySelectorAll<HTMLElement>('[data-keys]').forEach((el) => {
      el.replaceChildren(
        ...keys(el.dataset.keys!)
          .split(/\+|(?<=[⌘⇧⌥])/)
          .filter(Boolean)
          .map((k) => Object.assign(document.createElement('kbd'), { textContent: k }))
      );
    });
  }

  // ---- Projects and models -----------------------------------------------------

  /** Creates the project's models, copying its example's files the first time. */
  private ensureProject(project: string) {
    const state = this.ws();
    if (!state.projects[project]) {
      workspaceStore.setState({
        projects: { ...state.projects, [project]: projectFiles(state, project) },
      });
    }
    for (const [path, text] of Object.entries(projectFiles(this.ws(), project))) {
      if (!this.models.has(modelKey(project, path))) this.createModel(project, path, text);
    }
  }

  private createModel(project: string, path: string, text: string) {
    const key = modelKey(project, path);
    const model = monaco.editor.createModel(
      text,
      languageOf(path),
      monaco.Uri.from({ scheme: 'file', path: `/workspace/${project}/${path}` })
    );
    this.modelListeners.set(
      key,
      model.onDidChangeContent(() => {
        const state = this.ws();
        const files = projectFiles(state, project);
        workspaceStore.setState({
          projects: { ...state.projects, [project]: { ...files, [path]: model.getValue() } },
        });
        if (project === state.activeProject) this.scheduleCheck();
      })
    );
    this.models.set(key, model);
    return model;
  }

  private disposeModel(project: string, path: string) {
    const key = modelKey(project, path);
    this.modelListeners.get(key)?.dispose();
    this.modelListeners.delete(key);
    this.models.get(key)?.dispose();
    this.models.delete(key);
    this.viewStates.delete(key);
  }

  private setProjectFiles(project: string, files: ProjectFiles) {
    const state = this.ws();
    workspaceStore.setState({ projects: { ...state.projects, [project]: files } });
  }

  /** Makes `project` the one that is checked and run. */
  private activateProject(project: string) {
    if (project === this.ws().activeProject) return;
    this.stop(true);
    this.ensureProject(project);
    this.saveOutputs(this.ws().activeProject);
    workspaceStore.setState({ activeProject: project });
    this.lastResult = null;
    this.problemFiles.clear();
    this.restoreOutputs(project);
    this.check();
  }

  /** Keeps a project's output panels, so switching back shows what it last printed and drew. */
  private saveOutputs(project: string) {
    const badge = this.$('#test-count');
    this.savedOutputs.set(project, {
      console: [...this.$('#console').childNodes],
      plots: [...this.$('#plots').childNodes],
      tests: [...this.$('#tests').childNodes],
      summary: this.$('#test-summary').textContent ?? '',
      count: badge.textContent ?? '0',
      severity: badge.dataset.severity ?? '',
    });
  }

  private restoreOutputs(project: string) {
    const saved = this.savedOutputs.get(project);
    const badge = this.$('#test-count');
    if (saved) {
      this.$('#console').replaceChildren(...saved.console);
      this.$('#plots').replaceChildren(...saved.plots);
      this.$('#tests').replaceChildren(...saved.tests);
      this.$('#test-summary').textContent = saved.summary;
      badge.textContent = saved.count;
      badge.dataset.severity = saved.severity;
      return;
    }
    this.clearConsole();
    this.log('system', `Project: ${project} (${projectTitle(project, this.ws())}). Press Run (Ctrl/⌘ + Enter).`);
    const caption = Object.assign(document.createElement('p'), {
      className: 'panel-caption',
      textContent: `Call plot() from ${project}'s code to draw charts here.`,
    });
    this.$('#plots').replaceChildren(caption);
    this.$('#tests').replaceChildren();
    this.$('#test-summary').textContent = TEST_HINT;
    this.setTestCount(0, 0);
  }

  // ---- Tabs ------------------------------------------------------------------------

  /** Opens a file in the editor, adding a tab after the current one. */
  private openFile(file: OpenFile, { focus = false } = {}) {
    this.ensureProject(file.project);
    if (!this.models.has(modelKey(file.project, file.path))) return;
    const state = this.ws();
    let tabs = state.tabs;
    if (!tabs.some((t) => sameFile(t, file))) {
      const at = state.activeTab ? tabs.findIndex((t) => sameFile(t, state.activeTab)) + 1 : tabs.length;
      tabs = [...tabs.slice(0, at), file, ...tabs.slice(at)];
    }
    const expanded = new Set([...state.expanded, nodeId(file.project), ...parentFolders(file.project, file.path)]);
    workspaceStore.setState({ tabs, expanded: [...expanded] });
    this.selected = nodeId(file.project, file.path);
    this.showTab(file);
    if (focus) this.editor.focus();
  }

  private showTab(file: OpenFile | null) {
    const state = this.ws();
    const previous = state.activeTab;
    if (previous && this.editor.getModel()) {
      this.viewStates.set(modelKey(previous.project, previous.path), this.editor.saveViewState());
    }
    workspaceStore.setState({ activeTab: file });
    if (file) this.activateProject(file.project);

    const model = file ? this.models.get(modelKey(file.project, file.path)) ?? null : null;
    this.editor.setModel(model);
    if (model && file) {
      const view = this.viewStates.get(modelKey(file.project, file.path));
      if (view) this.editor.restoreViewState(view);
    }
    this.$('#editor-empty').hidden = !!model;
    this.renderTabs();
    this.renderBreadcrumbs();
    this.renderTree();
    this.renderOutput();
  }

  private closeTab(file: OpenFile) {
    const state = this.ws();
    const index = state.tabs.findIndex((t) => sameFile(t, file));
    if (index < 0) return;
    const tabs = state.tabs.filter((_, i) => i !== index);
    workspaceStore.setState({ tabs });
    if (sameFile(state.activeTab, file)) {
      this.viewStates.delete(modelKey(file.project, file.path));
      workspaceStore.setState({ activeTab: null });
      this.showTab(tabs[Math.min(index, tabs.length - 1)] ?? null);
    } else {
      this.renderTabs();
    }
  }

  private renderTabs() {
    const container = this.$('#file-tabs');
    const tpl = this.$<HTMLTemplateElement>('#file-tab-template');
    const { tabs, activeTab } = this.ws();
    const labels = tabLabels(tabs);
    container.replaceChildren();
    tabs.forEach((tab, i) => {
      const el = tpl.content.firstElementChild!.cloneNode(true) as HTMLElement;
      const active = sameFile(tab, activeTab);
      el.dataset.file = tab.path;
      el.dataset.project = tab.project;
      el.setAttribute('aria-selected', String(active));
      el.title = `${tab.project}/${tab.path}`;
      el.querySelector('.tab-icon')!.append(fileIcon(tab.path));
      el.querySelector('.tab-label')!.textContent = labels[i].name;
      el.querySelector('.tab-description')!.textContent = labels[i].description;
      el.querySelector('.file-name')!.addEventListener('click', () => this.showTab(tab));
      el.addEventListener('auxclick', (e) => {
        if (e.button === 1) this.closeTab(tab);
      });
      const close = el.querySelector<HTMLElement>('.file-close')!;
      close.append(codicon('close'));
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        this.closeTab(tab);
      });
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showMenu(
          [
            { label: 'Close', run: () => this.closeTab(tab) },
            { label: 'Close Others', disabled: tabs.length < 2, run: () => this.closeOthers(tab) },
            { label: 'Close All', run: () => this.closeOthers(null) },
            'separator',
            { label: 'Reveal in Explorer', run: () => this.reveal(tab) },
          ],
          { anchor: { x: e.clientX, y: e.clientY }, container: this, label: 'Tab' }
        );
      });
      container.appendChild(el);
      if (active) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  }

  private closeOthers(keep: OpenFile | null) {
    workspaceStore.setState({ tabs: keep ? [keep] : [] });
    this.showTab(keep);
  }

  private renderBreadcrumbs() {
    const crumbs = this.$('#breadcrumbs');
    const tab = this.ws().activeTab;
    crumbs.replaceChildren();
    if (!tab) return;
    const parts = [tab.project, ...tab.path.split('/')];
    parts.forEach((part, i) => {
      if (i) crumbs.append(codicon('chevronRight'));
      const crumb = document.createElement('span');
      crumb.className = 'breadcrumb';
      if (i === parts.length - 1) crumb.append(fileIcon(tab.path));
      crumb.append(part);
      crumbs.append(crumb);
    });
  }

  // ---- Explorer ---------------------------------------------------------------------

  private initExplorer() {
    const tree = this.$('#explorer');
    tree.addEventListener('click', (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>('.tree-row');
      if (!row || row.querySelector('input')) return;
      this.selected = row.dataset.id!;
      this.activateRow(row, false);
    });
    tree.addEventListener('contextmenu', (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>('.tree-row');
      e.preventDefault();
      if (row) {
        this.selected = row.dataset.id!;
        this.renderTree();
      }
      this.openTreeMenu(row, { x: e.clientX, y: e.clientY });
    });
    tree.addEventListener('keydown', (e) => this.onTreeKey(e));
  }

  /** Opens a file, or expands or collapses a folder. */
  private activateRow(row: HTMLElement, keyboard: boolean) {
    const { kind, project, path } = row.dataset;
    if (kind === 'file') {
      this.openFile({ project: project!, path: path! }, { focus: keyboard });
      if (window.matchMedia('(max-width: 900px)').matches) {
        // On narrow screens the Explorer covers the editor: get out of the way.
        workspaceStore.setState({ sidebarVisible: false });
        this.applyLayout();
      } else if (!keyboard) {
        this.$('#explorer').focus({ preventScroll: true });
      }
    } else {
      this.setExpanded(row.dataset.id!, row.getAttribute('aria-expanded') !== 'true');
    }
  }

  private setExpanded(id: string, open: boolean) {
    const expanded = new Set(this.ws().expanded);
    if (open) expanded.add(id);
    else expanded.delete(id);
    workspaceStore.setState({ expanded: [...expanded] });
    this.renderTree();
  }

  private collapseAll() {
    workspaceStore.setState({ expanded: [] });
    this.renderTree();
  }

  private reveal(file: OpenFile) {
    const state = this.ws();
    workspaceStore.setState({
      expanded: [...new Set([...state.expanded, nodeId(file.project), ...parentFolders(file.project, file.path)])],
      sidebarVisible: true,
    });
    this.selected = nodeId(file.project, file.path);
    this.applyLayout();
    this.renderTree();
    this.$('#explorer').focus();
  }

  private renderTree() {
    const tree = this.$('#explorer');
    const state = this.ws();
    const expanded = new Set(state.expanded);
    const activeId = state.activeTab ? nodeId(state.activeTab.project, state.activeTab.path) : null;
    const scroll = tree.scrollTop;
    tree.replaceChildren();

    const row = (node: TreeNode | FolderNode, project: string, depth: number, isProject = false) => {
      const el = document.createElement('div');
      el.className = 'tree-row';
      el.setAttribute('role', 'treeitem');
      el.setAttribute('aria-level', String(depth + 1));
      el.style.setProperty('--depth', String(depth));
      el.dataset.id = node.id;
      el.dataset.project = project;
      el.dataset.path = node.path;
      el.dataset.kind = isProject ? 'project' : node.kind;
      el.setAttribute('aria-selected', String(node.id === this.selected));
      if (node.kind === 'folder') {
        const open = expanded.has(node.id);
        el.setAttribute('aria-expanded', String(open));
        el.append(codicon(open ? 'chevronDown' : 'chevronRight', 'tree-chevron'));
      } else {
        el.append(Object.assign(document.createElement('span'), { className: 'tree-chevron' }));
        el.append(fileIcon(node.path));
        if (node.id === activeId) el.dataset.active = 'true';
        const problem = project === state.activeProject ? this.problemFiles.get(node.path) : undefined;
        if (problem) el.dataset.problems = problem;
      }
      const renaming = this.editing?.kind === 'rename' && this.editing.project === project && this.editing.path === node.path && !isProject;
      if (renaming) {
        el.append(this.nameInput(node.name));
      } else {
        const label = document.createElement('span');
        label.className = 'tree-label';
        label.textContent = node.name;
        el.append(label);
      }
      if (isProject) {
        el.title = `${projectTitle(project, state)}${project === state.activeProject ? ' (active)' : ''}`;
        if (project === state.activeProject) el.dataset.activeProject = 'true';
        const description = document.createElement('span');
        description.className = 'tree-description';
        description.textContent = projectTitle(project, state);
        el.append(description);
      } else {
        el.title = `${project}/${node.path}`;
      }
      tree.appendChild(el);
      if (renaming) this.attachError(tree, depth);
    };

    const folder = (node: FolderNode, project: string, depth: number, isProject = false) => {
      row(node, project, depth, isProject);
      if (!expanded.has(node.id)) return;
      if (this.editing?.kind === 'new' && this.editing.project === project && this.editing.folder === node.path) {
        const el = document.createElement('div');
        el.className = 'tree-row';
        el.dataset.kind = 'input';
        el.style.setProperty('--depth', String(depth + 1));
        el.append(Object.assign(document.createElement('span'), { className: 'tree-chevron' }));
        el.append(codicon('file', 'file-icon file-icon-generic'));
        el.append(this.nameInput(''));
        tree.appendChild(el);
        this.attachError(tree, depth + 1);
      }
      for (const child of node.children) {
        if (child.kind === 'folder') folder(child, project, depth + 1);
        else row(child, project, depth + 1);
      }
    };

    const section = (title: string) => {
      const el = document.createElement('div');
      el.className = 'tree-section';
      el.textContent = title;
      tree.appendChild(el);
    };
    section('Projects');
    if (this.editing?.kind === 'project') {
      const el = document.createElement('div');
      el.className = 'tree-row';
      el.dataset.kind = 'input';
      el.style.setProperty('--depth', '0');
      el.append(codicon('chevronRight', 'tree-chevron'), this.nameInput(this.editing.suggested));
      tree.appendChild(el);
      this.attachError(tree, 0);
    } else if (!state.userProjects.length) {
      const hint = document.createElement('button');
      hint.className = 'tree-hint';
      hint.id = 'new-project-hint';
      hint.textContent = 'New Project…';
      hint.addEventListener('click', () => this.startNewProject({ template: 'blank' }));
      tree.appendChild(hint);
    }
    for (const { id } of state.userProjects) folder(buildTree(id, projectFiles(state, id)), id, 0, true);
    section('Examples');
    for (const example of EXAMPLES) {
      folder(buildTree(example.id, projectFiles(state, example.id)), example.id, 0, true);
    }
    tree.scrollTop = scroll;
    const input = tree.querySelector<HTMLInputElement>('.tree-input');
    if (input) {
      input.focus();
      const dot = input.value.lastIndexOf('.');
      input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
    } else {
      tree.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
    }
  }

  private visibleRows(): HTMLElement[] {
    return [...this.$('#explorer').querySelectorAll<HTMLElement>('.tree-row[data-id]')];
  }

  private onTreeKey(e: KeyboardEvent) {
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    const rows = this.visibleRows();
    const index = rows.findIndex((r) => r.dataset.id === this.selected);
    const current = rows[index];
    const select = (row: HTMLElement | undefined) => {
      if (!row) return;
      this.selected = row.dataset.id!;
      this.renderTree();
    };
    switch (e.key) {
      case 'ArrowDown':
        select(rows[Math.min(rows.length - 1, index + 1)]);
        break;
      case 'ArrowUp':
        select(rows[Math.max(0, index - 1)]);
        break;
      case 'Home':
        select(rows[0]);
        break;
      case 'End':
        select(rows[rows.length - 1]);
        break;
      case 'ArrowRight':
        if (current?.getAttribute('aria-expanded') === 'false') this.setExpanded(current.dataset.id!, true);
        else if (current?.getAttribute('aria-expanded') === 'true') select(rows[index + 1]);
        break;
      case 'ArrowLeft': {
        if (current?.getAttribute('aria-expanded') === 'true') {
          this.setExpanded(current.dataset.id!, false);
        } else if (current) {
          const level = Number(current.getAttribute('aria-level'));
          select(rows.slice(0, index).reverse().find((r) => Number(r.getAttribute('aria-level')) < level));
        }
        break;
      }
      case 'Enter':
      case ' ':
        if (current) this.activateRow(current, true);
        break;
      case 'F2':
        if (current?.dataset.kind === 'file') this.startRename(current.dataset.project!, current.dataset.path!);
        break;
      case 'Delete':
      case 'Backspace':
        if (current?.dataset.kind === 'file' && (e.key === 'Delete' || e.metaKey)) {
          this.deleteFile(current.dataset.project!, current.dataset.path!);
        }
        break;
      default:
        return;
    }
    e.preventDefault();
  }

  private openTreeMenu(row: HTMLElement | null, at: { x: number; y: number }) {
    const project = row?.dataset.project ?? this.ws().activeProject;
    const kind = row?.dataset.kind;
    const path = row?.dataset.path ?? '';
    const folder = kind === 'file' ? path.split('/').slice(0, -1).join('/') : path;
    const files = projectFiles(this.ws(), project);
    const entries: MenuEntry[] = [{ label: 'New File…', run: () => this.startNewFile(project, folder) }];
    if (kind === 'file') {
      entries.push(
        'separator',
        { label: 'Open', run: () => this.openFile({ project, path }, { focus: true }) },
        { label: 'Rename…', keybinding: 'F2', disabled: isProtected(files, path), run: () => this.startRename(project, path) },
        { label: 'Delete', keybinding: 'Delete', disabled: isProtected(files, path), run: () => this.deleteFile(project, path) }
      );
    }
    if (kind === 'folder' || kind === 'project' || !row) {
      entries.push('separator', { label: 'Collapse Folders in Explorer', run: () => this.collapseAll() });
    }
    entries.push('separator', { label: `Duplicate ${project}…`, run: () => this.startNewProject({ project }) });
    if (isExample(project)) {
      entries.push({ label: `Reset ${project}…`, run: () => this.resetProject(project) });
    } else {
      entries.push({ label: `Delete ${project}…`, run: () => this.deleteProject(project) });
    }
    entries.push('separator', { label: 'New Project…', run: () => this.startNewProject({ template: 'blank' }) });
    showMenu(entries, { anchor: at, container: this, label: 'Explorer' });
  }

  private nameInput(value: string): HTMLInputElement {
    const input = document.createElement('input');
    input.className = 'tree-input';
    input.value = value;
    input.spellcheck = false;
    input.setAttribute('aria-label', this.editing?.kind === 'rename' ? 'New name' : 'File name');
    const validate = () => {
      const error = this.nameError(input.value);
      input.setAttribute('aria-invalid', String(!!error && input.value !== ''));
      const box = this.$('#explorer').querySelector<HTMLElement>('.tree-error');
      if (box) {
        box.hidden = !error || input.value === '';
        box.textContent = error ?? '';
      }
    };
    input.addEventListener('input', validate);
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        this.commitName(input.value);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.cancelName();
      }
    });
    // Like VS Code: clicking away commits a valid name, and drops an invalid one.
    input.addEventListener('blur', () => {
      if (!this.editing) return;
      if (input.value.trim() && !this.nameError(input.value)) this.commitName(input.value);
      else this.cancelName();
    });
    queueMicrotask(validate);
    return input;
  }

  private attachError(tree: HTMLElement, depth: number) {
    const box = document.createElement('div');
    box.className = 'tree-error';
    box.setAttribute('role', 'alert');
    box.style.setProperty('--depth', String(depth));
    box.hidden = true;
    tree.appendChild(box);
  }

  /** The path a name typed into the Explorer stands for, or why it can't be used. */
  private resolveName(input: string): { path: string } | { error: string } {
    const editing = this.editing!;
    if (editing.kind === 'project') {
      const result = checkProjectName(input, this.ws());
      return 'error' in result ? result : { path: result.id };
    }
    const files = projectFiles(this.ws(), editing.project);
    if (editing.kind === 'new') return resolveNewPath(editing.folder, input, files);
    const folder = editing.path.split('/').slice(0, -1).join('/');
    const others = { ...files };
    delete others[editing.path];
    if (input.trim() === editing.path.split('/').pop()) return { path: editing.path };
    return resolveNewPath(folder, input, others);
  }

  private nameError(input: string): string | null {
    if (!this.editing) return null;
    const result = this.resolveName(input);
    return 'error' in result ? result.error : null;
  }

  private startNewFile(project = this.defaultNewFileProject(), folder = this.defaultNewFileFolder(project)) {
    this.editing = { kind: 'new', project, folder };
    const state = this.ws();
    const expanded = new Set([...state.expanded, nodeId(project)]);
    if (folder) {
      expanded.add(nodeId(project, folder));
      for (const id of parentFolders(project, `${folder}/x`)) expanded.add(id);
    }
    workspaceStore.setState({ expanded: [...expanded], sidebarVisible: true });
    this.applyLayout();
    this.renderTree();
  }

  /** New files go next to the Explorer selection, or into the active project's src/. */
  private defaultNewFileProject(): string {
    const row = this.selected ? this.$('#explorer').querySelector<HTMLElement>(`[data-id="${CSS.escape(this.selected)}"]`) : null;
    return row?.dataset.project ?? this.ws().activeProject;
  }

  private defaultNewFileFolder(project: string): string {
    const row = this.selected ? this.$('#explorer').querySelector<HTMLElement>(`[data-id="${CSS.escape(this.selected)}"]`) : null;
    if (row && row.dataset.project === project) {
      return row.dataset.kind === 'file' ? row.dataset.path!.split('/').slice(0, -1).join('/') : row.dataset.path!;
    }
    return Object.keys(projectFiles(this.ws(), project)).some((p) => p.startsWith('src/')) ? 'src' : '';
  }

  private startRename(project: string, path: string) {
    if (isProtected(projectFiles(this.ws(), project), path)) return;
    this.editing = { kind: 'rename', project, path };
    this.renderTree();
  }

  private cancelName() {
    this.editing = null;
    this.renderTree();
    this.$('#explorer').focus();
  }

  private commitName(input: string) {
    const editing = this.editing;
    if (!editing) return;
    const result = this.resolveName(input);
    if ('error' in result) return;
    this.editing = null;
    if (editing.kind === 'project') {
      this.createProject(result.path, editing.from);
      return;
    }
    const files = projectFiles(this.ws(), editing.project);
    if (editing.kind === 'new') {
      const initial = result.path.endsWith('package.json') ? '{\n  "dependencies": {}\n}\n' : '';
      this.setProjectFiles(editing.project, { ...files, [result.path]: initial });
      this.createModel(editing.project, result.path, initial);
      this.openFile({ project: editing.project, path: result.path }, { focus: true });
      if (editing.project === this.ws().activeProject) this.scheduleCheck();
      return;
    }
    if (result.path === editing.path) {
      this.renderTree();
      return;
    }
    const renamed = Object.fromEntries(
      Object.entries(files).map(([p, text]) => [p === editing.path ? result.path : p, text])
    );
    this.setProjectFiles(editing.project, renamed);
    const text = this.models.get(modelKey(editing.project, editing.path))?.getValue() ?? files[editing.path];
    this.disposeModel(editing.project, editing.path);
    this.createModel(editing.project, result.path, text);
    const from: OpenFile = { project: editing.project, path: editing.path };
    const to: OpenFile = { project: editing.project, path: result.path };
    const state = this.ws();
    workspaceStore.setState({ tabs: state.tabs.map((t) => (sameFile(t, from) ? to : t)) });
    this.selected = nodeId(to.project, to.path);
    if (sameFile(state.activeTab, from)) {
      workspaceStore.setState({ activeTab: null });
      this.showTab(to);
    } else {
      this.renderTabs();
      this.renderTree();
    }
    if (editing.project === state.activeProject) this.scheduleCheck();
  }

  private deleteFile(project: string, path: string) {
    const files = projectFiles(this.ws(), project);
    if (isProtected(files, path)) return;
    if (!window.confirm(`Are you sure you want to delete '${path}' from ${project}?`)) return;
    const remaining = { ...files };
    delete remaining[path];
    this.setProjectFiles(project, remaining);
    this.closeTab({ project, path });
    this.disposeModel(project, path);
    this.renderTree();
    if (project === this.ws().activeProject) this.scheduleCheck();
  }

  /** Opens a name box at the top of the Projects section. */
  private startNewProject(from: { template: Template } | { project: string }) {
    const state = this.ws();
    const base = 'project' in from ? `${from.project}-copy` : from.template === 'fluxkit' ? 'my-model' : 'my-project';
    this.editing = { kind: 'project', from, suggested: freeProjectName(base, state) };
    workspaceStore.setState({ sidebarVisible: true });
    this.applyLayout();
    this.renderTree();
  }

  private createProject(id: string, from: { template: Template } | { project: string }) {
    const state = this.ws();
    const files = 'project' in from ? { ...projectFiles(state, from.project) } : templateFiles(from.template, id);
    const entry = entryFile(files);
    workspaceStore.setState({
      projects: { ...state.projects, [id]: files },
      userProjects: [...state.userProjects, { id, from: 'project' in from ? from.project : `template:${from.template}` }],
      expanded: [...new Set([...state.expanded, nodeId(id), ...parentFolders(id, entry)])],
    });
    this.ensureProject(id);
    this.openFile({ project: id, path: entry }, { focus: true });
  }

  private deleteProject(project: string) {
    if (isExample(project)) return;
    if (!window.confirm(`Delete the project ${project} and all its files? This cannot be undone.`)) return;
    const state = this.ws();
    for (const path of Object.keys(projectFiles(state, project))) this.disposeModel(project, path);
    const projects = { ...state.projects };
    delete projects[project];
    const tabs = state.tabs.filter((t) => t.project !== project);
    workspaceStore.setState({
      projects,
      userProjects: state.userProjects.filter((p) => p.id !== project),
      tabs,
      expanded: state.expanded.filter((id) => id !== project && !id.startsWith(`${project}/`)),
    });
    if (this.selected === project || this.selected?.startsWith(`${project}/`)) this.selected = null;
    if (state.activeProject === project) {
      // Hand over to another open file, or to the first example.
      workspaceStore.setState({ activeTab: null });
      const fallback = projectIds(this.ws())[0];
      if (tabs[0]) this.showTab(tabs[0]);
      else this.openFile({ project: fallback, path: entryFile(projectFiles(this.ws(), fallback)) });
      // Switching away saved the deleted project's output; drop it.
      this.savedOutputs.delete(project);
    } else {
      this.renderTabs();
      this.renderTree();
    }
  }

  private resetProject(project: string) {
    if (!isExample(project)) return;
    if (!window.confirm(`Restore ${project}'s original files? Your changes to it will be lost.`)) return;
    const example = findExample(project);
    if (!example) return;
    for (const path of Object.keys(projectFiles(this.ws(), project))) this.disposeModel(project, path);
    this.setProjectFiles(project, { ...example.files });
    this.ensureProject(project);
    const state = this.ws();
    const tabs = state.tabs.filter((t) => t.project !== project || t.path in example.files);
    workspaceStore.setState({ tabs, activeTab: null });
    const active = state.activeTab && tabs.some((t) => sameFile(t, state.activeTab)) ? state.activeTab : tabs[0] ?? null;
    this.showTab(active);
    if (project === this.ws().activeProject) this.check();
  }

  // ---- Layout: side bar, output panel, sashes ------------------------------------------

  private applyLayout() {
    const state = this.ws();
    const bench = this.$('.workbench');
    bench.dataset.sidebar = state.sidebarVisible ? 'visible' : 'hidden';
    bench.dataset.panelArea = state.panelVisible ? 'visible' : 'hidden';
    bench.style.setProperty('--sidebar-width', `${state.sidebarWidth}px`);
    bench.style.setProperty('--editor-fraction', `${(1 - state.panelFraction) * 100}fr`);
    bench.style.setProperty('--panel-fraction', `${state.panelFraction * 100}fr`);
    this.$('#view-explorer').setAttribute('aria-pressed', String(state.sidebarVisible));
    this.$('#toggle-panel').setAttribute('aria-pressed', String(state.panelVisible));
  }

  private toggleSidebar() {
    workspaceStore.setState({ sidebarVisible: !this.ws().sidebarVisible });
    this.applyLayout();
    if (this.ws().sidebarVisible) this.$('#explorer').focus();
  }

  private setPanelVisible(visible: boolean) {
    workspaceStore.setState({ panelVisible: visible });
    this.applyLayout();
  }

  private togglePanel() {
    this.setPanelVisible(!this.ws().panelVisible);
  }

  private initSashes() {
    const bench = this.$('.workbench');
    const drag = (sash: HTMLElement, onMove: (x: number) => void, onReset: () => void) => {
      sash.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        sash.setPointerCapture(e.pointerId);
        sash.dataset.dragging = 'true';
        bench.dataset.dragging = 'true';
        const move = (ev: PointerEvent) => onMove(ev.clientX);
        const up = () => {
          sash.removeEventListener('pointermove', move);
          sash.removeEventListener('pointerup', up);
          sash.removeEventListener('pointercancel', up);
          delete sash.dataset.dragging;
          delete bench.dataset.dragging;
        };
        sash.addEventListener('pointermove', move);
        sash.addEventListener('pointerup', up);
        sash.addEventListener('pointercancel', up);
      });
      sash.addEventListener('dblclick', onReset);
    };
    drag(
      this.$('#sidebar-sash'),
      (x) => {
        const left = this.$('.sidebar').getBoundingClientRect().left;
        const width = Math.round(x - left);
        if (width < SIDEBAR_WIDTH.min / 2) {
          workspaceStore.setState({ sidebarVisible: false });
        } else {
          workspaceStore.setState({
            sidebarVisible: true,
            sidebarWidth: Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, width)),
          });
        }
        this.applyLayout();
      },
      () => {
        workspaceStore.setState({ sidebarWidth: SIDEBAR_WIDTH.default });
        this.applyLayout();
      }
    );
    drag(
      this.$('#panel-sash'),
      (x) => {
        const main = this.$('.main').getBoundingClientRect();
        const fraction = (main.right - x) / main.width;
        workspaceStore.setState({
          panelFraction: Math.min(PANEL_FRACTION.max, Math.max(PANEL_FRACTION.min, fraction)),
        });
        this.applyLayout();
      },
      () => {
        workspaceStore.setState({ panelFraction: PANEL_FRACTION.default });
        this.applyLayout();
      }
    );
  }

  // ---- Menus and shortcuts --------------------------------------------------------------

  private openAppMenu() {
    const button = this.$('#menu-button');
    const state = this.ws();
    button.setAttribute('aria-expanded', 'true');
    showMenu(
      [
        { label: 'New File…', run: () => this.startNewFile() },
        { label: 'New Project…', run: () => this.startNewProject({ template: 'blank' }) },
        { label: 'New fluxkit Project…', run: () => this.startNewProject({ template: 'fluxkit' }) },
        { label: `Duplicate ${state.activeProject}…`, run: () => this.startNewProject({ project: state.activeProject }) },
        isExample(state.activeProject)
          ? { label: `Reset ${state.activeProject}…`, run: () => this.resetProject(state.activeProject) }
          : { label: `Delete ${state.activeProject}…`, run: () => this.deleteProject(state.activeProject) },
        'separator',
        { label: 'Run', keybinding: 'Ctrl+Enter', run: () => this.run() },
        { label: 'Run Tests', keybinding: 'Ctrl+Shift+Enter', run: () => this.run('test') },
        { label: 'Stop', disabled: this.$<HTMLButtonElement>('#stop').disabled, run: () => this.stop() },
        'separator',
        { label: state.sidebarVisible ? 'Hide Explorer' : 'Show Explorer', keybinding: 'Ctrl+B', run: () => this.toggleSidebar() },
        { label: state.panelVisible ? 'Hide Output' : 'Show Output', keybinding: 'Ctrl+J', run: () => this.togglePanel() },
        { label: 'Close All Editors', disabled: !state.tabs.length, run: () => this.closeOthers(null) },
        'separator',
        { label: 'How It Works', run: () => Router.getInstance().navigate('/about') },
        { label: 'View Source on GitHub', run: () => window.open('https://github.com/sholtomaud/tsrs-monaco', '_blank', 'noopener') },
      ],
      {
        anchor: button,
        container: this,
        label: 'Application menu',
        onClose: () => button.setAttribute('aria-expanded', 'false'),
      }
    );
  }

  private handleShortcut(e: KeyboardEvent) {
    if (!this.isConnected || e.defaultPrevented || !(e.ctrlKey || e.metaKey)) return;
    // Monaco handles its own shortcuts while it has focus.
    if ((e.target as HTMLElement).closest?.('.monaco-editor')) return;
    const key = e.key.toLowerCase();
    if (key === 'enter') this.run(e.shiftKey ? 'test' : 'run');
    else if (key === 'b' && !e.shiftKey) this.toggleSidebar();
    else if (key === 'j' && !e.shiftKey) this.togglePanel();
    else return;
    e.preventDefault();
  }

  // ---- Type checking ---------------------------------------------------------

  private scheduleCheck() {
    window.clearTimeout(this.checkTimer);
    this.checkTimer = window.setTimeout(() => this.check(), CHECK_DELAY_MS);
  }

  private async check() {
    window.clearTimeout(this.checkTimer);
    const seq = ++this.checkSeq;
    const project = this.ws().activeProject;
    const files = this.files();
    try {
      await this.fetchTypes(files, seq);
      if (seq !== this.checkSeq || !this.isConnected) return;
      if (this.compiler.ready) this.setStatus('busy', 'Type checking with tsrs…');
      const result = await this.compiler.compile(files);
      if (seq !== this.checkSeq || !this.isConnected) return;
      this.applyResult(result, project);
      if (this.runAfterCheck) {
        const mode = this.runAfterCheck;
        this.runAfterCheck = null;
        this.execute(result, mode);
      }
    } catch (error) {
      if (seq !== this.checkSeq || !this.isConnected) return;
      this.runAfterCheck = null;
      this.setStatus('error', `Compiler error: ${(error as Error).message}`);
    }
  }

  /** Fetches declaration files for npm imports and hands them to the compiler. */
  private async fetchTypes(files: ProjectFiles, seq: number) {
    const imports = projectImports(files);
    const fresh = imports
      .map((i) => i.name)
      .filter((name) => !(name in this.acquisition.versions));
    const pending = this.packages.types(files);
    if (fresh.length && seq === this.checkSeq) {
      this.setStatus('busy', `Fetching types for ${[...new Set(fresh)].join(', ')} from npm…`);
    }
    this.acquisition = await pending;
    this.compiler.setLibraries(this.acquisition.files);
  }

  private applyResult(result: CompileResult, project: string) {
    this.lastResult = result;
    const problems = [
      ...result.diagnostics.map(toProblem),
      ...this.acquisition.errors.map(
        (message): Problem => ({
          file: null,
          severity: 'warning',
          code: 0,
          message,
          startLineNumber: 1,
          startColumn: 1,
          endLineNumber: 1,
          endColumn: 1,
        })
      ),
    ];
    for (const path of Object.keys(projectFiles(this.ws(), project))) {
      const model = this.models.get(modelKey(project, path));
      if (!model) continue;
      monaco.editor.setModelMarkers(
        model,
        'tsrs',
        problems
          .filter((p) => p.file === path)
          .map((p) => ({
            severity: MARKER_SEVERITY[p.severity],
            message: p.message,
            code: `TS${p.code}`,
            source: 'tsrs',
            startLineNumber: p.startLineNumber,
            startColumn: p.startColumn,
            endLineNumber: p.endLineNumber,
            endColumn: p.endColumn,
          }))
      );
    }
    this.problemFiles.clear();
    for (const p of problems) {
      if (!p.file) continue;
      if (p.severity === 'error') this.problemFiles.set(p.file, 'error');
      else if (p.severity === 'warning' && !this.problemFiles.has(p.file)) this.problemFiles.set(p.file, 'warning');
    }
    this.renderProblems(problems, result);
    this.renderOutput();
    this.renderTree();

    const errors = problems.filter((p) => p.severity === 'error').length;
    const warnings = problems.filter((p) => p.severity === 'warning').length;
    this.$('#status-errors').textContent = String(errors);
    this.$('#status-warnings').textContent = String(warnings);
    const ms = Math.round(result.durationMs);
    const mib = Math.round(result.memoryBytes / 1024 / 1024);
    const npm = Object.entries(this.acquisition.versions)
      .filter(([name]) => !name.startsWith('@types/'))
      .map(([name, version]) => `${name}@${version}`);
    this.$('#stats').textContent =
      `Checked + emitted in ${ms} ms · ${mib} MiB wasm memory · exit code ${result.exitCode}` +
      (npm.length ? ` · npm: ${npm.join(', ')}` : '');
    this.setStatus(
      errors ? 'error' : 'ready',
      errors
        ? `${errors} type error${errors === 1 ? '' : 's'}`
        : 'No type errors'
    );
  }

  private renderProblems(problems: Problem[], result: CompileResult) {
    const list = this.$('#problems');
    const tpl = this.$<HTMLTemplateElement>('#problem-template');
    list.replaceChildren();

    const errors = problems.filter((p) => p.severity === 'error').length;
    const warnings = problems.filter((p) => p.severity === 'warning').length;
    const badge = this.$('#problem-count');
    badge.textContent = String(problems.length);
    badge.dataset.count = String(problems.length);
    badge.dataset.severity = errors ? 'error' : warnings ? 'warning' : '';

    for (const problem of problems) {
      const item = tpl.content.firstElementChild!.cloneNode(true) as HTMLElement;
      item.dataset.severity = problem.severity;
      item.querySelector('.problem-severity')!.textContent = problem.severity;
      item.querySelector('.problem-message')!.textContent = problem.message;
      item.querySelector('.problem-location')!.textContent = problem.file
        ? `${problem.file}:${problem.startLineNumber}:${problem.startColumn} · TS${problem.code}`
        : problem.code
          ? `TS${problem.code}`
          : 'npm';
      item
        .querySelector('button')!
        .addEventListener('click', () => this.revealProblem(problem));
      list.appendChild(item);
    }

    // Output tsrs printed itself, e.g. a crash, rather than JSON diagnostics.
    const extra = `${result.stdout}${result.stderr}`.trim();
    if (extra) {
      const item = document.createElement('li');
      item.className = 'problems-empty font-mono whitespace-pre-wrap';
      item.textContent = extra;
      list.appendChild(item);
    }
    if (!problems.length && !extra) {
      const empty = document.createElement('li');
      empty.className = 'problems-empty';
      empty.textContent = 'No problems. tsrs found no type errors.';
      list.appendChild(empty);
    }
  }

  private revealProblem(problem: Problem) {
    const project = this.ws().activeProject;
    if (!problem.file || !this.models.has(modelKey(project, problem.file))) return;
    this.openFile({ project, path: problem.file });
    const range = new monaco.Range(
      problem.startLineNumber,
      problem.startColumn,
      problem.endLineNumber,
      problem.endColumn
    );
    this.editor.setSelection(range);
    this.editor.revealRangeInCenter(range);
    this.editor.focus();
  }

  /** Shows the JavaScript tsrs emitted for the file being edited. */
  private renderOutput() {
    const { activeTab, activeProject } = this.ws();
    const label = this.$('#js-label');
    if (!this.lastResult) {
      label.textContent = 'Waiting for the first compile…';
      this.output.setValue('');
      return;
    }
    const source = activeTab && activeTab.project === activeProject ? activeTab.path : this.entry();
    const target = isSourceFile(source) ? outputPathFor(source) : outputPathFor(this.entry());
    const js = this.lastResult.outputs[target];
    label.textContent =
      js === undefined ? `${target} was not emitted` : target;
    if (this.output.getValue() !== (js ?? '')) this.output.setValue(js ?? '');
  }

  // ---- Running -----------------------------------------------------------------

  private run(mode: Mode = 'run') {
    this.runAfterCheck = mode;
    this.setPanelVisible(true);
    this.showPanel(mode === 'test' ? 'tests' : 'console');
    this.check();
  }

  private async execute(result: CompileResult, mode: Mode) {
    if (mode === 'run' && isWebApp(this.files())) {
      return this.preview(result);
    }
    const modules = Object.fromEntries(
      Object.entries(result.outputs).filter(([path]) => /\.(m|c)?js$/.test(path))
    );
    const entries =
      mode === 'test'
        ? Object.keys(modules).filter((path) => TEST_FILE.test(path)).sort()
        : [outputPathFor(this.entry())];
    const errors = result.diagnostics.filter((d) => d.category === 1).length;
    const despite = errors
      ? ` despite ${errors} type error${errors === 1 ? '' : 's'}`
      : '';

    this.clearConsole();
    this.mode = mode;
    this.plotted = false;
    this.$('#plots').replaceChildren();
    if (mode === 'test') {
      this.$('#tests').replaceChildren();
      this.setTestCount(0, 0);
      if (!entries.length) {
        this.$('#test-summary').textContent =
          'No test files. Add src/<name>.test.ts and call test() and expect().';
        return;
      }
      this.$('#test-summary').textContent = `Running ${entries.length} test file${entries.length === 1 ? '' : 's'}${despite}…`;
      this.log('system', `▶ Testing ${entries.join(', ')}${despite}`);
    } else {
      this.log('system', `▶ Running ${entries[0]}${despite}`);
    }

    const files = this.files();
    const imports = await this.packages.runtimeImports(
      modules,
      files,
      this.acquisition.versions
    );
    for (const [spec, url] of Object.entries(imports)) {
      this.log('system', `↳ ${spec} from ${url}`);
    }

    let passed = 0;
    let failed = 0;
    this.$<HTMLButtonElement>('#stop').disabled = false;
    this.runner.run({ modules, mode, entries, imports }, (message: RunMessage) => {
      switch (message.type) {
        case 'console':
          this.log(message.level, message.text);
          break;
        case 'error':
          this.log('error', message.text);
          if (mode === 'test') {
            this.$('#test-summary').textContent = `Tests could not run: ${message.text.split('\n')[0]}`;
          }
          break;
        case 'plot':
          this.addPlot(message.chart);
          break;
        case 'test':
          if (message.result.status === 'pass') passed++;
          else failed++;
          this.addTestResult(message.result);
          this.setTestCount(passed, failed);
          break;
        case 'tests-done': {
          const ms = Math.round(message.durationMs);
          const summary = `${message.passed} passed, ${message.failed} failed (${ms} ms)`;
          this.$('#test-summary').textContent = summary;
          this.log(message.failed ? 'error' : 'system', `✓ Tests: ${summary}`);
          break;
        }
        case 'done':
          this.log(
            'system',
            `✓ Module evaluated in ${Math.round(message.durationMs)} ms (timers keep running until Stop or the next Run)`
          );
          break;
      }
    });
  }

  /** Serves the compiled web app to the Preview tab's iframe. */
  private async preview(result: CompileResult) {
    const seq = ++this.previewSeq;
    const errors = result.diagnostics.filter((d) => d.category === 1).length;
    this.runner.stop();
    this.clearConsole();
    this.log(
      'system',
      `▶ Previewing ${INDEX_HTML}${errors ? ` despite ${errors} type error${errors === 1 ? '' : 's'}` : ''}`
    );
    this.showPanel('preview');
    try {
      const files = this.files();
      const modules = Object.fromEntries(
        Object.entries(result.outputs).filter(([path]) => /\.(m|c)?js$/.test(path))
      );
      const imports = await this.packages.runtimeImports(
        modules,
        files,
        this.acquisition.versions
      );
      if (seq !== this.previewSeq) return;
      for (const [spec, url] of Object.entries(imports)) {
        this.log('system', `↳ ${spec} from ${url}`);
      }
      if (Object.keys(imports).length && contentSecurityPolicy(files[INDEX_HTML] ?? '') !== null) {
        this.log(
          'system',
          `↳ The preview's Content-Security-Policy also allows ${importOrigins(imports).join(' and ')}: a build would bundle these packages instead.`
        );
      }
      const url = await publish(files, result.outputs, imports);
      if (seq !== this.previewSeq) return;
      const frame = this.$<HTMLIFrameElement>('#preview-frame');
      // Reload in place so the app stays on the page it was showing.
      if (frame.dataset.loaded === 'true') frame.contentWindow!.location.reload();
      else frame.src = url;
      frame.dataset.loaded = 'true';
      this.$<HTMLButtonElement>('#stop').disabled = false;
    } catch (error) {
      this.log('error', `Preview failed: ${(error as Error).message}`);
    }
  }

  private addPlot(chart: Parameters<typeof renderChart>[0]) {
    const plots = this.$('#plots');
    const figure = document.createElement('figure');
    // renderChart escapes every user-supplied string it writes into the SVG.
    figure.innerHTML = renderChart(chart);
    plots.appendChild(figure);
    // Show the first chart of a run as soon as it is drawn.
    if (!this.plotted) {
      this.plotted = true;
      if (this.mode === 'run') this.showPanel('plot');
    }
  }

  private addTestResult(result: TestResult) {
    const tpl = this.$<HTMLTemplateElement>('#test-template');
    const item = tpl.content.firstElementChild!.cloneNode(true) as HTMLElement;
    item.dataset.status = result.status;
    item.querySelector('.test-icon')!.textContent = result.status === 'pass' ? '✓' : '✗';
    item.querySelector('.test-name')!.textContent = result.name;
    item.querySelector('.test-file')!.textContent = `${result.file.replace(/^dist\//, 'src/').replace(/\.js$/, '.ts')} · ${Math.round(result.durationMs)} ms`;
    item.querySelector('.test-error')!.textContent = result.error ?? '';
    this.$('#tests').appendChild(item);
  }

  private setTestCount(passed: number, failed: number) {
    const badge = this.$('#test-count');
    badge.textContent = failed ? `${failed} failed` : String(passed);
    badge.dataset.severity = failed ? 'error' : passed ? 'pass' : '';
  }

  private stop(quiet = false) {
    const frame = this.$<HTMLIFrameElement>('#preview-frame');
    if (frame.dataset.loaded === 'true') {
      this.previewSeq++;
      frame.removeAttribute('src');
      frame.contentWindow?.location.replace('about:blank');
      frame.dataset.loaded = 'false';
    } else if (!this.runner.running) {
      return;
    }
    this.runner.stop();
    this.$<HTMLButtonElement>('#stop').disabled = true;
    if (!quiet) this.log('system', '■ Stopped');
  }

  private clearConsole() {
    this.$('#console').replaceChildren();
  }

  private log(level: string, text: string) {
    const consoleEl = this.$('#console');
    const tpl = this.$<HTMLTemplateElement>('#console-line-template');
    const line = tpl.content.firstElementChild!.cloneNode(true) as HTMLElement;
    line.classList.add(`console-${level}`);
    line.dataset.level = level;
    line.textContent = text;
    consoleEl.appendChild(line);
    consoleEl.parentElement!.scrollTop = consoleEl.parentElement!.scrollHeight;
  }

  // ---- Chrome ------------------------------------------------------------------

  private showPanel(panel: Panel) {
    this.querySelectorAll<HTMLElement>('.tabs [data-panel]').forEach((tab) =>
      tab.setAttribute('aria-selected', String(tab.dataset.panel === panel))
    );
    this.querySelectorAll<HTMLElement>('.panel').forEach((el) => {
      el.hidden = el.dataset.panel !== panel;
    });
  }

  private setStatus(state: StatusState, text: string) {
    this.$('#status-dot').dataset.state = state;
    this.$('#status').textContent = text;
    this.$('#active-project').textContent = this.ws().activeProject;
  }
}

if (!customElements.get(PlaygroundPageComponent.tagName)) {
  customElements.define(PlaygroundPageComponent.tagName, PlaygroundPageComponent);
}
