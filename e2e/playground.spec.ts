import { test, expect, type Page } from '@playwright/test';

async function replaceSource(page: Page, text: string) {
  await page.locator('#editor .view-lines').click();
  await page.keyboard.press('ControlOrMeta+A');
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

  await page.locator('.file-tab[data-file="src/greet.ts"] .file-name').click();
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
  page.on('dialog', (dialog) => dialog.accept('math'));
  await page.locator('#add-file').click();
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
  await page.locator('.file-tab[data-file="tsconfig.json"] .file-name').click();
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
