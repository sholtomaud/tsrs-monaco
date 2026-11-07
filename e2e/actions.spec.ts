// The Workflows view (GitHub Actions run in the browser on tsrs) and the
// GitHub view (sign in with a token, link a repository, open a pull request),
// against an in-memory GitHub behind page.route.

import { test, expect, type Page } from '@playwright/test';
import { FakeGitHub } from '../src/github/fake-github.ts';
import { files as hello } from '../src/examples/hello.ts';
import { openFile } from './workbench.ts';

async function useFakeGitHub(page: Page, gh: FakeGitHub) {
  await page.route('https://api.github.com/**', async (route) => {
    const request = route.request();
    const body = request.postData();
    const result = await gh.handle(request.method(), request.url(), request.headers(), body ? JSON.parse(body) : undefined);
    await route.fulfill({
      status: result.status,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: result.json === undefined ? '' : JSON.stringify(result.json),
    });
  });
}

async function runCi(page: Page) {
  await page.locator('#view-actions').click();
  const workflow = page.locator('#actions-view .workflow[data-path=".github/workflows/ci.yml"]');
  await expect(workflow).toBeVisible();
  await workflow.locator('.workflow-run').click();
  await expect(page.locator('.tab[data-panel="workflow"]')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#workflow-panel .run-header')).not.toHaveAttribute('data-state', /queued|in_progress/, { timeout: 60_000 });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('No type errors', { timeout: 30_000 });
});

test('runs a workflow in the browser: tsc and the tests pass', async ({ page }) => {
  await runCi(page);
  await expect(page.locator('#workflow-panel .run-header')).toHaveAttribute('data-state', 'success');
  const panel = page.locator('#workflow-panel');
  await expect(panel.locator('.step', { hasText: 'Type check with tsrs' })).toHaveAttribute('data-state', 'success');
  // Installing Node only matters on GitHub.
  await expect(panel.locator('.step', { hasText: 'actions/setup-node' })).toHaveAttribute('data-state', 'noop');
  await expect(panel.locator('.step', { hasText: 'actions/setup-node' })).toContainText('not needed in the browser');
  const tests = panel.locator('.step', { hasText: 'Test in the playground' });
  await tests.locator('summary').click();
  await expect(tests).toContainText('✔ greets a user by name');
  await expect(tests).toContainText('pass 2');
  // The job is listed under its workflow in the side bar.
  await expect(page.locator('#actions-view .job-row[data-job="check"]')).toHaveAttribute('data-state', 'success');
});

test('a type error fails the workflow, and its annotation opens the file', async ({ page }) => {
  await openFile(page, 'hello', 'src/greet.ts');
  await page.locator('#editor .view-lines').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('\nexport const n: number = "x";\n');
  await expect(page.locator('#status')).toHaveText('1 type error', { timeout: 30_000 });
  await openFile(page, 'hello', 'src/index.ts');

  await runCi(page);
  await expect(page.locator('#workflow-panel .run-header')).toHaveAttribute('data-state', 'failure');
  await expect(page.locator('#workflow-panel .step', { hasText: 'Test in the playground' })).toHaveAttribute('data-state', 'skipped');
  const annotation = page.locator('#workflow-panel .annotations li[data-level="error"]').first();
  await expect(annotation).toContainText('TS2322');
  await annotation.locator('button').click();
  await expect(page.locator('#file-tabs .file-tab[data-file="src/greet.ts"]')).toHaveAttribute('aria-selected', 'true');
});

test('adds a starter workflow to a project without one', async ({ page }) => {
  await openFile(page, 'fluxkit', 'src/index.ts');
  await page.locator('#view-actions').click();
  await page.locator('#actions-view .tree-hint', { hasText: 'Add a CI workflow' }).click();
  await expect(page.locator('#file-tabs .file-tab[data-file=".github/workflows/ci.yml"]')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#actions-view .workflow')).toHaveCount(1);
});

test('signs in, links a repository and opens a pull request after the workflows pass', async ({ page }) => {
  const gh = new FakeGitHub();
  const { '.github/workflows/ci.yml': _ci, ...upstream } = hello;
  await gh.addRepo('acme/hello', upstream);
  await useFakeGitHub(page, gh);

  await page.locator('#view-github').click();
  await page.locator('#github-token').fill('github_pat_not_valid');
  await page.locator('#github-sign-in').click();
  await expect(page.locator('#github-view .view-error')).toContainText('did not accept that token');
  await page.locator('#github-token').fill(gh.token);
  await page.locator('#github-sign-in').click();
  await expect(page.locator('#github-login')).toHaveText('octocat');

  await page.locator('#github-repo').fill('https://github.com/acme/hello');
  await page.locator('#github-link-submit').click();
  await expect(page.locator('#github-link')).toContainText('acme/hello');
  // Only the workflow file differs from the repository.
  await expect(page.locator('#github-changes li')).toHaveText(['A.github/workflows/ci.yml']);

  await page.locator('#pr-branch').fill('add-ci');
  await page.locator('#pr-title').fill('Add CI');
  await page.locator('#pr-create').click();
  await expect(page.locator('#github-view .view-notice')).toContainText('Opened pull request #1', { timeout: 60_000 });
  await expect(page.locator('#github-view .view-notice a')).toHaveAttribute('href', 'https://github.com/acme/hello/pull/1');

  expect(gh.pulls).toHaveLength(1);
  expect(gh.pulls[0]).toMatchObject({ title: 'Add CI', head: 'add-ci', base: 'main' });
  expect(gh.pulls[0].body).toContain('✅ **CI**');
  expect(gh.filesAt('acme/hello', 'add-ci')?.['.github/workflows/ci.yml']).toBe(hello['.github/workflows/ci.yml']);
  // The token is not saved with the workspace.
  const saved = await page.evaluate(() => localStorage.getItem('tsrs-monaco:workspace') ?? '');
  expect(saved).not.toContain(gh.token);
});

test('a failing workflow holds the pull request until you choose to open it anyway', async ({ page }) => {
  const gh = new FakeGitHub();
  await gh.addRepo('acme/hello', hello);
  await useFakeGitHub(page, gh);
  await openFile(page, 'hello', 'src/greet.test.ts');
  await page.locator('#editor .view-lines').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type("\ntest('breaks', () => expect(1).toBe(2));\n");

  await page.locator('#view-github').click();
  await page.locator('#github-token').fill(gh.token);
  await page.locator('#github-sign-in').click();
  await page.locator('#github-repo').fill('acme/hello');
  await page.locator('#github-link-submit').click();
  await expect(page.locator('#github-changes li')).toHaveText(['Msrc/greet.test.ts']);
  await page.locator('#pr-create').click();
  await expect(page.locator('#github-view .view-error')).toContainText('CI failed here', { timeout: 60_000 });
  expect(gh.pulls).toHaveLength(0);
  await page.locator('#pr-anyway').click();
  await expect(page.locator('#github-view .view-notice')).toContainText('Opened pull request #1');
  expect(gh.pulls[0].body).toContain('❌ **CI**');
});

test("odum-cash's workflow runs every job in the browser: needs, a matrix and an artifact", async ({ page }) => {
  await openFile(page, 'odum-cash', 'src/index.ts');
  await page.locator('#view-actions').click();
  await page.locator('#actions-view .workflow[data-path=".github/workflows/model-checks.yml"] .workflow-run').click();
  const header = page.locator('#workflow-panel .run-header');
  await expect(header).not.toHaveAttribute('data-state', /queued|in_progress/, { timeout: 90_000 });
  await expect(header).toHaveAttribute('data-state', 'success');
  await expect(page.locator('#actions-view .job-row .job-name')).toHaveText(['Type check', 'Check the tests', 'Check the model', 'Build', 'Report']);
  await expect(page.locator('#workflow-panel .job-summary').last()).toContainText('Source files type checked: 4');
  await expect(page.locator('#workflow-panel')).toContainText('Artifacts: compiled (3 files)');
});
