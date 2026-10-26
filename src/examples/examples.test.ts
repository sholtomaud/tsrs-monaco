// Compiles every example with the real @tsrs/wasm (its Node build), then runs
// the example's entry and *.test.ts files with the playground's globals, the
// same way the run worker does in the browser. Examples that import npm
// packages need the network (types from jsDelivr, code from CDNs), so they
// are covered by e2e/npm-examples.live.spec.ts instead.

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { tsc } from '@tsrs/wasm';
import { EXAMPLES } from './index.ts';
import { PROJECT_ROOT, TEST_FILE, TSCONFIG, entryFile, outputPathFor, toAbsolute, toRelative } from '../compiler/project.ts';
import { createLinker, dirname, joinPath, relativeImports } from '../runtime/module-graph.ts';
import { expect } from '../runtime/expect.ts';
import { toChart, type Chart, type PlotOptions, type Series } from '../runtime/chart.ts';
import { projectImports } from '../packages/package-manager.ts';
import { buildSite, isWebApp } from '../preview/site.ts';

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
  const npm = [...new Set(projectImports(example.files).map((i) => i.name))];
  if (npm.length) {
    test(`example: ${example.title}`, {
      skip: `imports ${npm.join(', ')} from npm; run LIVE_CDN=1 npx playwright test e2e/npm-examples.live.spec.ts`,
    });
    continue;
  }
  describe(`example: ${example.title}`, () => {
    let compiled: Awaited<ReturnType<typeof compile>>;

    test('type checks cleanly with tsrs', async () => {
      compiled = await compile(example.files);
      assert.deepStrictEqual(
        compiled.diagnostics.map((d) => `${d.fileName}: ${d.text}`),
        []
      );
      assert.ok(compiled.outputs[outputPathFor(entryFile(example.files))], 'entry was emitted');
    });

    if (isWebApp(example.files)) {
      // Web apps need a page, so they run in the Preview tab (covered by e2e).
      test('every import in its preview site resolves', () => {
        const site = buildSite(example.files, compiled.outputs, {
          root: '/preview/app/',
          tailwindUrl: '/tailwind.js',
        });
        const served = new Set(site.map((f) => f.path));
        assert.ok(served.has(entryFile(example.files).replace(/\.ts$/, '.js')));
        for (const file of site.filter((f) => f.path.endsWith('.js'))) {
          for (const spec of relativeImports(file.body)) {
            const target = joinPath(dirname(file.path), spec);
            // import './a.css' is served as the module a.css?import.
            const module = target.endsWith('.css') ? `${target}?import` : target;
            assert.ok(served.has(module), `${file.path} imports ${spec}, which is not served`);
          }
        }
      });
      return;
    }

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
      await import(link(outputPathFor(entryFile(example.files))));
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
