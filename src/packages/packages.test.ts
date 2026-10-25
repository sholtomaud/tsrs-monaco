import { test, describe } from 'node:test';
import assert from 'node:assert';
import { bareImports, moduleReferences, parseBareSpecifier, typesPackageFor } from './specifiers.ts';
import { browserEntry, resolveExports, typesEntry } from './package-json.ts';
import { TypeAcquirer } from './type-acquisition.ts';
import { MemorySource } from './memory-source.ts';
import { isSelfContainedModule, JsDelivrSource, runtimeUrl } from './cdn.ts';
import { packageJsonError, PackageManager, projectImports, projectRanges } from './package-manager.ts';

describe('specifiers', () => {
  test('parses package names and subpaths', () => {
    assert.deepStrictEqual(parseBareSpecifier('onnxruntime-web'), { name: 'onnxruntime-web', subpath: '' });
    assert.deepStrictEqual(parseBareSpecifier('onnxruntime-web/webgpu'), { name: 'onnxruntime-web', subpath: '/webgpu' });
    assert.deepStrictEqual(parseBareSpecifier('@tensorflow/tfjs-core/dist/base'), {
      name: '@tensorflow/tfjs-core',
      subpath: '/dist/base',
    });
    for (const spec of ['./a', '../a', '/a', 'https://esm.sh/x', 'node:fs', 'fs', 'NHWC', '@scope']) {
      assert.strictEqual(parseBareSpecifier(spec), null, spec);
    }
  });

  test('finds imports but not ones in comments', () => {
    const code = [
      "import * as ort from 'onnxruntime-web';",
      "import type { Tensor } from '@tensorflow/tfjs-core';",
      "export * from './local';",
      "// copied from 'not-a-dependency'",
      "/* import x from 'nor-this' */",
      "const m = await import('lazy-pkg');",
      '/// <reference types="@webgpu/types" />',
    ].join('\n');
    assert.deepStrictEqual(
      bareImports(code).map((b) => b.name),
      ['onnxruntime-web', '@tensorflow/tfjs-core', 'lazy-pkg', '@webgpu/types']
    );
    assert.ok(moduleReferences(code).includes('./local'));
  });

  test('names DefinitelyTyped packages', () => {
    assert.strictEqual(typesPackageFor('lodash'), '@types/lodash');
    assert.strictEqual(typesPackageFor('@babel/core'), '@types/babel__core');
  });
});

describe('package.json resolution', () => {
  const ort = {
    types: './types.d.ts',
    exports: {
      '.': {
        types: './types.d.ts',
        node: { import: './dist/ort.node.min.mjs' },
        import: { 'onnxruntime-web-use-extern-wasm': './dist/ort.min.mjs', default: './dist/ort.bundle.min.mjs' },
        require: './dist/ort.min.js',
      },
      './webgpu': { types: './types.d.ts', import: { default: './dist/ort.webgpu.bundle.min.mjs' } },
      './features/*': './dist/features/*.js',
    },
  };

  test('follows exports conditions in object order', () => {
    assert.strictEqual(browserEntry(ort, ''), 'dist/ort.bundle.min.mjs');
    assert.strictEqual(browserEntry(ort, '/webgpu'), 'dist/ort.webgpu.bundle.min.mjs');
    assert.strictEqual(resolveExports(ort, '/features/a', ['import']), 'dist/features/a.js');
    assert.strictEqual(resolveExports(ort, '/missing', ['import']), null);
  });

  test('finds declarations from types fields, exports and sibling .d.ts files', () => {
    const has = (files: string[]) => (p: string) => files.includes(p);
    assert.strictEqual(typesEntry(ort, '', has(['types.d.ts'])), 'types.d.ts');
    const common = { exports: { require: './dist/cjs/index.js', import: './dist/esm/index.js' } };
    assert.strictEqual(typesEntry(common, '', has(['dist/esm/index.d.ts'])), 'dist/esm/index.d.ts');
    const tfjs = { types: 'dist/index.d.ts', module: 'dist/index.js' };
    assert.strictEqual(typesEntry(tfjs, '/dist/base', has(['dist/base.d.ts'])), 'dist/base.d.ts');
    assert.strictEqual(typesEntry({ main: 'lib/x.js' }, '', has(['lib/x.d.ts'])), 'lib/x.d.ts');
    assert.strictEqual(typesEntry({ main: 'x.js' }, '', has([])), null);
  });
});

const pkg = (json: object, files: Record<string, string> = {}) => ({
  'package.json': JSON.stringify(json),
  ...files,
});

describe('TypeAcquirer', () => {
  const source = () =>
    new MemorySource({
      app: {
        '1.0.0': pkg(
          { name: 'app', types: 'index.d.ts', dependencies: { dep: '^2.0.0' } },
          {
            'index.d.ts': "export * from './lib/a';\n/// <reference path=\"globals.d.ts\" />\nexport { D } from 'dep';",
            'lib/a.d.ts': "import type { B } from './b.js';\nexport type A = B;",
            'lib/b.d.ts': 'export type B = 1;',
            'globals.d.ts': 'declare var APP: string;',
            'unused.d.ts': 'export {};',
            'index.js': 'export {}',
          }
        ),
      },
      dep: {
        '2.0.0': pkg({ name: 'dep', types: 'dep.d.ts' }, { 'dep.d.ts': 'export type D = 2;' }),
        '3.0.0': pkg({ name: 'dep', types: 'dep.d.ts' }, { 'dep.d.ts': 'export type D = 3;' }),
      },
      untyped: { '1.0.0': pkg({ name: 'untyped', main: 'index.js' }, { 'index.js': '' }) },
      '@types/untyped': {
        '1.0.0': pkg({ name: '@types/untyped', types: 'index.d.ts' }, { 'index.d.ts': 'export const u: 1;' }),
      },
    });

  test('fetches the declarations an import reaches, and nothing else', async () => {
    const s = source();
    const result = await new TypeAcquirer(s).acquire([{ name: 'app', subpath: '' }]);
    assert.deepStrictEqual(Object.keys(result.files).sort(), [
      'node_modules/app/globals.d.ts',
      'node_modules/app/index.d.ts',
      'node_modules/app/lib/a.d.ts',
      'node_modules/app/lib/b.d.ts',
      'node_modules/app/package.json',
      'node_modules/dep/dep.d.ts',
      'node_modules/dep/package.json',
    ]);
    // The dependency's version comes from app's dependency range.
    assert.deepStrictEqual(result.versions, { app: '1.0.0', dep: '2.0.0' });
    assert.ok(!s.requests.some((r) => r.includes('unused')));
    assert.deepStrictEqual(result.errors, []);
  });

  test('honours project version ranges', async () => {
    const result = await new TypeAcquirer(source()).acquire([{ name: 'dep', subpath: '' }], { dep: '3.0.0' });
    assert.strictEqual(result.files['node_modules/dep/dep.d.ts'], 'export type D = 3;');
  });

  test('falls back to @types and reports what it cannot find', async () => {
    const acquirer = new TypeAcquirer(source());
    const result = await acquirer.acquire([
      { name: 'untyped', subpath: '' },
      { name: 'missing-pkg', subpath: '' },
    ]);
    assert.ok(result.files['node_modules/@types/untyped/index.d.ts']);
    assert.strictEqual(result.errors.length, 1);
    assert.match(result.errors[0], /missing-pkg/);
  });

  test('returns only what the current imports need', async () => {
    const acquirer = new TypeAcquirer(source());
    await acquirer.acquire([{ name: 'untyped', subpath: '' }]);
    const result = await acquirer.acquire([{ name: 'app', subpath: '' }]);
    assert.ok(!Object.keys(result.files).some((p) => p.includes('untyped')));
    assert.deepStrictEqual(Object.keys(result.versions).sort(), ['app', 'dep']);
  });

  test('fetches each file once across calls', async () => {
    const s = source();
    const acquirer = new TypeAcquirer(s);
    await acquirer.acquire([{ name: 'app', subpath: '' }]);
    const count = s.requests.length;
    await acquirer.acquire([{ name: 'app', subpath: '' }, { name: 'dep', subpath: '' }], {
      dep: '^2.0.0',
    });
    assert.strictEqual(s.requests.length, count);
  });

  test('a version the project imports directly wins, and ranges can change', async () => {
    const acquirer = new TypeAcquirer(source());
    const app = { name: 'app', subpath: '' };
    const dep = { name: 'dep', subpath: '' };
    let result = await acquirer.acquire([app, dep]);
    assert.strictEqual(result.versions.dep, '3.0.0');
    assert.strictEqual(result.files['node_modules/dep/dep.d.ts'], 'export type D = 3;');
    // Editing package.json to pin an older version is picked up.
    result = await acquirer.acquire([dep], { dep: '2.0.0' });
    assert.strictEqual(result.files['node_modules/dep/dep.d.ts'], 'export type D = 2;');
  });
});

describe('CDN', () => {
  test('recognises bundled ES modules', () => {
    assert.ok(isSelfContainedModule('var a=1;export{a as Tensor};'));
    assert.ok(isSelfContainedModule('const e=new Error(`conversion from \'int32\' to`);export default e;'));
    assert.ok(isSelfContainedModule('export const f=()=>import("./ort-wasm.mjs");'));
    assert.ok(!isSelfContainedModule("import { x } from 'seedrandom';\nexport { x };"));
    assert.ok(!isSelfContainedModule("export * from './ops/ops';"));
    assert.ok(!isSelfContainedModule('export const f=()=>import("long");'));
    assert.ok(!isSelfContainedModule('module.exports = {};'));
  });

  test('loads bundles from jsDelivr and everything else from esm.sh', async () => {
    const s = new MemorySource({
      bundled: { '1.0.0': pkg({ exports: { '.': { import: './dist/b.mjs' } } }, { 'dist/b.mjs': 'export const b=1;' }) },
      split: { '1.0.0': pkg({ module: 'dist/index.js' }, { 'dist/index.js': "export * from './x.js';" }) },
    });
    assert.strictEqual(await runtimeUrl(s, 'bundled', '1.0.0', ''), 'https://cdn.jsdelivr.net/npm/bundled@1.0.0/dist/b.mjs');
    assert.strictEqual(await runtimeUrl(s, 'split', '1.0.0', ''), 'https://esm.sh/split@1.0.0');
    assert.strictEqual(await runtimeUrl(s, 'gone', '1.0.0', '/x'), 'https://esm.sh/gone@1.0.0/x');
  });

  test('JsDelivrSource calls the jsDelivr APIs and caches responses', async () => {
    const urls: string[] = [];
    const responses: Record<string, unknown> = {
      'https://data.jsdelivr.com/v1/packages/npm/@scope/pkg/resolved?specifier=%5E1.0.0': { version: '1.2.3' },
      'https://data.jsdelivr.com/v1/packages/npm/@scope/pkg@1.2.3?structure=flat': { files: [{ name: '/index.d.ts' }] },
      'https://cdn.jsdelivr.net/npm/@scope/pkg@1.2.3/index.d.ts': 'export {};',
    };
    const source = new JsDelivrSource(async (url) => {
      urls.push(url);
      const body = responses[url];
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: body ? 200 : 404 });
    });
    assert.strictEqual(await source.resolveVersion('@scope/pkg', '^1.0.0'), '1.2.3');
    assert.strictEqual(await source.resolveVersion('@scope/pkg', '1.2.3'), '1.2.3');
    assert.deepStrictEqual(await source.listFiles('@scope/pkg', '1.2.3'), ['index.d.ts']);
    assert.strictEqual(await source.readFile('@scope/pkg', '1.2.3', 'index.d.ts'), 'export {};');
    await source.readFile('@scope/pkg', '1.2.3', 'index.d.ts');
    await assert.rejects(source.readFile('@scope/pkg', '1.2.3', 'nope.d.ts'), /404/);
    assert.strictEqual(urls.length, 4);
  });
});

describe('PackageManager', () => {
  test('reads imports and version ranges from the project', () => {
    const files = {
      'package.json': '{ "dependencies": { "a": "^1.0.0" } }',
      'src/index.ts': "import a from 'a';\nimport b from 'b/sub';\nimport './local.ts';",
      'src/env.d.ts': "/// <reference types=\"c\" />",
      'tsconfig.json': '{}',
    };
    assert.deepStrictEqual(projectRanges(files), { a: '^1.0.0' });
    assert.strictEqual(packageJsonError(files), null);
    assert.match(packageJsonError({ 'package.json': '{ "a": }' })!, /not valid JSON/);
    assert.strictEqual(packageJsonError({}), null);
    assert.deepStrictEqual(projectImports(files), [
      { name: 'a', subpath: '' },
      { name: 'b', subpath: '/sub' },
      { name: 'c', subpath: '' },
    ]);
  });

  test('maps emitted imports to runtime URLs using the typed versions', async () => {
    const manager = new PackageManager(
      new MemorySource({
        a: {
          '1.0.0': pkg({ exports: { import: './a.mjs' } }, { 'a.mjs': 'export default 1;' }),
          '2.0.0': pkg({ exports: { import: './a.mjs' } }, { 'a.mjs': 'export default 2;' }),
        },
      })
    );
    const urls = await manager.runtimeImports(
      { 'dist/index.js': "import a from 'a';\nimport b from 'b';" },
      {},
      { a: '1.0.0' }
    );
    assert.deepStrictEqual(urls, {
      a: 'https://cdn.jsdelivr.net/npm/a@1.0.0/a.mjs',
      b: 'https://esm.sh/b',
    });
  });
});
