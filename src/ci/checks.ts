// What the playground checks in a project: a tsrs type check (with npm
// declaration files from the CDN), the *.test.ts files with test() and
// expect(), and optionally the entry module. The CI page (ci.html, which the
// GitHub action drives with Playwright) and the workflow emulator both call
// this, so a project is checked the same way in CI and in the editor.

import { formatProblem, toProblem, type Problem } from '../compiler/diagnostics.ts';
import { TEST_FILE, entryFile, outputPathFor, type ProjectFiles } from '../compiler/project.ts';
import type { ConsoleLevel, TestResult } from '../runtime/protocol.ts';
import { isWebApp } from '../preview/site.ts';
import type { Toolchain } from '../actions/toolchain.ts';

export interface CheckOptions {
  /** Run the *.test.ts files (default true). */
  tests?: boolean;
  /** Run the entry module (src/index.ts) and collect its console output. */
  entry?: boolean;
  signal?: AbortSignal;
}

export interface ProjectCheck {
  typescriptVersion: string;
  compiler: string;
  problems: Problem[];
  errors: number;
  /** Problems fetching npm declaration files. */
  warnings: string[];
  tests: TestResult[] | null;
  passed: number;
  failed: number;
  /** Why the tests could not run at all. */
  testError?: string;
  /** Console output of the tests. */
  testConsole: { level: ConsoleLevel; text: string }[];
  entry: { file: string; ok: boolean; error?: string; console: { level: ConsoleLevel; text: string }[] } | null;
  /** True when there are no type errors, failed tests or entry errors. */
  ok: boolean;
}

export async function checkProject(toolchain: Toolchain, files: ProjectFiles, options: CheckOptions = {}): Promise<ProjectCheck> {
  const compiled = await toolchain.compile(files, options.signal);
  const problems = compiled.diagnostics.map(toProblem);
  const errors = problems.filter((p) => p.severity === 'error').length;
  const check: ProjectCheck = {
    typescriptVersion: toolchain.typescriptVersion,
    compiler: toolchain.description,
    problems,
    errors,
    warnings: compiled.warnings ?? [],
    tests: null,
    passed: 0,
    failed: 0,
    testConsole: [],
    entry: null,
    ok: errors === 0,
  };

  if (options.tests !== false) {
    const entries = Object.keys(compiled.outputs).filter((p) => TEST_FILE.test(p)).sort();
    if (!entries.length) {
      check.tests = [];
    } else {
      const outcome = await toolchain.test(files, compiled, entries, (level, text) => check.testConsole.push({ level, text }), options.signal);
      check.tests = outcome.results;
      check.passed = outcome.passed;
      check.failed = outcome.failed;
      check.testError = outcome.error;
      if (outcome.failed || outcome.error) check.ok = false;
    }
  }

  if (options.entry) {
    const file = entryFile(files);
    const output: { level: ConsoleLevel; text: string }[] = [];
    if (isWebApp(files)) {
      check.entry = { file, ok: true, console: [{ level: 'info', text: `${file} is a web app's entry; it runs in the Preview, not here.` }] };
    } else {
      const outcome = await toolchain.run(files, compiled, outputPathFor(file), (level, text) => output.push({ level, text }), options.signal);
      check.entry = { file, ok: outcome.ok, error: outcome.error, console: output };
      if (!outcome.ok) check.ok = false;
    }
  }
  return check;
}

/** Test file names as the project has them (src/a.test.ts, not dist/a.test.js). */
export const sourceOf = (file: string) => file.replace(/^dist\//, 'src/').replace(/\.js$/, '.ts');

/** A check as a CI log: problems, tests and the entry's output, like a test runner prints them. */
export function formatCheck(check: ProjectCheck): string[] {
  const lines = [`Type checked with ${check.compiler} (TypeScript ${check.typescriptVersion})`];
  for (const p of check.problems.filter((p) => p.severity === 'error' || p.severity === 'warning')) lines.push(formatProblem(p));
  for (const w of check.warnings) lines.push(`warning: ${w}`);
  lines.push(check.errors ? `Found ${check.errors} type error${check.errors === 1 ? '' : 's'}.` : 'No type errors.');
  if (check.tests) {
    if (!check.tests.length && !check.testError) lines.push('No test files (src/**/*.test.ts).');
    for (const t of check.tests) {
      lines.push(`${t.status === 'pass' ? '✔' : '✖'} ${t.name} (${Math.round(t.durationMs)} ms) — ${sourceOf(t.file)}`);
      if (t.error) lines.push(...t.error.split('\n').map((l) => `    ${l}`));
    }
    if (check.testError) lines.push(`Tests could not run: ${check.testError}`);
    if (check.tests.length) lines.push(`ℹ tests ${check.passed + check.failed}`, `ℹ pass ${check.passed}`, `ℹ fail ${check.failed}`);
  }
  if (check.entry) {
    lines.push(`▶ ${check.entry.file}`);
    for (const c of check.entry.console) lines.push(c.text);
    if (check.entry.error) lines.push(`✖ ${check.entry.error}`);
  }
  return lines;
}
