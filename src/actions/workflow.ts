// A workflow file (.github/workflows/*.yml) as the emulator runs it: its
// triggers, jobs (with needs, if, strategy.matrix, outputs) and steps.
// https://docs.github.com/actions/reference/workflows-and-actions/workflow-syntax

import { LineCounter, isMap, parseDocument, type Document } from 'yaml';
import { globToRegExp, type Value } from './expressions.ts';

export const WORKFLOW_DIR = '.github/workflows/';
export const isWorkflowFile = (path: string) =>
  path.startsWith(WORKFLOW_DIR) && /^[^/]+\.ya?ml$/.test(path.slice(WORKFLOW_DIR.length));

export interface Trigger {
  branches?: string[];
  branchesIgnore?: string[];
  paths?: string[];
  pathsIgnore?: string[];
  types?: string[];
  /** workflow_dispatch / workflow_call inputs, with their defaults. */
  inputs?: Record<string, { default?: Value; required?: boolean; type?: string; description?: string }>;
}

export interface Step {
  /** 0-based position in the job. */
  index: number;
  id?: string;
  name?: string;
  if?: string | boolean;
  uses?: string;
  run?: string;
  with: Record<string, Value>;
  env: Record<string, Value>;
  shell?: string;
  workingDirectory?: string;
  continueOnError: boolean | string;
  timeoutMinutes?: number;
}

export interface Job {
  id: string;
  name?: string;
  needs: string[];
  if?: string | boolean;
  runsOn: Value;
  container?: Value;
  services?: Value;
  env: Record<string, Value>;
  /** strategy.matrix, still unexpanded (it may hold expressions). */
  matrix?: Value;
  failFast: boolean;
  outputs: Record<string, string>;
  steps: Step[];
  continueOnError: boolean | string;
  /** A reusable workflow call (`jobs.<id>.uses`), which the emulator doesn't run. */
  uses?: string;
  defaults: { shell?: string; workingDirectory?: string };
}

export interface Workflow {
  path: string;
  name: string;
  on: Record<string, Trigger>;
  env: Record<string, Value>;
  jobs: Job[];
  defaults: { shell?: string; workingDirectory?: string };
  /** Problems that stop the workflow from running, with 1-based lines. */
  errors: { message: string; line?: number }[];
}

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const asStrings = (v: unknown): string[] | undefined =>
  v === undefined || v === null ? undefined : (Array.isArray(v) ? v : [v]).map(String);
const asValues = (v: unknown): Record<string, Value> => asRecord(v) as Record<string, Value>;

function parseTriggers(on: unknown): Record<string, Trigger> {
  if (typeof on === 'string') return { [on]: {} };
  if (Array.isArray(on)) return Object.fromEntries(on.map((e) => [String(e), {}]));
  const triggers: Record<string, Trigger> = {};
  for (const [event, config] of Object.entries(asRecord(on))) {
    const c = asRecord(config);
    triggers[event] = {
      branches: asStrings(c.branches),
      branchesIgnore: asStrings(c['branches-ignore']),
      paths: asStrings(c.paths),
      pathsIgnore: asStrings(c['paths-ignore']),
      types: asStrings(c.types),
      inputs: c.inputs ? (asRecord(c.inputs) as Trigger['inputs']) : undefined,
    };
  }
  return triggers;
}

const parseDefaults = (v: unknown) => {
  const run = asRecord(asRecord(v).run);
  return {
    shell: typeof run.shell === 'string' ? run.shell : undefined,
    workingDirectory: typeof run['working-directory'] === 'string' ? run['working-directory'] : undefined,
  };
};

function lineOf(doc: Document, lines: LineCounter, path: (string | number)[]): number | undefined {
  const node = doc.getIn(path, true) as { range?: [number, number, number] } | undefined;
  const offset = node?.range?.[0];
  return offset === undefined ? undefined : lines.linePos(offset).line;
}

export function parseSteps(raw: unknown, where: string, errors: Workflow['errors'], line?: (i: number) => number | undefined): Step[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((s, index) => {
    const step = asRecord(s);
    if (step.uses === undefined && step.run === undefined) {
      errors.push({ message: `${where}: step ${index + 1} needs either 'uses' or 'run'.`, line: line?.(index) });
    }
    if (step.uses !== undefined && step.run !== undefined) {
      errors.push({ message: `${where}: step ${index + 1} can't have both 'uses' and 'run'.`, line: line?.(index) });
    }
    return {
      index,
      id: step.id === undefined ? undefined : String(step.id),
      name: step.name === undefined ? undefined : String(step.name),
      if: step.if as string | boolean | undefined,
      uses: step.uses === undefined ? undefined : String(step.uses),
      run: step.run === undefined ? undefined : String(step.run),
      with: asValues(step.with),
      env: asValues(step.env),
      shell: typeof step.shell === 'string' ? step.shell : undefined,
      workingDirectory: typeof step['working-directory'] === 'string' ? step['working-directory'] : undefined,
      continueOnError: (step['continue-on-error'] as boolean | string | undefined) ?? false,
      timeoutMinutes: typeof step['timeout-minutes'] === 'number' ? step['timeout-minutes'] : undefined,
    };
  });
}

/** Parses a workflow file. Syntax and structure problems are returned in `errors`. */
export function parseWorkflow(path: string, text: string): Workflow {
  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines, uniqueKeys: true, prettyErrors: false });
  const fallbackName = path.split('/').pop()!.replace(/\.ya?ml$/, '');
  const workflow: Workflow = { path, name: fallbackName, on: {}, env: {}, jobs: [], defaults: {}, errors: [] };
  for (const error of doc.errors) {
    workflow.errors.push({ message: error.message.split('\n')[0], line: error.linePos?.[0].line });
  }
  if (workflow.errors.length) return workflow;
  if (!isMap(doc.contents)) {
    workflow.errors.push({ message: 'A workflow must be a mapping with `on` and `jobs`.' });
    return workflow;
  }
  const root = asRecord(doc.toJS({ maxAliasCount: 100 }));
  if (typeof root.name === 'string') workflow.name = root.name;
  if (root.on === undefined) workflow.errors.push({ message: "The workflow has no 'on' (its triggers)." });
  workflow.on = parseTriggers(root.on);
  workflow.env = asValues(root.env);
  workflow.defaults = parseDefaults(root.defaults);

  const jobs = asRecord(root.jobs);
  if (!Object.keys(jobs).length) {
    workflow.errors.push({ message: "The workflow has no 'jobs'.", line: lineOf(doc, lines, ['jobs']) });
  }
  for (const [id, raw] of Object.entries(jobs)) {
    const j = asRecord(raw);
    const strategy = asRecord(j.strategy);
    const outputs: Record<string, string> = {};
    for (const [k, v] of Object.entries(asRecord(j.outputs))) outputs[k] = String(v);
    const job: Job = {
      id,
      name: j.name === undefined ? undefined : String(j.name),
      needs: asStrings(j.needs) ?? [],
      if: j.if as string | boolean | undefined,
      runsOn: (j['runs-on'] ?? null) as Value,
      container: j.container as Value | undefined,
      services: j.services as Value | undefined,
      env: asValues(j.env),
      matrix: strategy.matrix as Value | undefined,
      failFast: strategy['fail-fast'] !== false,
      outputs,
      steps: parseSteps(j.steps, `jobs.${id}`, workflow.errors, (i) => lineOf(doc, lines, ['jobs', id, 'steps', i])),
      continueOnError: (j['continue-on-error'] as boolean | string | undefined) ?? false,
      uses: j.uses === undefined ? undefined : String(j.uses),
      defaults: parseDefaults(j.defaults),
    };
    if (!job.uses && !Array.isArray(j.steps)) {
      workflow.errors.push({ message: `jobs.${id} has no 'steps'.`, line: lineOf(doc, lines, ['jobs', id]) });
    }
    if (!job.uses && job.runsOn === null) {
      workflow.errors.push({ message: `jobs.${id} has no 'runs-on'.`, line: lineOf(doc, lines, ['jobs', id]) });
    }
    workflow.jobs.push(job);
  }
  for (const job of workflow.jobs) {
    for (const need of job.needs) {
      if (!jobs[need]) {
        workflow.errors.push({ message: `jobs.${job.id} needs '${need}', which is not a job in this workflow.`, line: lineOf(doc, lines, ['jobs', job.id, 'needs']) });
      }
    }
  }
  if (!workflow.errors.length) {
    try {
      jobOrder(workflow.jobs);
    } catch (error) {
      workflow.errors.push({ message: (error as Error).message });
    }
  }
  return workflow;
}

/** Jobs in waves: each wave only needs jobs of earlier waves. Throws on a cycle. */
export function jobOrder(jobs: Job[]): Job[][] {
  const waves: Job[][] = [];
  const done = new Set<string>();
  let remaining = [...jobs];
  while (remaining.length) {
    const ready = remaining.filter((j) => j.needs.every((n) => done.has(n)));
    if (!ready.length) throw new Error(`The jobs ${remaining.map((j) => j.id).join(', ')} need each other (a cycle).`);
    waves.push(ready);
    for (const j of ready) done.add(j.id);
    remaining = remaining.filter((j) => !ready.includes(j));
  }
  return waves;
}

/**
 * Expands strategy.matrix into its combinations: the product of its keys,
 * minus `exclude`, plus `include` (which extends matching combinations or adds new ones).
 */
export function expandMatrix(matrix: Value | undefined): Record<string, Value>[] {
  if (!matrix || typeof matrix !== 'object' || Array.isArray(matrix)) return [{}];
  const { include, exclude, ...axes } = matrix as Record<string, Value>;
  let combos: Record<string, Value>[] = [{}];
  for (const [key, values] of Object.entries(axes)) {
    const list = Array.isArray(values) ? values : [values];
    combos = combos.flatMap((c) => list.map((v) => ({ ...c, [key]: v })));
  }
  if (!Object.keys(axes).length) combos = [];
  const same = (a: Value, b: Value) => JSON.stringify(a) === JSON.stringify(b);
  if (Array.isArray(exclude)) {
    combos = combos.filter(
      (c) => !exclude.some((e) => e && typeof e === 'object' && Object.entries(e).every(([k, v]) => same(c[k], v as Value)))
    );
  }
  const original = combos.map((c) => ({ ...c }));
  if (Array.isArray(include)) {
    for (const entry of include) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const e = entry as Record<string, Value>;
      let matched = false;
      combos.forEach((c, i) => {
        // An include can add keys to a combination, but not overwrite its original matrix values.
        const fits = Object.entries(e).every(([k, v]) => !(k in original[i]) || same(original[i][k], v));
        if (fits) {
          Object.assign(c, e);
          matched = true;
        }
      });
      if (!matched) combos.push({ ...e });
    }
  }
  return combos.length ? combos : [{}];
}

/** The event a run simulates. */
export interface SimulatedEvent {
  name: string;
  /** The branch pushed to, or the pull request's base branch. */
  branch: string;
  /** Changed files, for `paths` filters; unknown means filters on paths pass. */
  changedPaths?: string[];
}

function matchesFilter(value: string, include?: string[], ignore?: string[]): boolean {
  if (include) {
    // Patterns apply in order; a later !pattern can exclude what an earlier one matched.
    let matched = false;
    for (const p of include) {
      if (p.startsWith('!')) {
        if (globToRegExp(p.slice(1)).test(value)) matched = false;
      } else if (globToRegExp(p).test(value)) matched = true;
    }
    if (!matched) return false;
  }
  if (ignore && ignore.some((p) => globToRegExp(p).test(value))) return false;
  return true;
}

/** Whether the workflow runs for the event, and if not, why. */
export function triggeredBy(workflow: Workflow, event: SimulatedEvent): { runs: true } | { runs: false; reason: string } {
  const trigger = workflow.on[event.name];
  if (!trigger) return { runs: false, reason: `it doesn't run on ${event.name} (on: ${Object.keys(workflow.on).join(', ') || 'nothing'})` };
  if (!matchesFilter(event.branch, trigger.branches, trigger.branchesIgnore)) {
    return { runs: false, reason: `its ${event.name} branch filter doesn't match ${event.branch}` };
  }
  if (event.changedPaths && (trigger.paths || trigger.pathsIgnore)) {
    const any = event.changedPaths.some((p) => matchesFilter(p, trigger.paths, trigger.pathsIgnore));
    if (!any) return { runs: false, reason: `none of the changed files match its paths filter` };
  }
  return { runs: true };
}

/** The workflows of a project, sorted by path. */
export function projectWorkflows(files: Record<string, string>): Workflow[] {
  return Object.keys(files)
    .filter(isWorkflowFile)
    .sort()
    .map((path) => parseWorkflow(path, files[path]));
}

/** A starter CI workflow for a playground project. */
export const STARTER_WORKFLOW = `name: CI

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 25.x
      - run: npm ci
      - name: Type check
        run: npx tsc -p tsconfig.json
      - name: Tests
        run: npm test
`;
