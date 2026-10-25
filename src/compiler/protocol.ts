import type { TsrsDiagnostic } from './diagnostics.ts';
import type { ProjectFiles } from './project.ts';

export type CompilerRequest =
  | { type: 'compile'; id: number; files: ProjectFiles }
  /** Declaration files of npm packages, added to every compile until replaced. */
  | { type: 'libraries'; files: ProjectFiles };

export interface CompileResult {
  exitCode: number;
  diagnostics: TsrsDiagnostic[];
  /** Emitted files, keyed by path relative to the project root. */
  outputs: Record<string, string>;
  stdout: string;
  stderr: string;
  durationMs: number;
  memoryBytes: number;
}

export type CompilerMessage =
  | { type: 'ready'; durationMs: number }
  | { type: 'result'; id: number; result: CompileResult }
  | { type: 'failure'; id: number; message: string };
