// The toolchain workflows run on in the browser: the playground's tsrs
// compiler worker, its npm type acquisition, and a fresh run worker for each
// test or script run (terminated when it finishes, times out or is cancelled).

import tsrsPackage from '@tsrs/wasm/package.json' with { type: 'json' };
import { getCompiler } from '../compiler/compiler.ts';
import type { ProjectFiles } from '../compiler/project.ts';
import { getPackageManager } from '../packages/package-manager.ts';
import type { RunMessage, RunRequest, TestResult } from '../runtime/protocol.ts';
import { Runner } from '../runtime/runner.ts';
import type { CompileOutput, Toolchain } from './toolchain.ts';

const versions = new WeakMap<CompileOutput, Record<string, string>>();

function jsModules(outputs: Record<string, string>) {
  return Object.fromEntries(Object.entries(outputs).filter(([p]) => /\.(m|c)?js$/.test(p)));
}

/** Runs a request in its own worker; resolves when `isDone` says so. */
function runWorker(request: RunRequest, onMessage: (m: RunMessage) => boolean, signal?: AbortSignal): Promise<void> {
  const runner = new Runner();
  return new Promise<void>((resolve, reject) => {
    const finish = () => {
      runner.stop();
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    const abort = () => {
      runner.stop();
      reject(new DOMException('Cancelled', 'AbortError'));
    };
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort);
    runner.run(request, (m) => {
      if (onMessage(m)) finish();
    });
  });
}

export const browserToolchain: Toolchain = {
  description: `tsrs ${tsrsPackage.version.replace(/-ts.*/, '')} in WebAssembly`,
  typescriptVersion: tsrsPackage.tsrs.typescriptVersion,

  async compile(files: ProjectFiles) {
    const packages = getPackageManager();
    const acquisition = await packages.types(files);
    const compiler = getCompiler();
    compiler.setLibraries(acquisition.files);
    const result = await compiler.compile(files);
    const out: CompileOutput = { exitCode: result.exitCode, diagnostics: result.diagnostics, outputs: result.outputs, warnings: acquisition.errors };
    versions.set(out, acquisition.versions);
    return out;
  },

  async test(files, compiled, entries, onConsole, signal) {
    const modules = jsModules(compiled.outputs);
    const imports = await getPackageManager().runtimeImports(modules, files, versions.get(compiled) ?? {});
    const results: TestResult[] = [];
    let error: string | undefined;
    let summary = { passed: 0, failed: 0 };
    await runWorker({ modules, mode: 'test', entries, imports }, (m) => {
      if (m.type === 'console') onConsole(m.level, m.text);
      else if (m.type === 'test') results.push(m.result);
      else if (m.type === 'tests-done') {
        summary = { passed: m.passed, failed: m.failed };
        return true;
      } else if (m.type === 'error') {
        // An error after the tests were loaded (e.g. an unhandled rejection) fails the run.
        error = m.text.split('\n')[0];
        if (!results.length) return true;
      }
      return false;
    }, signal);
    if (error && !summary.failed) summary.failed++;
    return { ...summary, results, error: summary.passed + summary.failed === 0 ? error : undefined };
  },

  async run(files, compiled, entry, onConsole, signal) {
    const modules = jsModules(compiled.outputs);
    const imports = await getPackageManager().runtimeImports(modules, files, versions.get(compiled) ?? {});
    let error: string | undefined;
    await runWorker({ modules, mode: 'run', entries: [entry], imports }, (m) => {
      if (m.type === 'console') onConsole(m.level, m.text);
      else if (m.type === 'error') {
        error = m.text;
        return true;
      } else if (m.type === 'done') return true;
      return false;
    }, signal);
    return error ? { ok: false, error } : { ok: true };
  },
};
