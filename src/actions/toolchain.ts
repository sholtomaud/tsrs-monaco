// What a workflow's commands run on: tsrs for type checking and emit, and
// the playground's run worker for tests and scripts. The browser provides
// one (browser-toolchain.ts); unit tests provide a fake.

import type { TsrsDiagnostic } from '../compiler/diagnostics.ts';
import type { ProjectFiles } from '../compiler/project.ts';
import type { ConsoleLevel, TestResult } from '../runtime/protocol.ts';

export interface CompileOutput {
  exitCode: number;
  diagnostics: TsrsDiagnostic[];
  /** Emitted files, relative to the project root (dist/…). */
  outputs: Record<string, string>;
  /** Problems fetching npm declaration files. */
  warnings?: string[];
}

export interface Toolchain {
  /** e.g. "tsrs 0.18.0 (TypeScript 7.1.0)". */
  description: string;
  typescriptVersion: string;
  compile(files: ProjectFiles, signal?: AbortSignal): Promise<CompileOutput>;
  /** Runs the given emitted test files (dist/*.test.js). */
  test(
    files: ProjectFiles,
    compiled: CompileOutput,
    entries: string[],
    onConsole: (level: ConsoleLevel, text: string) => void,
    signal?: AbortSignal
  ): Promise<{ passed: number; failed: number; results: TestResult[]; error?: string }>;
  /** Runs one emitted module (dist/index.js) until it has been evaluated. */
  run(
    files: ProjectFiles,
    compiled: CompileOutput,
    entry: string,
    onConsole: (level: ConsoleLevel, text: string) => void,
    signal?: AbortSignal
  ): Promise<{ ok: boolean; error?: string }>;
}
