// The CI page: the GitHub action (ci/action.yml) opens it in headless
// Chromium and calls window.tsrsCi.check(files), which runs the same
// pipeline as the editor: tsrs in its worker, npm types and code from the
// CDN, and the tests in a run worker.

import tsrsPackage from '@tsrs/wasm/package.json' with { type: 'json' };
import { browserToolchain } from '../actions/browser-toolchain.ts';
import type { ProjectFiles } from '../compiler/project.ts';
import { checkProject, formatCheck, type CheckOptions, type ProjectCheck } from './checks.ts';

export interface TsrsCi {
  /** The playground release ("v1.2.0"), or "dev" for an unversioned build. */
  version: string;
  tsrs: string;
  typescript: string;
  /** The check, and its log as a CI step prints it. */
  check(files: ProjectFiles, options?: Omit<CheckOptions, 'signal'>): Promise<ProjectCheck & { log: string[] }>;
}

declare global {
  interface Window {
    tsrsCi: TsrsCi;
  }
}

window.tsrsCi = {
  version: import.meta.env.VITE_PLAYGROUND_VERSION || 'dev',
  tsrs: tsrsPackage.version,
  typescript: tsrsPackage.tsrs.typescriptVersion,
  check: async (files, options) => {
    const check = await checkProject(browserToolchain, files, options);
    return { ...check, log: formatCheck(check) };
  },
};
document.body.dataset.ready = 'true';
document.getElementById('ci-status')!.textContent = `Ready: playground ${window.tsrsCi.version}, @tsrs/wasm ${tsrsPackage.version}.`;
