// A Toolchain for unit tests: the real @tsrs/wasm (its Node build), and
// tests run in this process with the playground's test() and expect(), the
// way src/examples/examples.test.ts runs the examples.

import { tsc } from '@tsrs/wasm';
import tsrsPackage from '@tsrs/wasm/package.json' with { type: 'json' };
import { PROJECT_ROOT, TSCONFIG, toAbsolute, toRelative } from '../compiler/project.ts';
import { createLinker } from '../runtime/module-graph.ts';
import { expect } from '../runtime/expect.ts';
import { formatArgs } from '../runtime/format.ts';
import type { TestResult } from '../runtime/protocol.ts';
import type { Toolchain } from './toolchain.ts';

let nonce = 0;

function linker(outputs: Record<string, string>) {
  const run = ++nonce;
  // A nonce per run, so a module imported again registers its tests again.
  return createLinker(outputs, (_path, code) => `data:text/javascript;base64,${Buffer.from(`${code}\n// run ${run}`).toString('base64')}`, {});
}

async function withConsole<T>(onConsole: (level: 'log' | 'error', text: string) => void, fn: () => Promise<T>): Promise<T> {
  const { log, info, warn, error } = console;
  console.log = console.info = (...a: unknown[]) => onConsole('log', formatArgs(a));
  console.warn = console.error = (...a: unknown[]) => onConsole('error', formatArgs(a));
  try {
    return await fn();
  } finally {
    Object.assign(console, { log, info, warn, error });
  }
}

export const nodeToolchain: Toolchain = {
  description: `tsrs ${tsrsPackage.version.replace(/-ts.*/, '')} (Node.js)`,
  typescriptVersion: tsrsPackage.tsrs.typescriptVersion,
  async compile(files) {
    const absolute = Object.fromEntries(Object.entries(files).map(([p, t]) => [toAbsolute(p), t]));
    const result = await tsc(['-p', toAbsolute(TSCONFIG)], { cwd: PROJECT_ROOT, files: absolute, diagnostics: 'json' });
    const outputs = Object.fromEntries(Object.entries(result.files ?? {}).map(([p, t]) => [toRelative(p), t]));
    return { exitCode: result.exitCode, diagnostics: result.diagnostics ?? [], outputs };
  },
  async test(_files, compiled, entries, onConsole) {
    const link = linker(compiled.outputs);
    const registered: { file: string; name: string; fn: () => unknown }[] = [];
    const g = globalThis as Record<string, unknown>;
    const results: TestResult[] = [];
    return withConsole(onConsole, async () => {
      g.expect = expect;
      g.plot = () => {};
      for (const file of entries) {
        g.test = (name: string, fn: () => unknown) => registered.push({ file, name, fn });
        try {
          await import(link(file));
        } catch (error) {
          results.push({ file, name: '(loading the file)', status: 'fail', error: String(error), durationMs: 0 });
        }
      }
      for (const t of registered) {
        try {
          await t.fn();
          results.push({ file: t.file, name: t.name, status: 'pass', durationMs: 0 });
        } catch (error) {
          results.push({ file: t.file, name: t.name, status: 'fail', error: String(error), durationMs: 0 });
        }
      }
      const failed = results.filter((r) => r.status === 'fail').length;
      return { passed: results.length - failed, failed, results };
    });
  },
  async run(_files, compiled, entry, onConsole) {
    const g = globalThis as Record<string, unknown>;
    g.plot = () => {};
    g.test = () => {};
    return withConsole(onConsole, async () => {
      try {
        await import(linker(compiled.outputs)(entry));
        return { ok: true };
      } catch (error) {
        return { ok: false, error: String(error) };
      }
    });
  },
};
