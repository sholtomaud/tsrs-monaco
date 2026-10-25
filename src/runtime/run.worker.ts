// Executes the emitted JavaScript. A dedicated worker per run means user code
// can't touch the editor's page, and an infinite loop is ended by terminate().

import { formatArgs } from './format.ts';
import { link } from './module-graph.ts';
import type { ConsoleLevel, RunMessage, RunRequest } from './protocol.ts';

const post = (message: RunMessage) => self.postMessage(message);

const levels: ConsoleLevel[] = ['log', 'info', 'warn', 'error', 'debug'];
for (const level of levels) {
  const original = console[level];
  console[level] = (...args: unknown[]) => {
    // In development Vite's client also logs from inside the worker.
    if (import.meta.env.DEV && String(args[0]).startsWith('[vite]')) {
      return original(...args);
    }
    post({ type: 'console', level, text: formatArgs(args) });
  };
}
console.clear = () => {};

const describe = (error: unknown) =>
  error instanceof Error ? error.stack || String(error) : formatArgs([error]);

self.addEventListener('error', (event) => {
  event.preventDefault();
  post({ type: 'error', text: describe(event.error ?? event.message) });
});
self.addEventListener('unhandledrejection', (event) => {
  event.preventDefault();
  post({ type: 'error', text: `Uncaught (in promise) ${describe(event.reason)}` });
});

self.onmessage = async ({ data }: MessageEvent<RunRequest>) => {
  const started = performance.now();
  try {
    const url = link(data.modules, data.entry, (path, code) =>
      URL.createObjectURL(
        new Blob([`${code}\n//# sourceURL=${path}`], {
          type: 'text/javascript',
        })
      )
    );
    await import(/* @vite-ignore */ url);
    post({ type: 'done', durationMs: performance.now() - started });
  } catch (error) {
    post({ type: 'error', text: describe(error) });
  }
};
