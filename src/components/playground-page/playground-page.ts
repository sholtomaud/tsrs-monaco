import { BaseComponent } from '../../core/base-component.ts';
import { monaco, languageOf } from '../../editor/monaco.ts';
import { getCompiler } from '../../compiler/compiler.ts';
import {
  ENTRY,
  TEST_FILE,
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
import { renderChart } from '../../runtime/chart.ts';
import type { RunMessage, RunRequest, TestResult } from '../../runtime/protocol.ts';
import { DEFAULT_EXAMPLE, EXAMPLES, findExample } from '../../examples/index.ts';
import { loadExample, playgroundStore } from '../../store/playground-store.ts';
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

type Panel = 'console' | 'tests' | 'plot' | 'js' | 'problems';
type Mode = RunRequest['mode'];
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
  private runAfterCheck: Mode | null = null;
  private plotted = false;
  private mode: Mode = 'run';
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
    this.editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter,
      () => this.run('test')
    );
    // Same shortcuts when focus is outside the editor (e.g. on an output tab).
    this.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !e.defaultPrevented) {
        e.preventDefault();
        this.run(e.shiftKey ? 'test' : 'run');
      }
    });
    this.$('#run').addEventListener('click', () => this.run());
    this.$('#test').addEventListener('click', () => this.run('test'));
    this.renderExamplePicker();
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

  private renderExamplePicker() {
    const select = this.$<HTMLSelectElement>('#example');
    select.replaceChildren(
      ...EXAMPLES.map((example) => new Option(example.title, example.id))
    );
    select.value = playgroundStore.getState().exampleId;
    select.addEventListener('change', () => {
      const example = findExample(select.value);
      if (
        example &&
        window.confirm(`Replace your files with the "${example.title}" example?`)
      ) {
        this.loadProject(example.id);
      } else {
        select.value = playgroundStore.getState().exampleId;
      }
    });
  }

  private reset() {
    if (!window.confirm("Restore this example's original files?")) return;
    this.loadProject(playgroundStore.getState().exampleId);
  }

  private loadProject(exampleId: string) {
    this.stop();
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
    this.models.forEach((m) => m.dispose());
    this.models.clear();
    loadExample(findExample(exampleId) ?? DEFAULT_EXAMPLE);
    const { files, activeFile } = playgroundStore.getState();
    for (const [path, text] of Object.entries(files)) this.createModel(path, text);
    this.$<HTMLSelectElement>('#example').value = playgroundStore.getState().exampleId;
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

  private run(mode: Mode = 'run') {
    this.runAfterCheck = mode;
    this.showPanel(mode === 'test' ? 'tests' : 'console');
    this.check();
  }

  private execute(result: CompileResult, mode: Mode) {
    const modules = Object.fromEntries(
      Object.entries(result.outputs).filter(([path]) => /\.(m|c)?js$/.test(path))
    );
    const entries =
      mode === 'test'
        ? Object.keys(modules).filter((path) => TEST_FILE.test(path)).sort()
        : [outputPathFor(ENTRY)];
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

    let passed = 0;
    let failed = 0;
    this.$<HTMLButtonElement>('#stop').disabled = false;
    this.runner.run({ modules, mode, entries }, (message: RunMessage) => {
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
