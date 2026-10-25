export type ConsoleLevel = 'log' | 'info' | 'warn' | 'error' | 'debug';

export interface RunRequest {
  modules: Record<string, string>;
  entry: string;
}

export type RunMessage =
  | { type: 'console'; level: ConsoleLevel; text: string }
  | { type: 'done'; durationMs: number }
  | { type: 'error'; text: string };
