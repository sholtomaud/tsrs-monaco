import fs from 'node:fs';
import path from 'node:path';
import { chromium, defineConfig, devices } from '@playwright/test';

// Playwright expects the exact Chromium build it pins. Where that build isn't
// installed and can't be downloaded (e.g. a sandbox that blocks the Playwright
// CDN but ships browsers for a different Playwright release), fall back to the
// newest Chromium already in the browsers directory. CI runs in the matching
// Playwright container image, so it always gets the pinned build.
function fallbackChromium() {
  const expected = chromium.executablePath();
  if (fs.existsSync(expected)) return undefined;

  const parts = expected.split(path.sep);
  const buildIndex = parts.findIndex((part) => /^chromium-\d+$/.test(part));
  if (buildIndex === -1) return undefined;
  const browsersDir = parts.slice(0, buildIndex).join(path.sep);
  const relativePath = parts.slice(buildIndex + 1);
  if (!fs.existsSync(browsersDir)) return undefined;

  const candidate = fs
    .readdirSync(browsersDir)
    .filter((name) => /^chromium-\d+$/.test(name))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
    .map((name) => path.join(browsersDir, name, ...relativePath))
    .find((file) => fs.existsSync(file));

  // Workers reload this config; only the main process needs to say so.
  if (candidate && !process.env.TEST_WORKER_INDEX) {
    console.warn(
      `Playwright's pinned Chromium is not installed; using ${candidate}`
    );
  }
  return candidate;
}

const executablePath = fallbackChromium();
const launchOptions = executablePath ? { executablePath } : {};


export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'html' : 'list',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'on',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], launchOptions },
    },
    {
      name: 'production',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions,
        baseURL: 'http://localhost:3000',
      },
    },
  ],
  webServer: [
    {
      command: 'npx vite',
      url: 'http://localhost:5173',
      reuseExistingServer: !process.env.CI,
    },
    {
      command: 'npm run build && npx serve -p 3000 -s dist',
      url: 'http://localhost:3000',
      reuseExistingServer: !process.env.CI,
    }
  ],
});
