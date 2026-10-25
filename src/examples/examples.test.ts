// Compiles every example with the real @tsrs/wasm (its Node build), then runs
// the example's entry and *.test.ts files with the playground's globals, the
// same way the run worker does in the browser.

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { tsc } from '@tsrs/wasm';
import { EXAMPLES } from './index.ts';
import { ENTRY, PROJECT_ROOT, TEST_FILE, TSCONFIG, outputPathFor, toAbsolute, toRelative } from '../compiler/project.ts';
import { createLinker } from '../runtime/module-graph.ts';
import { expect } from '../runtime/expect.ts';
import { toChart, type Chart, type PlotOptions, type Series } from '../runtime/chart.ts';

async function compile(files: Record<string, string>) {
  const absolute = Object.fromEntries(
    Object.entries(files).map(([path, text]) => [toAbsolute(path), text])
  );
  const result = await tsc(['-p', toAbsolute(TSCONFIG)], {
    cwd: PROJECT_ROOT,
    files: absolute,
    diagnostics: 'json',
  });
  const outputs = Object.fromEntries(
    Object.entries(result.files ?? {}).map(([path, text]) => [toRelative(path), text])
  );
  return { diagnostics: result.diagnostics ?? [], outputs };
}

const linkerFor = (outputs: Record<string, string>) =>
  createLinker(
    outputs,
    (_path, code) => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
  );

for (const example of EXAMPLES) {
  describe(`example: ${example.title}`, () => {
    let compiled: Awaited<ReturnType<typeof compile>>;

    test('type checks cleanly with tsrs', async () => {
      compiled = await compile(example.files);
      assert.deepStrictEqual(
        compiled.diagnostics.map((d) => `${d.fileName}: ${d.text}`),
        []
      );
      assert.ok(compiled.outputs[outputPathFor(ENTRY)], 'entry was emitted');
    });

    test('runs and its own tests pass', async (t) => {
      const charts: Chart[] = [];
      const tests: { name: string; fn: () => unknown }[] = [];
      const g = globalThis as Record<string, unknown>;
      g.expect = expect;
      g.plot = (s: Series | Series[], o?: PlotOptions) => charts.push(toChart(s, o));
      g.test = (name: string, fn: () => unknown) => tests.push({ name, fn });
      t.mock.method(console, 'log', () => {});
      t.mock.method(console, 'info', () => {});

      const link = linkerFor(compiled.outputs);
      await import(link(outputPathFor(ENTRY)));
      const testFiles = Object.keys(compiled.outputs).filter((p) => TEST_FILE.test(p));
      assert.ok(testFiles.length > 0, 'the example has tests');
      for (const file of testFiles) await import(link(file));

      assert.ok(tests.length > 0);
      for (const { name, fn } of tests) {
        await assert.doesNotReject(async () => fn(), `test "${name}"`);
      }
      if (example.id === 'odum-cash') {
        assert.strictEqual(charts.length, 1);
        assert.strictEqual(charts[0].series[0].points.length, 241);
      }
    });
  });
}
