import { expect, type Page } from '@playwright/test';

/**
 * Loads an npm example, runs it and its tests. Used by the live spec (real
 * jsDelivr and esm.sh); the CDN may be slow, so timeouts are generous.
 */
export async function checkNpmExample(
  page: Page,
  id: string,
  { output, tests }: { output: (string | RegExp)[]; tests: number }
) {
  page.on('dialog', (dialog) => dialog.accept());
  await page.goto('/');
  await page.locator('#example').selectOption(id);
  await expect(page.locator('#status')).toHaveText('No type errors', { timeout: 120_000 });

  await page.locator('#run').click();
  await page.locator('[data-panel="console"][role="tab"]').click();
  const consoleEl = page.locator('#console');
  for (const text of output) await expect(consoleEl).toContainText(text, { timeout: 120_000 });
  await expect(consoleEl).toContainText('Module evaluated', { timeout: 120_000 });
  await expect(consoleEl.locator('[data-level="error"]')).toHaveCount(0);
  await expect(page.locator('#plots svg').first()).toBeVisible();

  await page.locator('#test').click();
  await expect(page.locator('#test-summary')).toContainText(`${tests} passed, 0 failed`, {
    timeout: 120_000,
  });
}
