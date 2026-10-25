// Runs tsrs off the main thread: the checker recurses deeply and a worker's
// stack is larger than the page's, and a slow check never blocks typing.

import { loadModule, tsc } from '@tsrs/wasm';
import wasmUrl from '@tsrs/wasm/tsrs.wasm?url';
import type { CompileRequest, CompilerMessage } from './protocol.ts';
import { PROJECT_ROOT, TSCONFIG, toAbsolute, toRelative } from './project.ts';

const post = (message: CompilerMessage) => self.postMessage(message);

const started = performance.now();
const module = Promise.resolve(loadModule(wasmUrl));
module.then(
  () => post({ type: 'ready', durationMs: performance.now() - started }),
  () => {} // Reported on the first compile instead.
);

async function compile({ id, files }: CompileRequest) {
  const t0 = performance.now();
  try {
    const absolute: Record<string, string> = {};
    for (const [path, text] of Object.entries(files)) {
      absolute[toAbsolute(path)] = text;
    }
    const result = await tsc(['-p', toAbsolute(TSCONFIG)], {
      cwd: PROJECT_ROOT,
      files: absolute,
      diagnostics: 'json',
      module: await module,
    });
    const outputs: Record<string, string> = {};
    for (const [path, text] of Object.entries(result.files ?? {})) {
      outputs[toRelative(path)] = text;
    }
    post({
      type: 'result',
      id,
      result: {
        exitCode: result.exitCode,
        diagnostics: result.diagnostics ?? [],
        outputs,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: performance.now() - t0,
        memoryBytes: result.memoryBytes,
      },
    });
  } catch (error) {
    post({ type: 'failure', id, message: String(error) });
  }
}

// Each call instantiates a fresh module; run them one at a time so memory
// stays bounded when edits arrive faster than checks finish.
let queue = Promise.resolve();
self.onmessage = (event: MessageEvent<CompileRequest>) => {
  queue = queue.then(() => compile(event.data));
};
