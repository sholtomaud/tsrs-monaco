import { test, expect, type Page } from '@playwright/test';
import { newFile, openFile } from './workbench.ts';

async function replaceSource(page: Page, text: string) {
  await page.locator('#editor .view-lines').click();
  await page.keyboard.press('ControlOrMeta+A');
  // Delete first: inserting '{' over a selection would surround it.
  await page.keyboard.press('Backspace');
  // insertText avoids Monaco's auto-closing brackets and indentation.
  await page.keyboard.insertText(text);
}

async function waitForCheck(page: Page) {
  await expect(page.locator('#status-dot')).not.toHaveAttribute('data-state', /loading|busy/, {
    timeout: 30_000,
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#editor .monaco-editor')).toBeVisible();
  await waitForCheck(page);
});

test('type checks and runs the example project', async ({ page }) => {
  await expect(page.locator('#status')).toHaveText('No type errors');
  await expect(page.locator('#problem-count')).toHaveText('0');

  await page.locator('#run').click();
  const consoleEl = page.locator('#console');
  await expect(consoleEl).toContainText('Hello, Alice! You write TypeScript and Rust.');
  await expect(consoleEl).toContainText('2 users know 3 languages');
  await expect(consoleEl.locator('[data-level="info"]')).toHaveCount(1);
});

test('shows tsrs diagnostics as Monaco markers and problems', async ({ page }) => {
  await replaceSource(page, "const n: number = 'one';\nconsole.log(n);\n");
  await expect(page.locator('#status')).toHaveText('1 type error', { timeout: 30_000 });
  await expect(page.locator('#problem-count')).toHaveText('1');
  await expect(page.locator('#editor .squiggly-error')).toHaveCount(1);

  await page.locator('[data-panel="problems"][role="tab"]').click();
  const problem = page.locator('#problems .problem');
  await expect(problem).toContainText("Type 'string' is not assignable to type 'number'.");
  await expect(problem).toContainText('src/index.ts:1:7 · TS2322');

  // Like tsc without noEmitOnError, code with type errors still runs.
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.locator('#console')).toContainText('despite 1 type error');
  await expect(page.locator('#console')).toContainText('one');
});

test('shows the emitted JavaScript', async ({ page }) => {
  await page.locator('[data-panel="js"][role="tab"]').click();
  await expect(page.locator('#js-label')).toHaveText('dist/index.js');
  const output = page.locator('#js-output .view-lines');
  await expect(output).toContainText("import { greet } from './greet.js';");
  await expect(output).not.toContainText('User[]');

  await openFile(page, 'hello', 'src/greet.ts');
  await expect(page.locator('#js-label')).toHaveText('dist/greet.js');
  await expect(output).toContainText('export function greet(user) {');
});

test('reports runtime errors and can stop an infinite loop', async ({ page }) => {
  await replaceSource(page, "throw new Error('boom');\n");
  await page.locator('#run').click();
  await expect(page.locator('#console [data-level="error"]')).toContainText('boom');

  await replaceSource(page, "console.log('spinning');\nwhile (true) {}\n");
  await page.locator('#run').click();
  await expect(page.locator('#console')).toContainText('spinning');
  await page.locator('#stop').click();
  await expect(page.locator('#console')).toContainText('Stopped');
  // The page is still responsive and can run again.
  await replaceSource(page, "console.log('back');\n");
  await page.locator('#run').click();
  await expect(page.locator('#console')).toContainText('back');
});

test('compiles projects with multiple files and persists them', async ({ page }) => {
  // New files go next to the selected file: src/index.ts.
  await newFile(page, 'math');
  await expect(page.locator('.file-tab[data-file="src/math.ts"]')).toHaveAttribute('aria-selected', 'true');
  await replaceSource(page, 'export const square = (n: number) => n * n;\n');

  await page.locator('.file-tab[data-file="src/index.ts"] .file-name').click();
  await replaceSource(page, "import { square } from './math.ts';\nconsole.log(square(7));\n");
  await page.locator('#run').click();
  await expect(page.locator('#console')).toContainText('49');

  await page.reload();
  await expect(page.locator('.file-tab[data-file="src/math.ts"]')).toBeVisible();
});

test('reports tsconfig.json errors', async ({ page }) => {
  await openFile(page, 'hello', 'tsconfig.json');
  await replaceSource(page, '{ "compilerOptions": { "notAnOption": true, "outDir": "dist", "rootDir": "src" }, "include": ["src"] }');
  await page.locator('[data-panel="problems"][role="tab"]').click();
  await expect(page.locator('#problems')).toContainText("Unknown compiler option 'notAnOption'.", {
    timeout: 30_000,
  });
});

test('about page explains the pipeline', async ({ page }) => {
  await page.locator('app-nav a[href="/about"]').click();
  await expect(page.locator('h1')).toHaveText('How it works');
  await expect(page.locator('app-nav a[href="/about"]')).toHaveAttribute('aria-current', 'page');
});

test('runs the example tests with test() and expect()', async ({ page }) => {
  await page.locator('#test').click();
  await expect(page.locator('#test-summary')).toContainText('2 passed, 0 failed');
  await expect(page.locator('#tests .test-result[data-status="pass"]')).toHaveCount(2);
  await expect(page.locator('#test-count')).toHaveText('2');

  // Break a test and see the assertion message.
  await openFile(page, 'hello', 'src/greet.test.ts');
  await replaceSource(page, "test('fails', () => {\n  expect(1 + 1).toBe(3);\n});\n");
  await page.keyboard.press('ControlOrMeta+Shift+Enter');
  const failure = page.locator('#tests .test-result[data-status="fail"]');
  await expect(failure).toContainText('fails');
  await expect(failure.locator('.test-error')).toContainText('expect(2).toBe(3)');
  await expect(page.locator('#test-count')).toHaveText('1 failed');
});

test('Odum CASH example simulates, plots and passes its tests', async ({ page }) => {
  await openFile(page, 'odum-cash', 'src/index.ts');
  await waitForCheck(page);
  await expect(page.locator('#status')).toHaveText('No type errors');

  await page.locator('#run').click();
  // The Plot panel opens with M rising to J/K = 80 and draining from 160.
  const chart = page.locator('#plots svg');
  await expect(chart).toBeVisible();
  await expect(chart.locator('path')).toHaveCount(3);
  await expect(chart).toContainText('CASH: a simple money storage');
  await page.locator('[data-panel="console"][role="tab"]').click();
  await expect(page.locator('#console')).toContainText('week  40   M = 69.72');
  await expect(page.locator('#console')).toContainText('Steady state J/K = 80');

  await page.locator('#test').click();
  await expect(page.locator('#test-summary')).toContainText('7 passed, 0 failed');

  // The active project survives a reload.
  await page.reload();
  await expect(page.locator('#active-project')).toHaveText('odum-cash');
});

test('Energy flows example runs its WGSL kernels and passes its tests', async ({ page }) => {
  // SwiftShader runs the kernels on the CPU, slowly.
  test.setTimeout(180_000);
  // WebGPU, when this browser has an adapter (SwiftShader in playwright.config.js).
  const webgpu = await page.evaluate(async () => !!(await navigator.gpu?.requestAdapter()));
  await openFile(page, 'energy-flows', 'src/index.ts');
  await waitForCheck(page);
  await expect(page.locator('#status')).toHaveText('No type errors');

  await page.locator('#run').click();
  await expect(page.locator('#plots svg')).toHaveCount(3, { timeout: 60_000 });
  await expect(page.locator('#plots')).toContainText('Atwood machine at steady speed');
  await page.locator('[data-panel="console"][role="tab"]').click();
  const output = page.locator('#console');
  await expect(output).toContainText(webgpu ? 'Running on WebGPU' : 'Running on CPU reference');
  await expect(output).toContainText('maximum power 2.406 W at R = 0.50, efficiency 50%');
  await expect(output).toContainText('hub efficiency 98.98%, peak 1778 W at 129 rpm');
  // The steady-state flow matrix A reproduces the Silver Springs budget.
  await expect(output).toContainText(/1 producers\s+0\s+3368\s+0\s+0\s+3000\s+14442/);

  // The CPU tests, plus GPU-vs-CPU checks of each kernel where there's WebGPU.
  await page.locator('#test').click();
  await expect(page.locator('#test-summary')).toContainText(
    webgpu ? '30 passed, 0 failed' : '26 passed, 0 failed',
    { timeout: 120_000 }
  );
  if (webgpu) {
    await expect(page.locator('#tests')).toContainText('ecosystem kernel: GPU matches CPU, A and all');
  }
});
