import { test, expect, type Page } from '@playwright/test';
import { nameProject, newFile, openFile, treeRow } from './workbench.ts';

async function replaceSource(page: Page, text: string) {
  await page.locator('#editor .view-lines').click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Backspace');
  await page.keyboard.insertText(text);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#editor .monaco-editor')).toBeVisible();
  await expect(page.locator('#status')).toHaveText('No type errors', { timeout: 30_000 });
});

test('the Explorer lists every project and opens files from any of them', async ({ page }) => {
  for (const project of ['hello', 'odum-cash', 'energy-flows', 'boba-app']) {
    await expect(treeRow(page, project)).toBeVisible();
  }
  await expect(treeRow(page, 'hello/src/index.ts')).toHaveAttribute('aria-selected', 'true');

  await openFile(page, 'odum-cash', 'src/cash.ts');
  await expect(page.locator('#breadcrumbs')).toHaveText(/odum-cash.*src.*cash\.ts/);
  // Both projects' tabs stay open; the same file name gets its folder.
  await openFile(page, 'odum-cash', 'src/index.ts');
  await expect(page.locator('.file-tab[data-project="odum-cash"][data-file="src/index.ts"] .tab-description')).toHaveText(
    'odum-cash/src'
  );
  await expect(page.locator('#file-tabs .file-tab')).toHaveCount(3);

  // The active project is the one that runs.
  await page.locator('#run').click();
  await page.locator('[data-panel="console"][role="tab"]').click();
  await expect(page.locator('#console')).toContainText('Steady state J/K = 80');

  // Back to hello by its tab: it runs again.
  await page.locator('.file-tab[data-project="hello"] .file-name').click();
  await expect(page.locator('#active-project')).toHaveText('hello');
  await page.locator('#run').click();
  await expect(page.locator('#console')).toContainText('Hello, Alice!');
});

test('each project keeps its own edits, and Reset restores one project', async ({ page }) => {
  await replaceSource(page, "console.log('edited hello');\n");
  await openFile(page, 'odum-cash', 'src/index.ts');
  await page.locator('.file-tab[data-project="hello"] .file-name').click();
  await expect(page.locator('#editor .view-lines')).toContainText("console.log('edited hello');");

  await page.reload();
  await expect(page.locator('#editor .view-lines')).toContainText("console.log('edited hello');");

  page.on('dialog', (dialog) => dialog.accept());
  await treeRow(page, 'hello').click({ button: 'right' });
  await page.locator('.wb-menu-item', { hasText: 'Reset hello…' }).click();
  await expect(page.locator('#editor .view-lines')).toContainText("import { greet, type User } from './greet.ts';");
});

test('closing tabs, and the empty editor', async ({ page }) => {
  await openFile(page, 'hello', 'src/greet.ts');
  await page.locator('.file-tab[data-file="src/greet.ts"] .file-close').click();
  await expect(page.locator('.file-tab[data-file="src/index.ts"]')).toHaveAttribute('aria-selected', 'true');
  await page.locator('.file-tab[data-file="src/index.ts"] .file-close').click();
  await expect(page.locator('#file-tabs .file-tab')).toHaveCount(0);
  await expect(page.locator('#editor-empty')).toBeVisible();
  await expect(page.locator('#editor-empty')).toContainText('Open a file from the Explorer');
  // The project still runs without an open editor.
  await page.locator('#run').click();
  await expect(page.locator('#console')).toContainText('Hello, Alice!');
});

test('new files, rename and delete in the Explorer', async ({ page }) => {
  await newFile(page, 'greet.ts');
  await expect(page.locator('#explorer .tree-error')).toHaveText('A file src/greet.ts already exists.');
  await page.locator('#explorer .tree-input').fill('lib/util');
  await page.locator('#explorer .tree-input').press('Enter');
  await expect(page.locator('.file-tab[data-file="src/lib/util.ts"]')).toHaveAttribute('aria-selected', 'true');
  await expect(treeRow(page, 'hello/src/lib')).toHaveAttribute('aria-expanded', 'true');

  // Rename with F2.
  await treeRow(page, 'hello/src/lib/util.ts').click();
  await page.keyboard.press('F2');
  const input = page.locator('#explorer .tree-input');
  await expect(input).toHaveValue('util.ts');
  await input.fill('helpers.ts');
  await input.press('Enter');
  await expect(treeRow(page, 'hello/src/lib/helpers.ts')).toBeVisible();
  await expect(page.locator('.file-tab[data-file="src/lib/helpers.ts"]')).toHaveAttribute('aria-selected', 'true');

  // Delete from the context menu; the entry file can't be deleted.
  page.on('dialog', (dialog) => dialog.accept());
  await treeRow(page, 'hello/src/lib/helpers.ts').click({ button: 'right' });
  await page.locator('.wb-menu-item', { hasText: 'Delete' }).click();
  await expect(treeRow(page, 'hello/src/lib')).toHaveCount(0);
  await expect(page.locator('.file-tab[data-file="src/lib/helpers.ts"]')).toHaveCount(0);
  await treeRow(page, 'hello/src/index.ts').click({ button: 'right' });
  await expect(page.locator('.wb-menu-item', { hasText: 'Delete' })).toBeDisabled();
});

test('the Explorer works from the keyboard', async ({ page }) => {
  await treeRow(page, 'hello/src/index.ts').click();
  await page.keyboard.press('ArrowUp'); // greet.ts
  await page.keyboard.press('Enter');
  await expect(page.locator('.file-tab[data-file="src/greet.ts"]')).toHaveAttribute('aria-selected', 'true');
  // Enter moved focus to the editor; back to the tree, then collapse src with ArrowLeft twice.
  await treeRow(page, 'hello/src/greet.ts').click();
  await page.keyboard.press('ArrowLeft');
  await expect(treeRow(page, 'hello/src')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowLeft');
  await expect(treeRow(page, 'hello/src')).toHaveAttribute('aria-expanded', 'false');
});

test('the activity bar, menu and shortcuts show and hide the Explorer and Output', async ({ page }) => {
  const bench = page.locator('.workbench');
  await page.locator('#view-explorer').click();
  await expect(bench).toHaveAttribute('data-sidebar', 'hidden');
  await expect(page.locator('#view-explorer')).toHaveAttribute('aria-pressed', 'false');
  await page.locator('#explorer').evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('ControlOrMeta+B');
  await expect(bench).toHaveAttribute('data-sidebar', 'visible');

  await page.locator('#menu-button').click();
  await expect(page.locator('.wb-menu')).toBeVisible();
  await page.locator('.wb-menu-item', { hasText: 'Hide Output' }).click();
  await expect(bench).toHaveAttribute('data-panel-area', 'hidden');
  await expect(page.locator('#panel-area')).toBeHidden();

  // Running shows the output again; the layout survives a reload.
  await page.locator('#run').click();
  await expect(bench).toHaveAttribute('data-panel-area', 'visible');
  await page.locator('#view-explorer').click();
  await page.reload();
  await expect(page.locator('.workbench')).toHaveAttribute('data-sidebar', 'hidden');
});

test('a new project runs only its own files', async ({ page }) => {
  await page.locator('#add-project').click();
  await expect(page.locator('#explorer .tree-input')).toHaveValue('my-project');
  await page.locator('#explorer .tree-input').fill('hello');
  await expect(page.locator('#explorer .tree-error')).toHaveText('A project hello already exists.');
  await nameProject(page, 'rc-lab');

  // It sits in Projects, above the examples, opened at its entry file.
  await expect(treeRow(page, 'rc-lab')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#file-tabs .file-tab[data-project="rc-lab"][data-file="src/index.ts"]')).toHaveAttribute('aria-selected', 'true');
  const sections = page.locator('#explorer .tree-section');
  await expect(sections).toHaveText(['Projects', 'Examples']);

  await page.locator('#run').click();
  await expect(page.locator('#console')).toContainText('Hello from rc-lab');
  await expect(page.locator('#console')).not.toContainText('Hello, Alice');
  await expect(page.locator('#status')).toHaveText('No type errors');
});

test('each project keeps its own output', async ({ page }) => {
  await page.locator('#run').click();
  await expect(page.locator('#console')).toContainText('Hello, Alice!');

  await openFile(page, 'odum-cash', 'src/index.ts');
  await expect(page.locator('#console')).not.toContainText('Hello, Alice!');
  await page.locator('#run').click();
  await expect(page.locator('#plots svg')).toHaveCount(1);

  // Back to hello: its console, and none of odum-cash's plots.
  await page.locator('.file-tab[data-project="hello"] .file-name').click();
  await expect(page.locator('#console')).toContainText('Hello, Alice!');
  await expect(page.locator('#plots svg')).toHaveCount(0);
  // And odum-cash's plot is still there when it comes back.
  await page.locator('.file-tab[data-project="odum-cash"] .file-name').click();
  await expect(page.locator('#plots svg')).toHaveCount(1);
  await page.locator('[data-panel="console"][role="tab"]').click();
  await expect(page.locator('#console')).toContainText('Steady state J/K = 80');
});

test('duplicate an example to change it, then delete the copy', async ({ page }) => {
  await treeRow(page, 'odum-cash').click({ button: 'right' });
  await page.locator('.wb-menu-item', { hasText: 'Duplicate odum-cash…' }).click();
  await expect(page.locator('#explorer .tree-input')).toHaveValue('odum-cash-copy');
  await page.locator('#explorer .tree-input').press('Enter');
  await expect(page.locator('#active-project')).toHaveText('odum-cash-copy');
  await expect(treeRow(page, 'odum-cash-copy/src/cash.ts')).toBeVisible();

  // Survives a reload; then delete it and the workspace moves on.
  await page.reload();
  await expect(treeRow(page, 'odum-cash-copy')).toBeVisible();
  await expect(page.locator('#active-project')).toHaveText('odum-cash-copy');
  page.on('dialog', (dialog) => dialog.accept());
  await treeRow(page, 'odum-cash-copy').click({ button: 'right' });
  await expect(page.locator('.wb-menu-item', { hasText: 'Reset odum-cash-copy' })).toHaveCount(0);
  await page.locator('.wb-menu-item', { hasText: 'Delete odum-cash-copy…' }).click();
  await expect(treeRow(page, 'odum-cash-copy')).toHaveCount(0);
  await expect(page.locator('#file-tabs .file-tab[data-project="odum-cash-copy"]')).toHaveCount(0);
  await expect(page.locator('#active-project')).toHaveText('hello');
  await expect(page.locator('#new-project-hint')).toBeVisible();
});

test('a new fluxkit project runs its model', async ({ page }) => {
  await page.locator('#menu-button').click();
  await page.locator('.wb-menu-item', { hasText: 'New fluxkit Project…' }).click();
  await nameProject(page, 'decay');
  await expect(page.locator('#status')).toHaveText('No type errors', { timeout: 30_000 });
  await page.locator('#run').click();
  await expect(page.locator('#plots svg')).toHaveCount(1, { timeout: 60_000 });
  await expect(page.locator('#plots')).toContainText('Exponential decay');
});
