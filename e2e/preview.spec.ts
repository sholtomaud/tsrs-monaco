import { test, expect, type Page } from '@playwright/test';

async function waitForCheck(page: Page) {
  await expect(page.locator('#status-dot')).not.toHaveAttribute('data-state', /loading|busy/, {
    timeout: 30_000,
  });
}

test.beforeEach(async ({ page }) => {
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
