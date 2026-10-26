import { test, expect, type Page } from '@playwright/test';
import { mockCdn } from './cdn-mock.ts';
import { esm, registry } from './npm-fixtures.ts';

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

test.beforeEach(async ({ page, context }) => {
  await mockCdn(context, registry, esm);
  await page.goto('/');
  await expect(page.locator('#editor .monaco-editor')).toBeVisible();
  await waitForCheck(page);
  page.on('dialog', (dialog) => dialog.accept());
  await page.locator('#example').selectOption('boba-app');
  await waitForCheck(page);
});

test('type checks the Boba template with tsrs', async ({ page }) => {
  await expect(page.locator('#status')).toHaveText('No type errors');
  await expect(page.locator('#file-tabs [data-file="src/main.ts"]')).toHaveAttribute(
    'aria-selected',
    'true'
  );
});

test('runs the Boba template in the Preview tab', async ({ page }) => {
  await page.locator('#run').click();
  await expect(page.locator('.tabs [data-panel="preview"]')).toHaveAttribute('aria-selected', 'true');

  const app = page.frameLocator('#preview-frame');
  const heading = app.locator('home-page h1');
  await expect(heading).toBeVisible({ timeout: 30_000 });
  await expect(app.locator('app-nav')).toBeVisible();
  // Tailwind's utilities are compiled in the page: font-extrabold.
  await expect(heading).toHaveCSS('font-weight', '800');

  // Boba's router runs under the preview's path.
  await app.locator('a[href="/about"]:visible').first().click();
  await expect(app.locator('about-page h1')).toBeVisible();
  const frame = page.frame({ url: /\/preview\/app\/about$/ });
  expect(frame).not.toBeNull();

  // The app's console output shows up in the playground's Console.
  await frame!.evaluate(() => console.log('hello from the app'));
  await page.locator('.tabs [data-panel="console"]').click();
  await expect(page.locator('#console')).toContainText('hello from the app');

  // Running again reloads the app where it was.
  await page.locator('#run').click();
  await expect(app.locator('about-page h1')).toBeVisible({ timeout: 30_000 });

  await page.locator('#stop').click();
  await expect(page.locator('#preview-frame')).toBeHidden();
});

test('imports npm packages in the preview', async ({ page }) => {
  await replaceSource(
    page,
    [
      "import { dot, Tensor } from 'tiny-ml';",
      'const t = new Tensor([1, 2, 3]);',
      "const { shout } = await import('split-lib');",
      "document.querySelector('#router-outlet')!.textContent = `${shout('dot')} ${dot(t.data, [4, 5, 6])}`;",
      "fetch('https://example.com/data').catch(() => {});",
      '',
    ].join('\n')
  );
  await expect(page.locator('#status')).toHaveText('No type errors', { timeout: 30_000 });
  await expect(page.locator('#stats')).toContainText('npm: tiny-ml@2.1.0, split-lib@0.3.0');

  await page.locator('#run').click();
  const app = page.frameLocator('#preview-frame');
  await expect(app.locator('#router-outlet')).toHaveText('DOT! 32', { timeout: 30_000 });

  await page.locator('.tabs [data-panel="console"]').click();
  const consoleEl = page.locator('#console');
  await expect(consoleEl).toContainText(
    'tiny-ml from https://cdn.jsdelivr.net/npm/tiny-ml@2.1.0/dist/tiny-ml.bundle.mjs'
  );
  await expect(consoleEl).toContainText('split-lib from https://esm.sh/split-lib@0.3.0');
  await expect(consoleEl).toContainText(
    "The preview's Content-Security-Policy also allows https://cdn.jsdelivr.net and https://esm.sh"
  );
  // Only the CDNs were allowed: the app's policy still applies to the rest.
  await expect(consoleEl).toContainText(
    'Content-Security-Policy (connect-src) blocked https://example.com/data'
  );
});
