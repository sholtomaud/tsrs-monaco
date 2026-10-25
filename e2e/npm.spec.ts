import { test, expect, type Page } from '@playwright/test';
import { mockCdn, type Registry } from './cdn-mock.ts';

// Fake packages standing in for jsDelivr and esm.sh, so these tests don't
// depend on the network. 'tiny-ml' ships a self-contained ES module bundle
// (loaded from jsDelivr, like onnxruntime-web); 'split-lib' has an unbundled
// entry that imports a dependency (loaded through esm.sh, like tfjs).
const registry: Registry = {
  'tiny-ml': {
    '2.1.0': {
      'package.json': JSON.stringify({
        name: 'tiny-ml',
        version: '2.1.0',
        exports: { '.': { types: './types.d.ts', import: './dist/tiny-ml.bundle.mjs' } },
        dependencies: { 'tiny-ml-common': '^2.0.0' },
      }),
      'types.d.ts': "export * from 'tiny-ml-common';\nexport declare function dot(a: number[], b: number[]): number;",
      'dist/tiny-ml.bundle.mjs':
        'const dot=(a,b)=>a.reduce((s,x,i)=>s+x*b[i],0);class Tensor{constructor(d){this.data=d}}export{dot,Tensor};',
    },
  },
  'tiny-ml-common': {
    '2.0.0': {
      'package.json': JSON.stringify({ name: 'tiny-ml-common', exports: { import: './esm/index.js' } }),
      'esm/index.js': "export * from './tensor.js';",
      'esm/index.d.ts': "export * from './tensor.js';",
      'esm/tensor.d.ts': 'export declare class Tensor { constructor(data: number[]); readonly data: number[]; }',
    },
  },
  'split-lib': {
    '0.3.0': {
      'package.json': JSON.stringify({ name: 'split-lib', types: 'dist/index.d.ts', module: 'dist/index.js' }),
      'dist/index.d.ts': 'export declare function shout(s: string): string;',
      'dist/index.js': "export { shout } from './shout.js';",
    },
  },
};

const esm = {
  'split-lib@0.3.0': 'export const shout = (s) => s.toUpperCase() + "!";',
};

async function replaceSource(page: Page, text: string) {
  await page.locator('#editor .view-lines').click();
  await page.keyboard.press('ControlOrMeta+A');
  // Delete first: inserting '{' over a selection would surround it.
  await page.keyboard.press('Backspace');
  await page.keyboard.insertText(text);
}

test('imports npm packages: types from jsDelivr, code from jsDelivr or esm.sh', async ({ page, context }) => {
  const requests = await mockCdn(context, registry, esm);
  await page.goto('/');
  await expect(page.locator('#status-dot')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });

  await replaceSource(
    page,
    [
      "import { dot, Tensor } from 'tiny-ml';",
      "import { shout } from 'split-lib';",
      'const t = new Tensor([1, 2, 3]);',
      "console.log(shout('dot'), dot(t.data, [4, 5, 6]));",
      '',
    ].join('\n')
  );
  await expect(page.locator('#status')).toHaveText('No type errors', { timeout: 30_000 });
  await expect(page.locator('#stats')).toContainText('npm: tiny-ml@2.1.0, split-lib@0.3.0');

  await page.locator('#run').click();
  await expect(page.locator('#console')).toContainText('DOT! 32');
  await expect(page.locator('#console')).toContainText(
    'tiny-ml from https://cdn.jsdelivr.net/npm/tiny-ml@2.1.0/dist/tiny-ml.bundle.mjs'
  );
  await expect(page.locator('#console')).toContainText('split-lib from https://esm.sh/split-lib@0.3.0');
  // Only the declaration files the imports reach were fetched.
  expect(requests.some((r) => r.includes('tiny-ml-common@2.0.0/esm/tensor.d.ts'))).toBeTruthy();
  expect(requests.some((r) => r.endsWith('tiny-ml-common@2.0.0/esm/index.js'))).toBeFalsy();
});

test('type checks against the fetched declarations', async ({ page, context }) => {
  await mockCdn(context, registry, esm);
  await page.goto('/');
  await replaceSource(page, "import { dot } from 'tiny-ml';\nconst n: string = dot([1], [2]);\n");
  await expect(page.locator('#status')).toHaveText('1 type error', { timeout: 30_000 });
  await page.locator('[data-panel="problems"][role="tab"]').click();
  await expect(page.locator('#problems')).toContainText("Type 'number' is not assignable to type 'string'.");
});

test('reports packages that cannot be found', async ({ page, context }) => {
  await mockCdn(context, registry, esm);
  await page.goto('/');
  await replaceSource(page, "import nothing from 'no-such-package';\nconsole.log(nothing);\n");
  await page.locator('[data-panel="problems"][role="tab"]').click();
  await expect(page.locator('#problems')).toContainText("Could not fetch 'no-such-package@latest'", {
    timeout: 30_000,
  });
  await expect(page.locator('#problems')).toContainText("Cannot find module 'no-such-package'");
});

test('package.json pins versions', async ({ page, context }) => {
  const pinned: Registry = {
    ...registry,
    'split-lib': { ...registry['split-lib'], '0.2.0': registry['split-lib']['0.3.0'] },
  };
  await mockCdn(context, pinned, { 'split-lib@0.2.0': 'export const shout = (s) => `v0.2 ${s}`;' });
  await page.goto('/');
  page.on('dialog', (dialog) => dialog.accept('package.json'));
  await page.locator('#add-file').click();
  await replaceSource(page, '{ "dependencies": { "split-lib": "0.2.0" } }');
  await page.locator('.file-tab[data-file="src/index.ts"] .file-name').click();
  await replaceSource(page, "import { shout } from 'split-lib';\nconsole.log(shout('hi'));\n");
  await page.locator('#run').click();
  await expect(page.locator('#console')).toContainText('v0.2 hi', { timeout: 30_000 });
});
