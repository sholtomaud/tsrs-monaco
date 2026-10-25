// Executes the emitted JavaScript. A dedicated worker per run means user code
// can't touch the editor's page, and an infinite loop is ended by terminate().
// User code also gets three globals, declared in the examples' playground.d.ts:
// plot(), test() and expect().

import { toChart, type PlotOptions, type Series } from './chart.ts';
import { expect } from './expect.ts';
import { formatArgs } from './format.ts';
import { createLinker } from './module-graph.ts';
import type { ConsoleLevel, RunMessage, RunRequest } from './protocol.ts';

const TEST_TIMEOUT_MS = 5000;

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

interface RegisteredTest {
  file: string;
  name: string;
  fn: () => unknown;
}

const registered: RegisteredTest[] = [];
let currentFile = '';

Object.assign(globalThis, {
  expect,
  plot(series: Series | Series[], options?: PlotOptions) {
    post({ type: 'plot', chart: toChart(series, options) });
  },
  test(name: string, fn: () => unknown) {
    // Outside test mode, test() calls are ignored, like a test runner's
    // registrations being harmless when a file is imported normally.
    if (currentFile) registered.push({ file: currentFile, name: String(name), fn });
  },
});

async function runTest({ file, name, fn }: RegisteredTest) {
  const started = performance.now();
  let timer = 0;
  try {
    await Promise.race([
      fn(),
      new Promise((_, reject) => {
        timer = self.setTimeout(
          () => reject(new Error(`Timed out after ${TEST_TIMEOUT_MS} ms`)),
          TEST_TIMEOUT_MS
        );
      }),
    ]);
    post({
      type: 'test',
      result: { file, name, status: 'pass', durationMs: performance.now() - started },
    });
    return true;
  } catch (error) {
    post({
      type: 'test',
      result: {
        file,
        name,
        status: 'fail',
        error: describe(error),
        durationMs: performance.now() - started,
      },
    });
    return false;
  } finally {
    self.clearTimeout(timer);
  }
}

self.onmessage = async ({ data }: MessageEvent<RunRequest>) => {
  const started = performance.now();
  try {
    const linkEntry = createLinker(data.modules, (path, code) =>
      URL.createObjectURL(
        new Blob([`${code}\n//# sourceURL=${path}`], {
          type: 'text/javascript',
        })
      )
    );

    if (data.mode === 'run') {
      await import(/* @vite-ignore */ linkEntry(data.entries[0]));
      post({ type: 'done', durationMs: performance.now() - started });
      return;
    }

    let passed = 0;
    let failed = 0;
    for (const file of data.entries) {
      currentFile = file;
      try {
        await import(/* @vite-ignore */ linkEntry(file));
      } catch (error) {
        failed++;
        post({
          type: 'test',
          result: {
            file,
            name: '(loading the file)',
            status: 'fail',
            error: describe(error),
            durationMs: 0,
          },
        });
      }
    }
    currentFile = '';
    for (const t of registered) {
      if (await runTest(t)) passed++;
      else failed++;
    }
    post({
      type: 'tests-done',
      passed,
      failed,
      durationMs: performance.now() - started,
    });
  } catch (error) {
    post({ type: 'error', text: describe(error) });
  }
};
