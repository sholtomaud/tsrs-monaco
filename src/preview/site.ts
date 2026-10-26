// Turns a compiled web app project (one with an index.html) into the files the
// Preview tab serves, standing in for a dev server like Vite:
//
// - src/a.ts's emitted JavaScript is served as src/a.js, which the compiled
//   modules import, and as src/a.ts, which index.html loads, as under Vite.
// - public/x is served at x.
// - `import text from './a.html?raw'` gets a module exporting the file's text.
// - `import './a.css'` gets a module that adds the stylesheet to the page
//   (preview-sw.js serves it for script requests as a.css?import).
// - index.html gains a <base> for the preview's path, the app's base URL for
//   Boba's router, a bridge sending console output to the playground, and
//   Tailwind's in-browser build when a stylesheet imports tailwindcss.

import { isSourceFile, outputPathFor, type ProjectFiles } from '../compiler/project.ts';

export const INDEX_HTML = 'index.html';

export interface SiteFile {
  /** URL path relative to the preview root, with any query (a.html?raw). */
  path: string;
  contentType: string;
  body: string;
}

export interface SiteOptions {
  /** Absolute path the preview is served from, e.g. /preview/app/. */
  root: string;
  /** URL of @tailwindcss/browser, served by the playground. */
  tailwindUrl: string;
}

/** Message the console bridge posts to the playground. */
export interface PreviewConsoleMessage {
  source: 'tsrs-preview';
  level: 'log' | 'info' | 'warn' | 'error' | 'debug';
  text: string;
}

const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  json: 'application/json',
  svg: 'image/svg+xml',
  txt: 'text/plain',
  md: 'text/markdown',
};

const JS = CONTENT_TYPES.js;
const TAILWIND_IMPORT = /@import\s+["']tailwindcss["']/;

// Not part of the site: compiler inputs, and files only the playground reads.
const NOT_SERVED = /(^|\/)(tsconfig\.json|package\.json)$|\.d\.ts$/;

export function isWebApp(files: ProjectFiles): boolean {
  return INDEX_HTML in files;
}

export function contentTypeOf(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  const type = CONTENT_TYPES[ext];
  return type ? `${type};charset=utf-8` : 'application/octet-stream';
}

/** src/a.ts -> src/a.js: where the emitted module of a source file is served. */
export function servedPathFor(source: string): string {
  return source.replace(/\.(m|c)?tsx?$/, '.$1js');
}

// Sends console output and uncaught errors to the playground's Console. Runs
// before the app's modules, and keeps the browser's own console working.
const CONSOLE_BRIDGE = `(() => {
  const text = (value) => {
    if (typeof value === 'string') return value;
    if (value instanceof Error) return value.stack || String(value);
    try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
  };
  const send = (level, args) =>
    parent.postMessage({ source: 'tsrs-preview', level, text: args.map(text).join(' ') }, location.origin);
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const original = console[level].bind(console);
    console[level] = (...args) => { send(level, args); original(...args); };
  }
  addEventListener('error', (e) => {
    const el = e.target;
    // Capturing also catches scripts, stylesheets and images that fail to load.
    if (el === window) send('error', [e.error ?? e.message]);
    else send('error', ['Failed to load ' + (el.src || el.href || el.tagName)]);
  }, true);
  addEventListener('unhandledrejection', (e) => send('error', ['Uncaught (in promise)', e.reason]));
})();`;

function stylesheetModule(css: string): string {
  // @tailwindcss/browser compiles <style type="text/tailwindcss"> elements.
  const type = TAILWIND_IMPORT.test(css) ? 'text/tailwindcss' : 'text/css';
  return `const style = document.createElement('style');
style.setAttribute('type', ${JSON.stringify(type)});
style.textContent = ${JSON.stringify(css)};
document.head.append(style);
`;
}

const scriptLiteral = (value: string) =>
  JSON.stringify(value).replace(/</g, '\\u003c');

function injectIntoHead(html: string, markup: string): string {
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return `${html.slice(0, at)}\n${markup}${html.slice(at)}`;
  }
  return `${markup}\n${html}`;
}

export function buildSite(
  files: ProjectFiles,
  outputs: Record<string, string>,
  options: SiteOptions
): SiteFile[] {
  const site: SiteFile[] = [];
  let usesTailwind = false;

  for (const [path, text] of Object.entries(files)) {
    if (path === INDEX_HTML || NOT_SERVED.test(path)) continue;
    if (isSourceFile(path)) {
      const js = outputs[outputPathFor(path)];
      if (js !== undefined) {
        for (const served of new Set([servedPathFor(path), path])) {
          site.push({ path: served, contentType: JS, body: js });
        }
      }
      continue;
    }
    const served = path.replace(/^public\//, '');
    site.push({ path: served, contentType: contentTypeOf(served), body: text });
    site.push({
      path: `${served}?raw`,
      contentType: JS,
      body: `export default ${JSON.stringify(text)};\n`,
    });
    if (served.endsWith('.css')) {
      usesTailwind ||= TAILWIND_IMPORT.test(text);
      site.push({ path: `${served}?import`, contentType: JS, body: stylesheetModule(text) });
    }
  }

  const head = [
    `<base href="${options.root}" />`,
    `<script>window.BOBA_BASE_URL = ${scriptLiteral(options.root)};\n${CONSOLE_BRIDGE}</script>`,
    usesTailwind ? `<script src="${options.tailwindUrl}"></script>` : '',
  ].filter(Boolean);
  site.push({
    path: INDEX_HTML,
    contentType: contentTypeOf(INDEX_HTML),
    body: injectIntoHead(files[INDEX_HTML] ?? '', `${head.join('\n')}\n`),
  });
  return site;
}
