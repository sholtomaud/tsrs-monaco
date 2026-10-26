// Serves the playground's Preview tab. The playground writes the compiled
// app into the Cache API (src/preview/preview-client.ts) and this worker
// answers requests under its scope from that cache. It keeps no state of its
// own, so it carries on working after the browser stops and restarts it.

const CACHE = 'tsrs-preview';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const { request } = event;
  // Anything else, like the playground's own Tailwind build, goes to the network.
  if (request.method !== 'GET' || !request.url.startsWith(self.registration.scope)) return;
  event.respondWith(respond(request));
});

async function respond(request) {
  const cache = await caches.open(CACHE);
  const url = new URL(request.url);
  url.hash = '';

  // `import './a.css'` requests the stylesheet as a script: serve the module
  // that adds it to the page.
  if (request.destination === 'script' && url.pathname.endsWith('.css') && !url.search) {
    const module = await cache.match(`${url.href}?import`);
    if (module) return module;
  }
  const file = await cache.match(url.href);
  if (file) return file;

  // A single-page app: every other page is index.html, and its router takes over.
  if (request.mode === 'navigate') {
    const index = await cache.match(new URL('index.html', self.registration.scope).href);
    if (index) return index;
  }
  return new Response(`${url.pathname} is not part of the preview.`, {
    status: 404,
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
  });
}
