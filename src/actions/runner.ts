// Runs a workflow in the browser: jobs in `needs` order (matrix combinations
// one after another), each on a fresh in-memory runner whose workspace
// actions/checkout fills with the project's files. Steps get GitHub's
// contexts (github, env, matrix, needs, steps, …), `if:` conditions,
// continue-on-error, outputs via $GITHUB_OUTPUT, $GITHUB_ENV and
// $GITHUB_STEP_SUMMARY, and workflow commands (::error::, ::group::, …).

import type { ProjectFiles } from '../compiler/project.ts';
import { toolCommands, type JobHost } from './commands.ts';
import {
  ExpressionError,
  evaluateCondition,
  interpolateDeep,
  interpolateText,
  toText,
  truthy,
  type EvalContext,
  type JobStatus,
  type Value,
} from './expressions.ts';
import { Shell, VirtualFS, lookupCommands } from './shell.ts';
import type { Toolchain } from './toolchain.ts';
import {
  expandMatrix,
  jobOrder,
  parseSteps,
  triggeredBy,
  type Job,
  type SimulatedEvent,
  type Step,
  type Workflow,
} from './workflow.ts';
import { parseDocument } from 'yaml';

export type Conclusion = 'success' | 'failure' | 'cancelled' | 'skipped';
export type RunStatus = 'queued' | 'in_progress' | 'completed';

export type LogKind = 'out' | 'err' | 'command' | 'group' | 'endgroup' | 'error' | 'warning' | 'notice' | 'debug' | 'info';

export interface LogLine {
  kind: LogKind;
  text: string;
}

export interface Annotation {
  level: 'error' | 'warning' | 'notice';
  message: string;
  title?: string;
  file?: string;
  line?: number;
  col?: number;
  job: string;
}

export interface StepRun {
  name: string;
  status: RunStatus;
  conclusion?: Conclusion;
  /** The step's result before continue-on-error. */
  outcome?: Conclusion;
  log: LogLine[];
  durationMs: number;
}

export interface JobRun {
  /** Unique within the run: the job id, plus its matrix values. */
  key: string;
  id: string;
  name: string;
  matrix: Record<string, Value>;
  status: RunStatus;
  conclusion?: Conclusion;
  steps: StepRun[];
  outputs: Record<string, string>;
  summary: string;
  durationMs: number;
}

export interface WorkflowRun {
  workflow: string;
  name: string;
  event: SimulatedEvent;
  status: RunStatus;
  conclusion?: Conclusion;
  jobs: JobRun[];
  annotations: Annotation[];
  artifacts: { name: string; files: ProjectFiles }[];
  /** Tools the emulator stood in for or skipped: the run is only partly emulated. */
  notEmulated: { tool: string; detail: string }[];
  startedAt: number;
  durationMs: number;
}

export interface RunOptions {
  workflow: Workflow;
  event: SimulatedEvent;
  /** The project's files: what actions/checkout puts in the workspace. */
  files: ProjectFiles;
  toolchain: Toolchain;
  /** owner/repo, if the project is linked to a repository. */
  repository?: string;
  actor?: string;
  secrets?: Record<string, string>;
  vars?: Record<string, string>;
  /** workflow_dispatch inputs; defaults come from the workflow. */
  inputs?: Record<string, Value>;
  signal?: AbortSignal;
  /** Called after every change to the run, for the UI. */
  onUpdate?: (run: WorkflowRun) => void;
}

const STEP_TIMEOUT_MS = 5 * 60_000;
const FAKE_SHA = 'e83c5163316f89bfbde7d9ab23ca2e25604af290';

// ---- Workflow commands and file commands -----------------------------------

function parseProperties(text: string): Record<string, string> {
  const props: Record<string, string> = {};
  for (const part of text.split(',')) {
    const eq = part.indexOf('=');
    if (eq > 0) props[part.slice(0, eq).trim()] = decodeCommand(part.slice(eq + 1).trim());
  }
  return props;
}

const decodeCommand = (s: string) => s.replace(/%0D/gi, '\r').replace(/%0A/gi, '\n').replace(/%25/g, '%').replace(/%3A/gi, ':').replace(/%2C/gi, ',');

/** Parses `name=value` and `name<<DELIMITER` … `DELIMITER` lines ($GITHUB_OUTPUT, $GITHUB_ENV). */
export function parseFileCommand(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    if (!line.trim()) continue;
    const heredoc = /^([^=<]+)<<(.+)$/.exec(line);
    if (heredoc) {
      const [, name, delimiter] = heredoc;
      const value: string[] = [];
      for (i++; i < lines.length && lines[i].replace(/\r$/, '') !== delimiter; i++) value.push(lines[i]);
      out[name.trim()] = value.join('\n');
      continue;
    }
    const eq = line.indexOf('=');
    if (eq > 0) out[line.slice(0, eq).trim()] = line.slice(eq + 1);
  }
  return out;
}

// ---- Running -------------------------------------------------------------------

class Cancelled extends Error {}

export class WorkflowRunner {
  readonly run: WorkflowRun;
  private options: RunOptions;
  private masks: string[] = [];
  private artifactStore = new Map<string, ProjectFiles>();

  constructor(options: RunOptions) {
    this.options = options;
    this.run = {
      workflow: options.workflow.path,
      name: options.workflow.name,
      event: options.event,
      status: 'queued',
      jobs: [],
      annotations: [],
      artifacts: [],
      notEmulated: [],
      startedAt: Date.now(),
      durationMs: 0,
    };
    for (const v of Object.values(options.secrets ?? {})) if (v) this.masks.push(v);
  }

  private update() {
    this.run.durationMs = Date.now() - this.run.startedAt;
    this.options.onUpdate?.(this.run);
  }

  private get repository() {
    return this.options.repository ?? 'local/playground';
  }

  private inputs(): Record<string, Value> {
    const declared = this.options.workflow.on[this.options.event.name]?.inputs ?? {};
    const inputs: Record<string, Value> = {};
    for (const [name, spec] of Object.entries(declared)) inputs[name] = (spec?.default ?? (spec?.type === 'boolean' ? false : '')) as Value;
    return { ...inputs, ...this.options.inputs };
  }

  /** The github context. */
  private github(jobId: string): Record<string, Value> {
    const { event } = this.options;
    const [owner] = this.repository.split('/');
    const pr = event.name === 'pull_request' || event.name === 'pull_request_target';
    const head = 'tsrs-monaco/changes';
    const refName = pr ? '1/merge' : event.branch;
    return {
      event_name: event.name,
      event: pr
        ? { action: 'opened', number: 1, pull_request: { number: 1, title: 'Changes from tsrs × Monaco', base: { ref: event.branch, sha: FAKE_SHA }, head: { ref: head, sha: FAKE_SHA }, draft: false } }
        : event.name === 'workflow_dispatch'
          ? { inputs: this.inputs() }
          : { ref: `refs/heads/${event.branch}`, head_commit: { id: FAKE_SHA, message: 'Changes from tsrs × Monaco' } },
      ref: pr ? `refs/pull/${refName}` : `refs/heads/${event.branch}`,
      ref_name: refName,
      ref_type: 'branch',
      base_ref: pr ? event.branch : '',
      head_ref: pr ? head : '',
      sha: FAKE_SHA,
      repository: this.repository,
      repository_owner: owner,
      actor: this.options.actor ?? owner,
      triggering_actor: this.options.actor ?? owner,
      workflow: this.options.workflow.name,
      workflow_ref: `${this.repository}/${this.options.workflow.path}@refs/heads/${event.branch}`,
      job: jobId,
      run_id: String(this.run.startedAt),
      run_number: '1',
      run_attempt: '1',
      server_url: 'https://github.com',
      api_url: 'https://api.github.com',
      graphql_url: 'https://api.github.com/graphql',
      workspace: this.workspace,
      action: '',
      token: '***',
      retention_days: '90',
    };
  }

  private get workspace() {
    const name = this.repository.split('/')[1] ?? 'playground';
    return `/home/runner/work/${name}/${name}`;
  }

  private defaultEnv(jobId: string): Record<string, string> {
    const g = this.github(jobId);
    return {
      CI: 'true',
      HOME: '/home/runner',
      PATH: '/usr/local/bin:/usr/bin:/bin',
      GITHUB_ACTIONS: 'true',
      GITHUB_WORKSPACE: this.workspace,
      GITHUB_REPOSITORY: this.repository,
      GITHUB_REPOSITORY_OWNER: toText(g.repository_owner),
      GITHUB_EVENT_NAME: this.options.event.name,
      GITHUB_REF: toText(g.ref),
      GITHUB_REF_NAME: toText(g.ref_name),
      GITHUB_BASE_REF: toText(g.base_ref),
      GITHUB_HEAD_REF: toText(g.head_ref),
      GITHUB_SHA: FAKE_SHA,
      GITHUB_ACTOR: toText(g.actor),
      GITHUB_WORKFLOW: this.options.workflow.name,
      GITHUB_JOB: jobId,
      GITHUB_RUN_ID: toText(g.run_id),
      GITHUB_RUN_NUMBER: '1',
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_API_URL: 'https://api.github.com',
      RUNNER_OS: 'Linux',
      RUNNER_ARCH: 'X64',
      RUNNER_TEMP: '/home/runner/work/_temp',
      RUNNER_TOOL_CACHE: '/opt/hostedtoolcache',
    };
  }

  private mask(text: string): string {
    let out = text;
    for (const m of this.masks) if (m) out = out.split(m).join('***');
    return out;
  }

  async execute(): Promise<WorkflowRun> {
    const { workflow, event, signal } = this.options;
    this.run.status = 'in_progress';
    this.update();
    try {
      if (workflow.errors.length) {
        for (const e of workflow.errors) {
          this.run.annotations.push({ level: 'error', message: e.message, file: workflow.path, line: e.line, job: '' });
        }
        this.run.conclusion = 'failure';
        return this.run;
      }
      const trigger = triggeredBy(workflow, event);
      if (!trigger.runs) {
        this.run.annotations.push({ level: 'notice', message: `This workflow would not run: ${trigger.reason}.`, job: '' });
        this.run.conclusion = 'skipped';
        return this.run;
      }
      const results = new Map<string, { result: Conclusion; outputs: Record<string, string> }>();
      // Every job appears at once, queued, so the UI shows the whole run.
      const planned = new Map<string, JobRun[]>();
      for (const job of workflow.jobs) {
        const placeholder: JobRun = { key: job.id, id: job.id, name: job.name ?? job.id, matrix: {}, status: 'queued', steps: [], outputs: {}, summary: '', durationMs: 0 };
        planned.set(job.id, [placeholder]);
        this.run.jobs.push(placeholder);
      }
      this.update();
      for (const wave of jobOrder(workflow.jobs)) {
        for (const job of wave) {
          if (signal?.aborted) throw new Cancelled();
          results.set(job.id, await this.runJob(job, results, planned.get(job.id)![0]));
        }
      }
      const conclusions = [...results.values()].map((r) => r.result);
      this.run.conclusion = conclusions.includes('cancelled') ? 'cancelled' : conclusions.includes('failure') ? 'failure' : 'success';
    } catch (error) {
      if (!(error instanceof Cancelled)) throw error;
      this.run.conclusion = 'cancelled';
      for (const j of this.run.jobs) {
        if (j.status !== 'completed') {
          j.status = 'completed';
          j.conclusion = 'cancelled';
        }
        for (const s of j.steps) {
          if (s.status !== 'completed') {
            s.status = 'completed';
            s.conclusion = 'cancelled';
          }
        }
      }
    } finally {
      this.run.status = 'completed';
      this.update();
    }
    return this.run;
  }

  private needsContext(job: Job, results: Map<string, { result: Conclusion; outputs: Record<string, string> }>): Record<string, Value> {
    return Object.fromEntries(job.needs.map((n) => [n, { result: results.get(n)?.result ?? 'skipped', outputs: results.get(n)?.outputs ?? {} }]));
  }

  private async runJob(job: Job, results: Map<string, { result: Conclusion; outputs: Record<string, string> }>, placeholder: JobRun) {
    const needs = this.needsContext(job, results);
    const needResults = job.needs.map((n) => results.get(n)?.result);
    const status: JobStatus = needResults.includes('cancelled') ? 'cancelled' : needResults.some((r) => r === 'failure' || r === 'skipped') ? 'failure' : 'success';
    const base: EvalContext = {
      contexts: { github: this.github(job.id), needs, vars: this.options.vars ?? {}, inputs: this.inputs(), env: {}, secrets: {}, strategy: {}, matrix: {}, runner: {}, job: {}, steps: {} },
      status,
    };
    const finishPlaceholder = (conclusion: Conclusion, note?: string) => {
      placeholder.status = 'completed';
      placeholder.conclusion = conclusion;
      if (note) placeholder.steps.push({ name: note, status: 'completed', conclusion, log: [], durationMs: 0 });
      this.update();
      return { result: conclusion, outputs: {} };
    };

    let run: boolean;
    try {
      run = evaluateCondition(job.if, base);
    } catch (error) {
      this.annotate('error', `jobs.${job.id}.if: ${(error as Error).message}`, job.id);
      return finishPlaceholder('failure');
    }
    if (!run) return finishPlaceholder('skipped');
    if (job.uses) {
      this.notEmulated(`jobs.${job.id}.uses`, `reusable workflows (${job.uses}) are not emulated`);
      this.annotate('warning', `Reusable workflow ${job.uses} is not emulated; the job is skipped.`, job.id);
      return finishPlaceholder('skipped', `Reusable workflow ${job.uses} (not emulated)`);
    }

    let combos: Record<string, Value>[];
    try {
      const matrix = job.matrix === undefined ? undefined : interpolateDeep(job.matrix, base);
      combos = expandMatrix(matrix);
    } catch (error) {
      this.annotate('error', `jobs.${job.id}.strategy.matrix: ${(error as Error).message}`, job.id);
      return finishPlaceholder('failure');
    }

    // Replace the placeholder with one entry per combination.
    const index = this.run.jobs.indexOf(placeholder);
    const runs: JobRun[] = combos.map((matrix) => {
      const values = Object.values(matrix).filter((v) => typeof v !== 'object' || v === null).map(toText);
      return {
        key: values.length ? `${job.id} (${values.join(', ')})` : job.id,
        id: job.id,
        name: job.name ?? job.id,
        matrix,
        status: 'queued' as const,
        steps: [],
        outputs: {},
        summary: '',
        durationMs: 0,
      };
    });
    this.run.jobs.splice(index, 1, ...runs);
    this.update();

    const conclusions: Conclusion[] = [];
    const outputs: Record<string, string> = {};
    let failedFast = false;
    for (let i = 0; i < runs.length; i++) {
      const jobRun = runs[i];
      if (failedFast) {
        jobRun.status = 'completed';
        jobRun.conclusion = 'cancelled';
        conclusions.push('cancelled');
        continue;
      }
      const ctx: EvalContext = {
        ...base,
        contexts: { ...base.contexts, matrix: jobRun.matrix, strategy: { 'fail-fast': job.failFast, 'job-index': i, 'job-total': runs.length, 'max-parallel': 1 } },
      };
      if (runs.length > 1 && job.name) {
        try {
          jobRun.name = interpolateText(job.name, ctx);
        } catch {
          // Keep the raw name.
        }
      } else if (runs.length > 1) jobRun.name = jobRun.key;
      const result = await this.runOne(job, jobRun, ctx);
      conclusions.push(result);
      Object.assign(outputs, jobRun.outputs);
      if (result === 'failure' && job.failFast && !truthy(job.continueOnError as Value)) failedFast = true;
    }
    const result: Conclusion = conclusions.includes('failure') && !truthy(job.continueOnError as Value) ? 'failure' : conclusions.includes('cancelled') ? 'cancelled' : 'success';
    return { result, outputs };
  }

  private annotate(level: Annotation['level'], message: string, job: string, props: Partial<Annotation> = {}) {
    this.run.annotations.push({ level, message: this.mask(message), job, ...props });
  }

  private notEmulated(tool: string, detail: string) {
    if (!this.run.notEmulated.some((n) => n.tool === tool)) this.run.notEmulated.push({ tool, detail });
  }

  /** Runs one job (one matrix combination) on a fresh runner. */
  private async runOne(job: Job, jobRun: JobRun, ctx: EvalContext): Promise<Conclusion> {
    const started = Date.now();
    jobRun.status = 'in_progress';
    const fs = new VirtualFS();
    const workspace = this.workspace;
    fs.mkdir(workspace);
    fs.mkdir('/home/runner/work/_temp');
    let checkedOut: ProjectFiles | null = null;
    const host: JobHost = {
      toolchain: this.options.toolchain,
      workspace,
      checkedOut: () => checkedOut,
      notEmulated: (tool, detail) => this.notEmulated(tool, detail),
    };
    const workflowEnv = this.evalEnv(this.options.workflow.env, ctx);
    const env: Record<string, string> = { ...this.defaultEnv(job.id), ...workflowEnv };
    let jobEnv: Record<string, string>;
    try {
      jobEnv = this.evalEnv(job.env, { ...ctx, contexts: { ...ctx.contexts, env } });
    } catch (error) {
      this.annotate('error', `jobs.${job.id}.env: ${(error as Error).message}`, jobRun.key);
      jobRun.status = 'completed';
      jobRun.conclusion = 'failure';
      return 'failure';
    }
    Object.assign(env, jobEnv);
    const runner = { os: 'Linux', arch: 'X64', name: 'tsrs-monaco (emulated)', temp: '/home/runner/work/_temp', tool_cache: '/opt/hostedtoolcache', environment: 'github-hosted' };
    const steps: Record<string, Value> = {};
    let status: JobStatus = 'success';
    const path: string[] = [];

    const setup: StepRun = { name: 'Set up job', status: 'completed', conclusion: 'success', log: [], durationMs: 0 };
    setup.log.push({ kind: 'info', text: `Runner: ${runner.name} on ${this.options.toolchain.description}` });
    setup.log.push({ kind: 'info', text: `runs-on: ${toText(job.runsOn)} (emulated)` });
    if (Object.keys(jobRun.matrix).length) setup.log.push({ kind: 'info', text: `matrix: ${JSON.stringify(jobRun.matrix)}` });
    if (job.container) {
      setup.log.push({ kind: 'warning', text: 'container: is not emulated; steps run on the in-browser runner.' });
      this.notEmulated('container', 'job containers are not emulated');
    }
    if (job.services) {
      setup.log.push({ kind: 'warning', text: 'services: are not emulated.' });
      this.notEmulated('services', 'service containers are not emulated');
    }
    jobRun.steps.push(setup);
    const stepRuns = job.steps.map((s): StepRun => ({ name: this.stepTitle(s, ctx), status: 'queued', log: [], durationMs: 0 }));
    jobRun.steps.push(...stepRuns);
    this.update();

    const runSteps = async (list: Step[], records: StepRun[], scope: { steps: Record<string, Value>; inputs?: Record<string, Value>; actionPath?: string }) => {
      for (let i = 0; i < list.length; i++) {
        const step = list[i];
        const record = records[i];
        if (this.options.signal?.aborted) throw new Cancelled();
        const stepCtx: EvalContext = {
          contexts: {
            ...ctx.contexts,
            env: { ...env },
            runner,
            job: { status, container: {}, services: {} },
            steps: scope.steps,
            secrets: { GITHUB_TOKEN: '***', ...this.options.secrets },
            ...(scope.inputs ? { inputs: scope.inputs } : {}),
          },
          status,
          files: checkedOut ?? {},
        };
        let condition: boolean;
        try {
          condition = evaluateCondition(step.if, stepCtx);
        } catch (error) {
          condition = false;
          record.log.push({ kind: 'error', text: `if: ${(error as Error).message}` });
          this.annotate('error', `${record.name}: if: ${(error as Error).message}`, jobRun.key);
          status = 'failure';
        }
        if (!condition) {
          record.status = 'completed';
          record.conclusion = record.conclusion ?? 'skipped';
          record.outcome = 'skipped';
          if (step.id) scope.steps[step.id] = { outputs: {}, outcome: 'skipped', conclusion: 'skipped' };
          this.update();
          continue;
        }
        record.status = 'in_progress';
        this.update();
        const t0 = Date.now();
        const stepOutputs: Record<string, string> = {};
        let outcome: Conclusion;
        try {
          outcome = await this.runStep(step, record, stepCtx, { fs, env, path, workspace, host, stepOutputs, jobRun, scope, setCheckout: (files) => (checkedOut = files), job });
        } catch (error) {
          if (error instanceof Cancelled) throw error;
          record.log.push({ kind: 'error', text: (error as Error).message });
          this.annotate('error', `${record.name}: ${(error as Error).message}`, jobRun.key);
          outcome = 'failure';
        }
        let continueOnError = false;
        try {
          continueOnError = truthy(interpolateDeep(step.continueOnError, stepCtx));
        } catch {
          // Treat a bad expression as false.
        }
        record.outcome = outcome;
        record.conclusion = outcome === 'failure' && continueOnError ? 'success' : outcome;
        record.status = 'completed';
        record.durationMs = Date.now() - t0;
        if (step.id) scope.steps[step.id] = { outputs: stepOutputs, outcome, conclusion: record.conclusion };
        if (record.conclusion === 'failure') status = 'failure';
        this.update();
      }
    };

    try {
      await runSteps(job.steps, stepRuns, { steps });
    } catch (error) {
      if (error instanceof Cancelled) {
        jobRun.status = 'completed';
        jobRun.conclusion = 'cancelled';
        throw error;
      }
      throw error;
    }

    // Job outputs are evaluated after its steps.
    for (const [name, expr] of Object.entries(job.outputs)) {
      try {
        jobRun.outputs[name] = interpolateText(expr, { ...ctx, contexts: { ...ctx.contexts, steps, env, runner, job: { status } }, status });
      } catch (error) {
        this.annotate('error', `jobs.${job.id}.outputs.${name}: ${(error as Error).message}`, jobRun.key);
      }
    }
    jobRun.steps.push({ name: 'Complete job', status: 'completed', conclusion: 'success', log: [{ kind: 'info', text: `Job ${status === 'success' ? 'succeeded' : 'failed'} in ${((Date.now() - started) / 1000).toFixed(1)} s` }], durationMs: 0 });
    jobRun.status = 'completed';
    jobRun.conclusion = status === 'success' ? 'success' : 'failure';
    jobRun.durationMs = Date.now() - started;
    this.update();
    return jobRun.conclusion;
  }

  private stepTitle(step: Step, ctx: EvalContext): string {
    if (step.name) {
      try {
        return interpolateText(step.name, ctx);
      } catch {
        return step.name;
      }
    }
    if (step.uses) return `Run ${step.uses}`;
    return `Run ${(step.run ?? '').trim().split('\n')[0]}`;
  }

  private evalEnv(env: Record<string, Value>, ctx: EvalContext): Record<string, string> {
    return Object.fromEntries(Object.entries(env).map(([k, v]) => [k, toText(interpolateDeep(v, ctx))]));
  }

  private async runStep(
    step: Step,
    record: StepRun,
    ctx: EvalContext,
    job: {
      fs: VirtualFS;
      env: Record<string, string>;
      path: string[];
      workspace: string;
      host: JobHost;
      stepOutputs: Record<string, string>;
      jobRun: JobRun;
      scope: { steps: Record<string, Value>; inputs?: Record<string, Value>; actionPath?: string };
      setCheckout: (files: ProjectFiles) => void;
      job: Job;
    }
  ): Promise<Conclusion> {
    const stepEnv = { ...job.env, ...this.evalEnv(step.env, ctx) };
    if (step.uses) {
      const inputs = Object.fromEntries(Object.entries(step.with).map(([k, v]) => [k, toText(interpolateDeep(v, ctx))]));
      return this.runAction(step.uses, inputs, record, ctx, job, stepEnv);
    }
    const script = interpolateText(step.run ?? '', ctx);
    const shellName = step.shell ?? job.job.defaults.shell ?? this.options.workflow.defaults.shell ?? 'bash';
    if (!/^(bash|sh)\b/.test(shellName)) {
      record.log.push({ kind: 'warning', text: `shell: ${shellName} is not emulated (only bash and sh); the step is skipped.` });
      this.notEmulated(`shell: ${shellName}`, 'only bash and sh are emulated');
      return 'skipped';
    }
    const workingDirectory = step.workingDirectory ?? job.job.defaults.workingDirectory ?? this.options.workflow.defaults.workingDirectory;
    const cwd = workingDirectory ? VirtualFS.normalize(interpolateText(workingDirectory, ctx), job.workspace) : job.workspace;
    if (!job.fs.isDir(cwd)) {
      record.log.push({ kind: 'error', text: `working-directory ${cwd} does not exist (did the job check out the repository?)` });
      return 'failure';
    }
    for (const line of script.replace(/\n$/, '').split('\n')) record.log.push({ kind: 'command', text: line });
    return this.runShell(script, cwd, stepEnv, record, job, step.timeoutMinutes);
  }

  private async runShell(
    script: string,
    cwd: string,
    stepEnv: Record<string, string>,
    record: StepRun,
    job: { fs: VirtualFS; env: Record<string, string>; path: string[]; workspace: string; host: JobHost; stepOutputs: Record<string, string>; jobRun: JobRun },
    timeoutMinutes?: number
  ): Promise<Conclusion> {
    const id = Math.random().toString(36).slice(2);
    const files = {
      GITHUB_OUTPUT: `/home/runner/work/_temp/_runner_file_commands/set_output_${id}`,
      GITHUB_ENV: `/home/runner/work/_temp/_runner_file_commands/set_env_${id}`,
      GITHUB_PATH: `/home/runner/work/_temp/_runner_file_commands/add_path_${id}`,
      GITHUB_STEP_SUMMARY: `/home/runner/work/_temp/_runner_file_commands/step_summary_${id}`,
      GITHUB_STATE: `/home/runner/work/_temp/_runner_file_commands/save_state_${id}`,
    };
    for (const f of Object.values(files)) job.fs.write(f, '');
    const controller = new AbortController();
    const outer = this.options.signal;
    const onAbort = () => controller.abort();
    outer?.addEventListener('abort', onAbort);
    const timer = setTimeout(() => controller.abort(), (timeoutMinutes ?? STEP_TIMEOUT_MS / 60_000) * 60_000);
    const commands = toolCommands(job.host);
    const shell = new Shell({
      fs: job.fs,
      env: { ...stepEnv, ...files, PATH: [...job.path, stepEnv.PATH ?? ''].join(':') },
      cwd,
      commands: { ...commands, ...lookupCommands(() => Object.keys(commands)) },
      signal: controller.signal,
    });
    const sink = (kind: 'out' | 'err') => {
      let partial = '';
      return {
        write: (text: string) => {
          partial += text;
          const lines = partial.split('\n');
          partial = lines.pop()!;
          for (const line of lines) this.logLine(line, kind, record, job);
          this.update();
        },
        flush: () => {
          if (partial) this.logLine(partial, kind, record, job);
          partial = '';
        },
      };
    };
    const out = sink('out');
    const err = sink('err');
    let code: number;
    try {
      code = await shell.run(script, { stdin: '', stdout: out.write, stderr: err.write });
    } catch (error) {
      // A tool stopped by the timeout or Cancel; reported below.
      if (!controller.signal.aborted) throw error;
      code = 130;
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onAbort);
      out.flush();
      err.flush();
    }
    if (outer?.aborted) throw new Cancelled();
    if (controller.signal.aborted) {
      record.log.push({ kind: 'error', text: `The step timed out after ${timeoutMinutes ?? STEP_TIMEOUT_MS / 60_000} minutes.` });
      return 'failure';
    }
    this.applyFileCommands(job.fs, files, job);
    if (code !== 0) {
      record.log.push({ kind: 'error', text: `Process completed with exit code ${code}.` });
      return 'failure';
    }
    return 'success';
  }

  private applyFileCommands(fs: VirtualFS, files: Record<string, string>, job: { env: Record<string, string>; path: string[]; stepOutputs: Record<string, string>; jobRun: JobRun }) {
    Object.assign(job.stepOutputs, parseFileCommand(fs.read(files.GITHUB_OUTPUT) ?? ''));
    Object.assign(job.env, parseFileCommand(fs.read(files.GITHUB_ENV) ?? ''));
    job.path.unshift(...(fs.read(files.GITHUB_PATH) ?? '').split('\n').filter(Boolean));
    const summary = fs.read(files.GITHUB_STEP_SUMMARY) ?? '';
    if (summary) job.jobRun.summary += this.mask(summary);
  }

  /** A line of output: workflow commands (::error::, ::group::, …) are interpreted. */
  private logLine(raw: string, kind: 'out' | 'err', record: StepRun, job: { stepOutputs: Record<string, string>; jobRun: JobRun }) {
    const line = raw.replace(/\r$/, '');
    const command = /^::([\w-]+)(?: ([^:]*))?::(.*)$/.exec(line);
    if (!command) {
      record.log.push({ kind, text: this.mask(line) });
      return;
    }
    const [, name, props = '', message] = command;
    const text = decodeCommand(message);
    switch (name) {
      case 'error':
      case 'warning':
      case 'notice': {
        const p = parseProperties(props);
        record.log.push({ kind: name, text: this.mask(`${p.title ? `${p.title}: ` : ''}${text}`) });
        this.annotate(name, text, job.jobRun.key, {
          title: p.title,
          file: p.file,
          line: p.line ? Number(p.line) : undefined,
          col: p.col ? Number(p.col) : undefined,
        });
        return;
      }
      case 'group':
        record.log.push({ kind: 'group', text: this.mask(text) });
        return;
      case 'endgroup':
        record.log.push({ kind: 'endgroup', text: '' });
        return;
      case 'add-mask':
        if (text) this.masks.push(text);
        return;
      case 'debug':
        record.log.push({ kind: 'debug', text: this.mask(text) });
        return;
      case 'set-output': {
        const p = parseProperties(props);
        if (p.name) job.stepOutputs[p.name] = text;
        record.log.push({ kind: 'warning', text: 'The set-output command is deprecated; write to $GITHUB_OUTPUT.' });
        return;
      }
      default:
        record.log.push({ kind, text: this.mask(line) });
    }
  }

  // ---- uses: ---------------------------------------------------------------------

  private async runAction(
    uses: string,
    inputs: Record<string, string>,
    record: StepRun,
    ctx: EvalContext,
    job: Parameters<WorkflowRunner['runStep']>[3],
    stepEnv: Record<string, string>
  ): Promise<Conclusion> {
    const log = (kind: LogKind, text: string) => record.log.push({ kind, text });
    const [ref, version = ''] = uses.split('@');
    const name = ref.toLowerCase();
    log('command', `uses: ${uses}`);
    for (const [k, v] of Object.entries(inputs)) log('info', `  ${k}: ${k.includes('token') ? '***' : v}`);

    if (name.startsWith('./') || name.startsWith('../')) return this.runLocalAction(ref, inputs, record, ctx, job);
    if (name.startsWith('docker://')) {
      this.notEmulated(uses, 'Docker actions are not emulated');
      log('warning', 'Docker actions are not emulated; skipped.');
      return 'skipped';
    }

    switch (name) {
      case 'actions/checkout': {
        const into = VirtualFS.normalize(inputs.path ?? '.', job.workspace);
        for (const [path, text] of Object.entries(this.options.files)) job.fs.write(`${into}/${path}`, text);
        job.setCheckout({ ...this.options.files });
        const count = Object.keys(this.options.files).length;
        log('out', `Checked out ${count} file${count === 1 ? '' : 's'} of ${this.repository} (the project's current files, including unsaved changes) into ${into}`);
        if (inputs.repository && inputs.repository !== this.repository) {
          this.notEmulated(`checkout of ${inputs.repository}`, 'only the project itself can be checked out');
          log('warning', `repository: ${inputs.repository} can't be checked out here; the project's files were used.`);
        }
        return 'success';
      }
      case 'actions/setup-node': {
        const wanted = inputs['node-version'] || (inputs['node-version-file'] ? `from ${inputs['node-version-file']}` : 'the default');
        log('out', `Node.js ${wanted} requested; commands run on the playground's toolchain (${this.options.toolchain.description}).`);
        job.stepOutputs['node-version'] = 'v25.0.0';
        if (inputs.cache) log('out', `cache: ${inputs.cache} — nothing to cache, as nothing is installed.`);
        return 'success';
      }
      case 'actions/cache':
      case 'actions/cache/restore':
      case 'actions/cache/save':
        log('out', 'Emulated: no cache is kept between runs.');
        job.stepOutputs['cache-hit'] = 'false';
        return 'success';
      case 'actions/upload-artifact': {
        const files = this.collect(job.fs, inputs.path ?? '', job.workspace);
        const artifact = inputs.name || 'artifact';
        const count = Object.keys(files).length;
        if (!count && (inputs['if-no-files-found'] ?? 'warn') === 'error') {
          log('error', `No files were found with the provided path: ${inputs.path}.`);
          return 'failure';
        }
        if (!count) log('warning', `No files were found with the provided path: ${inputs.path}. No artifact will be uploaded.`);
        else {
          this.artifactStore.set(artifact, files);
          this.run.artifacts.push({ name: artifact, files });
          log('out', `Artifact ${artifact}: ${count} file${count === 1 ? '' : 's'} (kept with this run)`);
        }
        job.stepOutputs['artifact-id'] = String(this.run.artifacts.length);
        return 'success';
      }
      case 'actions/download-artifact': {
        const names = inputs.name ? [inputs.name] : [...this.artifactStore.keys()];
        const into = VirtualFS.normalize(inputs.path ?? '.', job.workspace);
        for (const n of names) {
          const files = this.artifactStore.get(n);
          if (!files) {
            log('error', `Artifact not found: ${n}`);
            return 'failure';
          }
          const dir = inputs.name ? into : `${into}/${n}`;
          for (const [p, text] of Object.entries(files)) job.fs.write(`${dir}/${p}`, text);
          log('out', `Downloaded ${n} into ${dir}`);
        }
        job.stepOutputs['download-path'] = into;
        return 'success';
      }
      case 'actions/configure-pages':
      case 'actions/upload-pages-artifact':
      case 'actions/deploy-pages':
        log('notice', `${ref} deploys, which never happens in the emulator; skipped.`);
        return 'skipped';
      default:
        this.notEmulated(uses, 'this action is not emulated');
        log('warning', `${ref}${version ? `@${version}` : ''} is not emulated in the browser; skipped.`);
        this.annotate('warning', `${uses} is not emulated; the step was skipped.`, job.jobRun.key, { title: 'Not emulated' });
        void stepEnv;
        return 'skipped';
    }
  }

  /** Files an upload-artifact `path:` names: files, directories or globs, one per line. */
  private collect(fs: VirtualFS, spec: string, workspace: string): ProjectFiles {
    const out: ProjectFiles = {};
    const all = fs.filesUnder(workspace);
    for (const raw of spec.split('\n').map((s) => s.trim()).filter(Boolean)) {
      const pattern = raw.replace(/^\.\//, '');
      if (/[*?]/.test(pattern)) {
        const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '§§').replace(/\*/g, '[^/]*').replace(/§§/g, '.*').replace(/\?/g, '.')}$`);
        for (const [p, t] of Object.entries(all)) if (re.test(p)) out[p] = t;
      } else {
        const abs = VirtualFS.normalize(pattern, workspace);
        if (fs.isFile(abs)) out[abs.split('/').pop()!] = fs.read(abs)!;
        else for (const [p, t] of Object.entries(fs.filesUnder(abs))) out[p] = t;
      }
    }
    return out;
  }

  /** A composite action in the project (uses: ./path/to/action). */
  private async runLocalAction(ref: string, inputs: Record<string, string>, record: StepRun, ctx: EvalContext, job: Parameters<WorkflowRunner['runStep']>[3]): Promise<Conclusion> {
    const dir = VirtualFS.normalize(ref, job.workspace);
    const text = job.fs.read(`${dir}/action.yml`) ?? job.fs.read(`${dir}/action.yaml`);
    if (text === undefined) {
      record.log.push({ kind: 'error', text: `Can't find action.yml in ${ref} (did the job check out the repository first?)` });
      return 'failure';
    }
    const action = parseDocument(text).toJS() as { inputs?: Record<string, { default?: string }>; runs?: { using?: string; steps?: unknown[] }; outputs?: Record<string, { value?: string }> } | null;
    if (action?.runs?.using !== 'composite') {
      this.notEmulated(ref, 'only composite local actions are emulated');
      record.log.push({ kind: 'warning', text: `${ref} uses ${action?.runs?.using ?? 'an unknown runtime'}; only composite actions are emulated. Skipped.` });
      return 'skipped';
    }
    const actionInputs: Record<string, Value> = {};
    for (const [k, spec] of Object.entries(action.inputs ?? {})) actionInputs[k] = spec?.default ?? '';
    Object.assign(actionInputs, inputs);
    const errors: { message: string }[] = [];
    const steps = parseSteps(action.runs.steps, ref, errors);
    if (errors.length) {
      for (const e of errors) record.log.push({ kind: 'error', text: e.message });
      return 'failure';
    }
    const stepsContext: Record<string, Value> = {};
    let failed = false;
    for (const step of steps) {
      const title = this.stepTitle(step, ctx);
      record.log.push({ kind: 'group', text: title });
      const inner: StepRun = { name: title, status: 'in_progress', log: [], durationMs: 0 };
      const innerCtx: EvalContext = { ...ctx, contexts: { ...ctx.contexts, inputs: actionInputs, steps: stepsContext }, status: failed ? 'failure' : 'success' };
      let outcome: Conclusion = 'skipped';
      const outputs: Record<string, string> = {};
      try {
        if (evaluateCondition(step.if, innerCtx)) {
          outcome = await this.runStep(step, inner, innerCtx, { ...job, stepOutputs: outputs });
        }
      } catch (error) {
        if (error instanceof Cancelled) throw error;
        inner.log.push({ kind: 'error', text: error instanceof ExpressionError ? error.message : String(error) });
        outcome = 'failure';
      }
      record.log.push(...inner.log, { kind: 'endgroup', text: '' });
      if (step.id) stepsContext[step.id] = { outputs, outcome, conclusion: outcome };
      if (outcome === 'failure') failed = true;
    }
    for (const [k, spec] of Object.entries(action.outputs ?? {})) {
      if (spec?.value) job.stepOutputs[k] = interpolateText(spec.value, { ...ctx, contexts: { ...ctx.contexts, inputs: actionInputs, steps: stepsContext } });
    }
    return failed ? 'failure' : 'success';
  }
}

/** Runs a workflow; see WorkflowRunner. */
export function runWorkflow(options: RunOptions): { run: WorkflowRun; done: Promise<WorkflowRun> } {
  const runner = new WorkflowRunner(options);
  return { run: runner.run, done: runner.execute() };
}
