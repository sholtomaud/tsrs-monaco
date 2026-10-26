// Publishes a web app to the Preview tab: writes its files into the Cache API
// and makes sure public/preview-sw.js is active to serve them.

import tailwindUrl from '@tailwindcss/browser?url';
import { buildSite } from './site.ts';
import type { ProjectFiles } from '../compiler/project.ts';

// Must match public/preview-sw.js.
const CACHE = 'tsrs-preview';

/** Absolute path the preview is served from, under the playground's base. */
export function previewRoot(): string {
  return `${window.BOBA_BASE_URL}preview/app/`;
}

let registration: Promise<ServiceWorkerRegistration> | null = null;

async function activeWorker(): Promise<ServiceWorkerRegistration> {
  if (!('serviceWorker' in navigator) || !('caches' in window)) {
    throw new Error(
      'The preview needs service workers and the Cache API, which this browser does not provide here (they require HTTPS or localhost).'
    );
  }
  const reg = await navigator.serviceWorker.register(
    `${window.BOBA_BASE_URL}preview-sw.js`,
    { scope: previewRoot() }
  );
  // navigator.serviceWorker.ready only covers workers controlling this page,
  // and this one controls the preview, so wait for activation directly.
  const worker = reg.installing ?? reg.waiting;
  if (worker && !reg.active) {
    await new Promise<void>((resolve, reject) => {
      worker.addEventListener('statechange', () => {
        if (worker.state === 'activated') resolve();
        if (worker.state === 'redundant') {
          reject(new Error('The preview service worker failed to install.'));
        }
      });
    });
  }
  return reg;
}

/** Replaces the preview's files and returns the URL to load it from. */
export async function publish(
  files: ProjectFiles,
  outputs: Record<string, string>,
  imports: Record<string, string>
): Promise<string> {
  registration ??= activeWorker().catch((error) => {
    registration = null;
    throw error;
  });
  await registration;

  const root = previewRoot();
  const base = new URL(root, location.origin);
  const site = buildSite(files, outputs, {
    root,
    tailwindUrl: new URL(tailwindUrl, location.href).href,
    imports,
  });
  await caches.delete(CACHE);
  const cache = await caches.open(CACHE);
  await Promise.all(
    site.map((file) =>
      cache.put(
        new URL(file.path, base).href,
        new Response(file.body, {
          headers: { 'Content-Type': file.contentType, 'Cache-Control': 'no-store' },
        })
      )
    )
  );
  return base.href;
}
