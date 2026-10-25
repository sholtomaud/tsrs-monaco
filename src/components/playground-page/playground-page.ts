import { BaseComponent } from '../../core/base-component.ts';
import { monaco, languageOf } from '../../editor/monaco.ts';
import { getCompiler } from '../../compiler/compiler.ts';
import {
  ENTRY,
  TSCONFIG,
  PROJECT_ROOT,
  isSourceFile,
  outputPathFor,
} from '../../compiler/project.ts';
import type { CompileResult } from '../../compiler/protocol.ts';
import {
  toProblem,
  type Problem,
  type Severity,
} from '../../compiler/diagnostics.ts';
import { Runner } from '../../runtime/runner.ts';
import type { RunMessage } from '../../runtime/protocol.ts';
import { playgroundStore, resetProject } from '../../store/playground-store.ts';
import tsrsPackage from '@tsrs/wasm/package.json' with { type: 'json' };
import template from './playground-page.html?raw';
import style from './playground-page.css?raw';

const CHECK_DELAY_MS = 400;
const PROTECTED_FILES = new Set([TSCONFIG, ENTRY]);

const MARKER_SEVERITY: Record<Severity, monaco.MarkerSeverity> = {
  error: monaco.MarkerSeverity.Error,
  warning: monaco.MarkerSeverity.Warning,
  info: monaco.MarkerSeverity.Info,
  hint: monaco.MarkerSeverity.Hint,
};

type Panel = 'console' | 'js' | 'problems';
type StatusState = 'loading' | 'ready' | 'busy' | 'error';

export class PlaygroundPageComponent extends BaseComponent {
  static tagName = 'playground-page';

  private editor!: monaco.editor.IStandaloneCodeEditor;
  private output!: monaco.editor.IStandaloneCodeEditor;
  private models = new Map<string, monaco.editor.ITextModel>();
  private disposables: monaco.IDisposable[] = [];
  private compiler = getCompiler();
  private runner = new Runner();
  private checkTimer = 0;
  private checkSeq = 0;
  private runAfterCheck = false;
  private lastResult: CompileResult | null = null;
  private onCompilerReady = (e: Event) => {
    if (this.lastResult) return;
    const ms = Math.round((e as CustomEvent<number>).detail);
    this.$('#stats').textContent = `tsrs.wasm compiled in ${ms} ms`;
  };

  constructor() {
    super(template, style);
  }

  init() {
    this.$('#version').textContent =
      `@tsrs/wasm ${tsrsPackage.version.replace(/-ts.*/, '')} · TypeScript ${tsrsPackage.tsrs.typescriptVersion}`;

    const common: monaco.editor.IStandaloneEditorConstructionOptions = {
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 14,
      tabSize: 2,
      scrollBeyondLastLine: false,
      fixedOverflowWidgets: true,
    };
    this.editor = monaco.editor.create(this.$('#editor'), common);
    this.output = monaco.editor.create(this.$('#js-output'), {
      ...common,
      readOnly: true,
      language: 'javascript',
      lineNumbers: 'off',
      renderLineHighlight: 'none',
    });

    const { files, activeFile } = playgroundStore.getState();
    for (const [path, text] of Object.entries(files)) this.createModel(path, text);
    this.openFile(activeFile);

    this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () =>
      this.run()
    );
    // Same shortcut when focus is outside the editor (e.g. on an output tab).
    this.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !e.defaultPrevented) {
        e.preventDefault();
        this.run();
      }
    });
    this.$('#run').addEventListener('click', () => this.run());
    this.$('#stop').addEventListener('click', () => this.stop());
    this.$('#reset').addEventListener('click', () => this.reset());
    this.$('#add-file').addEventListener('click', () => this.addFile());
    this.querySelectorAll<HTMLElement>('.tabs [data-panel]').forEach((tab) =>
      tab.addEventListener('click', () =>
        this.showPanel(tab.dataset.panel as Panel)
      )
    );

    this.compiler.addEventListener('ready', this.onCompilerReady);
    this.setStatus('loading', 'Loading tsrs.wasm…');
    this.check();
  }

  disconnectedCallback() {
    window.clearTimeout(this.checkTimer);
    this.compiler.removeEventListener('ready', this.onCompilerReady);
    this.runner.stop();
    this.disposables.forEach((d) => d.dispose());
    this.models.forEach((m) => m.dispose());
    this.models.clear();
    this.editor?.dispose();
    this.output?.dispose();
  }

  private $<T extends HTMLElement = HTMLElement>(selector: string): T {
    return this.querySelector<T>(selector)!;
  }

  // ---- Files ---------------------------------------------------------------

  private createModel(path: string, text: string) {
    const model = monaco.editor.createModel(
      text,
      languageOf(path),
      monaco.Uri.file(`${PROJECT_ROOT}/${path}`)
    );
    this.disposables.push(
      model.onDidChangeContent(() => {
        const { files } = playgroundStore.getState();
        playgroundStore.setState({ files: { ...files, [path]: model.getValue() } });
        this.scheduleCheck();
      })
    );
    this.models.set(path, model);
  }

  private openFile(path: string) {
    const model = this.models.get(path) ?? this.models.get(ENTRY)!;
    const active = this.models.get(path) ? path : ENTRY;
    this.editor.setModel(model);
    playgroundStore.setState({ activeFile: active });
    this.renderTabs();
    this.renderOutput();
  }

  private renderTabs() {
    const container = this.$('#file-tabs');
    const tpl = this.$<HTMLTemplateElement>('#file-tab-template');
    const { activeFile } = playgroundStore.getState();
    container.replaceChildren();
    for (const path of this.models.keys()) {
      const tab = tpl.content.firstElementChild!.cloneNode(true) as HTMLElement;
      tab.dataset.file = path;
      tab.setAttribute('aria-selected', String(path === activeFile));
      const name = tab.querySelector<HTMLElement>('.file-name')!;
      name.textContent = path;
      name.addEventListener('click', () => this.openFile(path));
      const close = tab.querySelector<HTMLElement>('.file-close')!;
      if (PROTECTED_FILES.has(path)) close.remove();
      else close.addEventListener('click', () => this.deleteFile(path));
      container.appendChild(tab);
    }
  }

  private addFile() {
    const input = window.prompt('New file name (inside src/):', 'src/utils.ts');
    if (!input) return;
    let path = input.trim().replace(/^\.?\/+/, '');
    if (!path.startsWith('src/')) path = `src/${path}`;
    if (!/\.(m|c)?(t|j)sx?$/.test(path)) path += '.ts';
    if (this.models.has(path)) {
      this.openFile(path);
      return;
    }
    const { files } = playgroundStore.getState();
    playgroundStore.setState({ files: { ...files, [path]: '' } });
    this.createModel(path, '');
    this.openFile(path);
    this.scheduleCheck();
  }

  private deleteFile(path: string) {
    if (!window.confirm(`Delete ${path}?`)) return;
    const files = { ...playgroundStore.getState().files };
    delete files[path];
    playgroundStore.setState({ files });
    this.models.get(path)?.dispose();
    this.models.delete(path);
    if (playgroundStore.getState().activeFile === path) this.openFile(ENTRY);
    else this.renderTabs();
    this.scheduleCheck();
  }

  private reset() {
    if (!window.confirm('Replace your files with the example project?')) return;
    this.stop();
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
    this.models.forEach((m) => m.dispose());
    this.models.clear();
    resetProject();
    const { files, activeFile } = playgroundStore.getState();
    for (const [path, text] of Object.entries(files)) this.createModel(path, text);
    this.openFile(activeFile);
    this.check();
  }

  // ---- Type checking ---------------------------------------------------------

  private scheduleCheck() {
    window.clearTimeout(this.checkTimer);
    this.checkTimer = window.setTimeout(() => this.check(), CHECK_DELAY_MS);
  }

  private async check() {
    window.clearTimeout(this.checkTimer);
    const seq = ++this.checkSeq;
    if (this.compiler.ready) this.setStatus('busy', 'Type checking with tsrs…');
    try {
      const result = await this.compiler.compile(playgroundStore.getState().files);
      if (seq !== this.checkSeq || !this.isConnected) return;
      this.applyResult(result);
      if (this.runAfterCheck) {
        this.runAfterCheck = false;
        this.execute(result);
      }
    } catch (error) {
      if (seq !== this.checkSeq || !this.isConnected) return;
      this.runAfterCheck = false;
      this.setStatus('error', `Compiler error: ${(error as Error).message}`);
    }
  }

  private applyResult(result: CompileResult) {
    this.lastResult = result;
    const problems = result.diagnostics.map(toProblem);
    for (const [path, model] of this.models) {
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
    this.renderProblems(problems, result);
    this.renderOutput();

    const errors = problems.filter((p) => p.severity === 'error').length;
    const ms = Math.round(result.durationMs);
    const mib = Math.round(result.memoryBytes / 1024 / 1024);
    this.$('#stats').textContent =
      `Checked + emitted in ${ms} ms · ${mib} MiB wasm memory · exit code ${result.exitCode}`;
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
        : `TS${problem.code}`;
      item
        .querySelector('button')!
        .addEventListener('click', () => this.reveal(problem));
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

  private reveal(problem: Problem) {
    if (!problem.file || !this.models.has(problem.file)) return;
    this.openFile(problem.file);
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
    const { activeFile } = playgroundStore.getState();
    const label = this.$('#js-label');
    if (!this.lastResult) {
      label.textContent = 'Waiting for the first compile…';
      this.output.setValue('');
      return;
    }
    const target = isSourceFile(activeFile)
      ? outputPathFor(activeFile)
      : outputPathFor(ENTRY);
    const js = this.lastResult.outputs[target];
    label.textContent =
      js === undefined ? `${target} was not emitted` : target;
    if (this.output.getValue() !== (js ?? '')) this.output.setValue(js ?? '');
  }

  // ---- Running -----------------------------------------------------------------

  private run() {
    this.runAfterCheck = true;
    this.showPanel('console');
    this.check();
  }

  private execute(result: CompileResult) {
    const entry = outputPathFor(ENTRY);
    const modules = Object.fromEntries(
      Object.entries(result.outputs).filter(([path]) => /\.(m|c)?js$/.test(path))
    );
    const errors = result.diagnostics.filter((d) => d.category === 1).length;

    this.clearConsole();
    this.log(
      'system',
      errors
        ? `▶ Running ${entry} despite ${errors} type error${errors === 1 ? '' : 's'}`
        : `▶ Running ${entry}`
    );
    this.$<HTMLButtonElement>('#stop').disabled = false;
    this.runner.run({ modules, entry }, (message: RunMessage) => {
      switch (message.type) {
        case 'console':
          this.log(message.level, message.text);
          break;
        case 'error':
          this.log('error', message.text);
          break;
        case 'done':
          this.log(
            'system',
            `✓ Module evaluated in ${Math.round(message.durationMs)} ms (timers keep running until Stop or the next Run)`
          );
          break;
      }
    });
  }

  private stop() {
    if (!this.runner.running) return;
    this.runner.stop();
    this.$<HTMLButtonElement>('#stop').disabled = true;
    this.log('system', '■ Stopped');
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
  }
}

if (!customElements.get(PlaygroundPageComponent.tagName)) {
  customElements.define(PlaygroundPageComponent.tagName, PlaygroundPageComponent);
}
