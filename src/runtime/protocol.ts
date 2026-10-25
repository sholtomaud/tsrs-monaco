import type { Chart } from './chart.ts';

export type ConsoleLevel = 'log' | 'info' | 'warn' | 'error' | 'debug';

export interface RunRequest {
  modules: Record<string, string>;
  /** 'run' imports entries[0]; 'test' imports every entry and runs its tests. */
  mode: 'run' | 'test';
  entries: string[];
}

export interface TestResult {
  file: string;
  name: string;
  status: 'pass' | 'fail';
  error?: string;
  durationMs: number;
}

export type RunMessage =
  | { type: 'console'; level: ConsoleLevel; text: string }
  | { type: 'plot'; chart: Chart }
  | { type: 'test'; result: TestResult }
  | { type: 'tests-done'; passed: number; failed: number; durationMs: number }
  | { type: 'done'; durationMs: number }
  | { type: 'error'; text: string };
