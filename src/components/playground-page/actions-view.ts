// The Workflows side bar view and the Workflow output panel: lists the
// active project's .github/workflows/*.yml, runs them in the browser for a
// chosen event, and shows each run's jobs, steps, logs and annotations.

import type { ProjectFiles } from '../../compiler/project.ts';
import { browserToolchain } from '../../actions/browser-toolchain.ts';
import { runWorkflow, type Conclusion, type JobRun, type RunStatus, type WorkflowRun } from '../../actions/runner.ts';
import { WORKFLOW_DIR, starterWorkflow, projectWorkflows, triggeredBy, type SimulatedEvent, type Workflow } from '../../actions/workflow.ts';
import type { RepoLink } from '../../github/repository.ts';
import { codicon, type CodiconName } from '../../workspace/icons.ts';
import { h } from './dom.ts';

export interface ActionsHost {
  project(): string;
  files(): ProjectFiles;
  link(): RepoLink | undefined;
  actor(): string | undefined;
  openFile(path: string, line?: number, column?: number): void;
  addFile(path: string, text: string): void;
  showPanel(): void;
}

export const EVENTS = ['pull_request', 'push', 'workflow_dispatch'] as const;

const STATUS_ICON: Record<Conclusion | RunStatus, { icon: CodiconName; label: string }> = {
  success: { icon: 'passFilled', label: 'Succeeded' },
  failure: { icon: 'error', label: 'Failed' },
  cancelled: { icon: 'circleSlash', label: 'Cancelled' },
  skipped: { icon: 'circleSlash', label: 'Skipped' },
  queued: { icon: 'circleFilled', label: 'Queued' },
  in_progress: { icon: 'sync', label: 'In progress' },
  completed: { icon: 'passFilled', label: 'Completed' },
};

export const stateOf = (r: { status: RunStatus; conclusion?: Conclusion }) => (r.status === 'completed' ? (r.conclusion ?? 'success') : r.status);

function statusIcon(state: Conclusion | RunStatus) {
  const { icon, label } = STATUS_ICON[state];
  const el = codicon(icon, `run-status run-${state}`);
  el.setAttribute('title', label);
  el.removeAttribute('aria-hidden');
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', label);
  return el;
}

/** A step that only matters on GitHub (installing Node or packages). */
function noopIcon() {
  const el = codicon('circleSlash', 'run-status run-noop');
  el.setAttribute('title', 'Not needed in the browser: on GitHub this step sets up the runner');
  el.removeAttribute('aria-hidden');
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', 'Not needed in the browser');
  return el;
}

const seconds = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

interface ProjectRuns {
  runs: Map<string, WorkflowRun>;
  selected: string | null;
  controller: AbortController | null;
}

export class ActionsView {
  private sidebar: HTMLElement;
  private panel: HTMLElement;
  private host: ActionsHost;
  private projects = new Map<string, ProjectRuns>();
  private event: SimulatedEvent['name'] = 'pull_request';
  private branch = '';
  /** Steps the user expanded or collapsed: "workflow|job|step". */
  private open = new Set<string>();
  private closed = new Set<string>();
  private frame = 0;

  constructor(sidebar: HTMLElement, panel: HTMLElement, host: ActionsHost) {
    this.sidebar = sidebar;
    this.panel = panel;
    this.host = host;
  }

  private state(project = this.host.project()): ProjectRuns {
    let s = this.projects.get(project);
    if (!s) {
      s = { runs: new Map(), selected: null, controller: null };
      this.projects.set(project, s);
    }
    return s;
  }

  get running(): boolean {
    return !!this.state().controller;
  }

  private simulatedEvent(): SimulatedEvent {
    return { name: this.event, branch: this.branch.trim() || this.host.link()?.base || 'main' };
  }

  /** Runs every workflow the event triggers; resolves to their runs. */
  async runAll(event: SimulatedEvent = this.simulatedEvent()): Promise<WorkflowRun[]> {
    const workflows = projectWorkflows(this.host.files()).filter((w) => w.errors.length || triggeredBy(w, event).runs);
    const runs: WorkflowRun[] = [];
    for (const w of workflows) {
      const run = await this.run(w, event);
      if (run) runs.push(run);
      if (run?.conclusion === 'cancelled') break;
    }
    return runs;
  }

  async run(workflow: Workflow, event: SimulatedEvent = this.simulatedEvent()): Promise<WorkflowRun | null> {
    const project = this.host.project();
    const state = this.state(project);
    if (state.controller) return null;
    const controller = new AbortController();
    state.controller = controller;
    const link = this.host.link();
    const { run, done } = runWorkflow({
      workflow,
      event,
      files: this.host.files(),
      toolchain: browserToolchain,
      repository: link ? `${link.owner}/${link.repo}` : `local/${project}`,
      actor: this.host.actor(),
      signal: controller.signal,
      onUpdate: () => this.schedule(),
    });
    state.runs.set(workflow.path, run);
    state.selected = workflow.path;
    this.host.showPanel();
    this.render();
    try {
      return await done;
    } catch (error) {
      run.status = 'completed';
      run.conclusion = 'failure';
      run.annotations.push({ level: 'error', message: `The emulator failed: ${(error as Error).message}`, job: '' });
      return run;
    } finally {
      state.controller = null;
      this.render();
    }
  }

  cancel() {
    this.state().controller?.abort();
  }

  /** Last runs of the active project, by workflow path. */
  lastRuns(): WorkflowRun[] {
    return [...this.state().runs.values()];
  }

  private schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  /** Re-renders both views: call when the project or its files change. */
  render() {
    this.renderSidebar();
    this.renderPanel();
  }

  // ---- Side bar --------------------------------------------------------------

  private renderSidebar() {
    const files = this.host.files();
    const workflows = projectWorkflows(files);
    const state = this.state();
    const running = !!state.controller;
    const event = this.simulatedEvent();

    const eventSelect = h('select', {
      id: 'workflow-event',
      class: 'view-input',
      'aria-label': 'Event',
      onchange: (e: Event) => {
        this.event = (e.target as HTMLSelectElement).value;
        this.render();
      },
    }, ...EVENTS.map((name) => h('option', { value: name, selected: name === this.event }, name)));
    const branch = h('input', {
      id: 'workflow-branch',
      class: 'view-input',
      'aria-label': this.event === 'pull_request' ? 'Base branch' : 'Branch',
      placeholder: this.host.link()?.base ?? 'main',
      value: this.branch,
      spellcheck: false,
      onchange: (e: Event) => {
        this.branch = (e.target as HTMLInputElement).value;
        this.render();
      },
    });

    const list = h('ul', { class: 'workflow-list', 'aria-label': 'Workflows' });
    for (const w of workflows) {
      const run = state.runs.get(w.path);
      const trigger = w.errors.length ? null : triggeredBy(w, event);
      const row = h('li', { class: 'workflow', 'data-path': w.path, 'data-selected': state.selected === w.path ? 'true' : 'false' },
        h('div', { class: 'workflow-row' },
          run ? statusIcon(stateOf(run)) : codicon('githubAction', 'run-status'),
          h('button', {
            class: 'workflow-name',
            title: `Show the last run of ${w.path}`,
            onclick: () => {
              state.selected = w.path;
              this.host.showPanel();
              this.render();
            },
          }, w.name, h('span', { class: 'workflow-file' }, w.path.slice(WORKFLOW_DIR.length))),
          h('button', { class: 'icon-button', title: `Open ${w.path}`, 'aria-label': `Open ${w.path}`, onclick: () => this.host.openFile(w.path) }, codicon('edit')),
          h('button', {
            class: 'icon-button workflow-run',
            title: `Run ${w.name} for ${event.name}`,
            'aria-label': `Run ${w.name}`,
            disabled: running,
            onclick: () => void this.run(w),
          }, codicon('play'))
        ),
        w.errors.length
          ? h('ul', { class: 'workflow-errors' }, ...w.errors.map((e) => h('li', {}, h('button', { onclick: () => this.host.openFile(w.path, e.line) }, `${e.line ? `Line ${e.line}: ` : ''}${e.message}`))))
          : trigger && !trigger.runs ? h('p', { class: 'workflow-note' }, `Not run for ${event.name}: ${trigger.reason}.`) : null,
        run ? this.jobList(run, w.path) : null
      );
      list.append(row);
    }

    const triggered = workflows.filter((w) => !w.errors.length && triggeredBy(w, event).runs).length;
    this.sidebar.replaceChildren(
      h('div', { class: 'sidebar-title' },
        h('h2', {}, 'Workflows'),
        h('div', { class: 'sidebar-actions' },
          h('button', { id: 'run-workflows', class: 'icon-button', title: `Run all workflows for ${event.name}`, 'aria-label': 'Run All Workflows', disabled: running || !triggered, onclick: () => void this.runAll() }, codicon('runAll')),
          h('button', { class: 'icon-button', title: 'Cancel the run', 'aria-label': 'Cancel', disabled: !running, onclick: () => this.cancel() }, codicon('debugStop')),
          h('button', { class: 'icon-button', title: 'New Workflow…', 'aria-label': 'New Workflow', onclick: () => this.addWorkflow() }, codicon('newFile'))
        )
      ),
      h('div', { class: 'view-body' },
        h('p', { class: 'view-text' }, 'Run the project\'s GitHub Actions workflows here, in your browser, before you open a pull request.'),
        h('label', { class: 'view-label' }, 'Event', eventSelect),
        h('label', { class: 'view-label' }, this.event === 'pull_request' ? 'Base branch' : 'Branch', branch),
        workflows.length
          ? list
          : h('div', { class: 'view-empty' },
            h('p', {}, `${this.host.project()} has no workflows in ${WORKFLOW_DIR}.`),
            h('button', { class: 'tree-hint', onclick: () => this.addWorkflow() }, 'Add a CI workflow')
          )
      )
    );
  }

  private jobList(run: WorkflowRun, path: string) {
    return h('ul', { class: 'job-list' }, ...run.jobs.map((job) =>
      h('li', {},
        h('button', {
          class: 'job-row',
          'data-job': job.key,
          'data-state': stateOf(job),
          onclick: () => {
            this.state().selected = path;
            this.host.showPanel();
            this.renderPanel();
            this.panel.querySelector(`[data-job-key="${CSS.escape(job.key)}"]`)?.scrollIntoView({ block: 'start' });
          },
        }, statusIcon(stateOf(job)), h('span', { class: 'job-name' }, job.name), job.status === 'completed' && job.durationMs ? h('span', { class: 'job-time' }, seconds(job.durationMs)) : null)
      )
    ));
  }

  private addWorkflow() {
    const files = this.host.files();
    let path = `${WORKFLOW_DIR}ci.yml`;
    for (let i = 2; files[path] !== undefined; i++) path = `${WORKFLOW_DIR}ci-${i}.yml`;
    this.host.addFile(path, starterWorkflow(files));
    this.render();
  }

  // ---- Panel -------------------------------------------------------------------

  private renderPanel() {
    const state = this.state();
    const run = state.selected ? state.runs.get(state.selected) : undefined;
    if (!run) {
      this.panel.replaceChildren(h('p', { class: 'panel-caption' }, 'Run a workflow from the Workflows view (in the activity bar) to see its jobs and logs here.'));
      return;
    }
    const scroller = this.panel.parentElement ?? this.panel;
    const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 24;
    const s = stateOf(run);
    const header = h('div', { class: 'run-header', 'data-state': s },
      statusIcon(s),
      h('div', { class: 'run-title' },
        h('strong', {}, run.name),
        h('span', {}, ` · ${run.event.name} → ${run.event.branch} · ${STATUS_ICON[s].label}${run.status === 'completed' ? ` in ${seconds(run.durationMs)}` : ''}`)
      ),
      run.status !== 'completed' ? h('button', { class: 'action', onclick: () => this.cancel() }, codicon('debugStop'), h('span', {}, 'Cancel')) : null
    );
    const notes: HTMLElement[] = [];
    if (run.notEmulated.length) {
      notes.push(h('div', { class: 'run-note', role: 'note' },
        codicon('info'),
        h('span', {}, `Partly emulated: ${run.notEmulated.map((n) => `${n.tool} (${n.detail})`).join('; ')}. GitHub will run these for real.`)
      ));
    }
    const annotations = run.annotations.length
      ? h('ul', { class: 'annotations', 'aria-label': 'Annotations' }, ...run.annotations.map((a) =>
        h('li', { 'data-level': a.level },
          h('button', {
            disabled: !a.file,
            title: a.file ? `Open ${a.file}${a.line ? `:${a.line}` : ''}` : undefined,
            onclick: () => a.file && this.host.openFile(a.file, a.line, a.col),
          },
          codicon(a.level === 'error' ? 'error' : a.level === 'warning' ? 'warning' : 'info'),
          h('span', { class: 'annotation-message' }, `${a.title ? `${a.title}: ` : ''}${a.message}`),
          h('span', { class: 'annotation-where' }, [a.job, a.file && `${a.file}${a.line ? `:${a.line}` : ''}`].filter(Boolean).join(' · ')))
        )))
      : null;
    const jobs = run.jobs.map((job) => this.jobPanel(run, job));
    const artifacts = run.artifacts.length
      ? h('p', { class: 'panel-caption' }, `Artifacts: ${run.artifacts.map((a) => `${a.name} (${Object.keys(a.files).length} files)`).join(', ')}`)
      : null;
    this.panel.replaceChildren(header, ...notes, annotations ?? '', ...jobs, artifacts ?? '');
    if (atBottom && run.status !== 'completed') scroller.scrollTop = scroller.scrollHeight;
  }

  private jobPanel(run: WorkflowRun, job: JobRun) {
    const steps = job.steps.map((step, i) => {
      const key = `${run.workflow}|${job.key}|${i}`;
      const s = stateOf(step);
      // Failed and running steps open by themselves, unless the user closed them.
      const isOpen = this.open.has(key) || (!this.closed.has(key) && (s === 'failure' || s === 'in_progress'));
      const summary = h('summary', {},
        step.noop ? noopIcon() : statusIcon(s),
        h('span', { class: 'step-name' }, step.name),
        step.noop ? h('span', { class: 'step-note' }, 'not needed in the browser') : null,
        step.status === 'completed' && step.durationMs && !step.noop ? h('span', { class: 'job-time' }, seconds(step.durationMs)) : null);
      const details = h('details', { class: 'step', 'data-state': step.noop ? 'noop' : s, open: isOpen }, summary, step.log.length ? this.logView(step.log) : null);
      // Recorded on click, not on 'toggle' (which fires later), so a re-render in between keeps it.
      summary.addEventListener('click', () => {
        const opening = !details.open;
        (opening ? this.open : this.closed).add(key);
        (opening ? this.closed : this.open).delete(key);
      });
      return details;
    });
    return h('section', { class: 'job', 'data-job-key': job.key, 'data-state': stateOf(job) },
      h('h3', {}, statusIcon(stateOf(job)), job.name),
      ...steps,
      job.summary ? h('pre', { class: 'job-summary', 'aria-label': 'Job summary' }, job.summary) : null
    );
  }

  private logView(log: WorkflowRun['jobs'][number]['steps'][number]['log']) {
    const pre = h('div', { class: 'step-log', role: 'log' });
    let group: HTMLElement = pre;
    for (const line of log) {
      if (line.kind === 'group') {
        const d = h('details', { class: 'log-group' }, h('summary', {}, line.text));
        pre.append(d);
        group = d;
        continue;
      }
      if (line.kind === 'endgroup') {
        group = pre;
        continue;
      }
      group.append(h('div', { class: 'log-line', 'data-kind': line.kind }, line.kind === 'command' ? `$ ${line.text}` : line.text || ' '));
    }
    return pre;
  }
}
