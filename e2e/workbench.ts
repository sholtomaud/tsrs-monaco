import { expect, type Page } from '@playwright/test';

/** A row of the Explorer, by node id: "project" or "project/path". */
export const treeRow = (page: Page, id: string) => page.locator(`#explorer .tree-row[data-id="${id}"]`);

async function expand(page: Page, id: string) {
  const row = treeRow(page, id);
  if ((await row.getAttribute('aria-expanded')) === 'false') await row.click();
  await expect(row).toHaveAttribute('aria-expanded', 'true');
}

/** Opens a project's file from the Explorer, expanding the folders above it. */
export async function openFile(page: Page, project: string, path: string) {
  await expand(page, project);
  const parts = path.split('/');
  for (let i = 1; i < parts.length; i++) await expand(page, `${project}/${parts.slice(0, i).join('/')}`);
  await treeRow(page, `${project}/${path}`).click();
  await expect(page.locator(`#file-tabs .file-tab[data-project="${project}"][data-file="${path}"]`)).toHaveAttribute(
    'aria-selected',
    'true'
  );
  await expect(page.locator('#active-project')).toHaveText(project);
}

/** Creates a file with the Explorer's inline name box. */
export async function newFile(page: Page, name: string, { project }: { project?: string } = {}) {
  if (project) {
    await treeRow(page, project).click({ button: 'right' });
    await page.locator('.wb-menu-item', { hasText: 'New File…' }).click();
  } else {
    await page.locator('#add-file').click();
  }
  const input = page.locator('#explorer .tree-input');
  await expect(input).toBeFocused();
  await input.fill(name);
  await input.press('Enter');
}

/** Names a new project in the Explorer's name box, which `open` has opened. */
export async function nameProject(page: Page, name: string) {
  const input = page.locator('#explorer .tree-input');
  await expect(input).toBeFocused();
  await input.fill(name);
  await input.press('Enter');
  await expect(page.locator('#active-project')).toHaveText(name);
}
