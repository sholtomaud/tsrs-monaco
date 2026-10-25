import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  joinPath,
  link,
  LinkError,
  relativeImports,
  resolveSpecifier,
} from './module-graph.ts';

describe('joinPath', () => {
  test('normalises . and .. segments', () => {
    assert.strictEqual(joinPath('dist/a', './b.js'), 'dist/a/b.js');
    assert.strictEqual(joinPath('dist/a', '../b.js'), 'dist/b.js');
  });
});

describe('resolveSpecifier', () => {
  const modules = { 'dist/a.js': '', 'dist/lib/index.js': '' };
  test('resolves exact, extensionless and directory imports', () => {
    assert.strictEqual(resolveSpecifier(modules, 'dist/x.js', './a.js'), 'dist/a.js');
    assert.strictEqual(resolveSpecifier(modules, 'dist/x.js', './a'), 'dist/a.js');
    assert.strictEqual(resolveSpecifier(modules, 'dist/x.js', './lib'), 'dist/lib/index.js');
    assert.strictEqual(resolveSpecifier(modules, 'dist/x.js', './nope'), null);
  });
});

describe('relativeImports', () => {
  test('finds static, side-effect, re-export and dynamic imports', () => {
    const code = [
      "import { a } from './a.js';",
      "import './side.js';",
      "export * from '../up.js';",
      "export { b } from './b.js';",
      "const m = await import('./lazy.js');",
      "import x from 'https://esm.sh/x';",
    ].join('\n');
    assert.deepStrictEqual(relativeImports(code), [
      './a.js',
      './side.js',
      '../up.js',
      './b.js',
      './lazy.js',
    ]);
  });
});

describe('link', () => {
  test('rewrites imports to dependency URLs, dependencies first', () => {
    const order: string[] = [];
    const out: Record<string, string> = {};
    const url = link(
      {
        'dist/index.js': "import { g } from './greet.js';\ng();",
        'dist/greet.js': "export const g = () => {};",
      },
      'dist/index.js',
      (path, code) => {
        order.push(path);
        out[path] = code;
        return `blob:${path}`;
      }
    );
    assert.strictEqual(url, 'blob:dist/index.js');
    assert.deepStrictEqual(order, ['dist/greet.js', 'dist/index.js']);
    assert.strictEqual(out['dist/index.js'], "import { g } from 'blob:dist/greet.js';\ng();");
  });

  test('links shared dependencies once', () => {
    let calls = 0;
    link(
      {
        'a.js': "import './b.js'; import './c.js';",
        'b.js': "import './c.js';",
        'c.js': '',
      },
      'a.js',
      (path) => {
        calls++;
        return `blob:${path}`;
      }
    );
    assert.strictEqual(calls, 3);
  });

  test('reports cycles and missing modules', () => {
    assert.throws(
      () => link({ 'a.js': "import './b.js';", 'b.js': "import './a.js';" }, 'a.js', (p) => p),
      LinkError
    );
    assert.throws(() => link({ 'a.js': "import './x.js';" }, 'a.js', (p) => p), /Cannot find module/);
    assert.throws(() => link({}, 'a.js', (p) => p), /was not emitted/);
  });
});
