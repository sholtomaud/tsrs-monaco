import { test, describe } from 'node:test';
import assert from 'node:assert';
import { buildSite, contentTypeOf, isWebApp, servedPathFor, type SiteFile } from './site.ts';

const options = { root: '/base/preview/app/', tailwindUrl: '/assets/tailwind.js' };

function site(files: Record<string, string>, outputs: Record<string, string> = {}) {
  const map = new Map<string, SiteFile>();
  for (const file of buildSite(files, outputs, options)) map.set(file.path, file);
  return map;
}

describe('preview site', () => {
  test('is built for projects with an index.html', () => {
    assert.strictEqual(isWebApp({ 'index.html': '' }), true);
    assert.strictEqual(isWebApp({ 'src/index.ts': '' }), false);
  });

  test('serves emitted JavaScript at the source path with a .js extension', () => {
    assert.strictEqual(servedPathFor('src/core/router.ts'), 'src/core/router.js');
    assert.strictEqual(servedPathFor('src/a.mts'), 'src/a.mjs');
    const s = site(
      { 'index.html': '', 'src/main.ts': 'x', 'src/missing.ts': 'y' },
      { 'dist/main.js': 'console.log(1);' }
    );
    assert.strictEqual(s.get('src/main.js')?.body, 'console.log(1);');
    // index.html loads the source path, as with Vite.
    assert.strictEqual(s.get('src/main.ts')?.body, 'console.log(1);');
    assert.match(s.get('src/main.js')!.contentType, /^text\/javascript/);
    // A source file that emitted nothing (e.g. a compile failure) is skipped.
    assert.ok(!s.has('src/missing.js'));
  });

  test('leaves out compiler inputs', () => {
    const s = site({
      'index.html': '',
      'tsconfig.json': '{}',
      'package.json': '{}',
      'src/vite-env.d.ts': 'declare module "*?raw";',
    });
    assert.deepStrictEqual([...s.keys()], ['index.html']);
  });

  test('serves public/ at the root and other files where they are', () => {
    const s = site({ 'index.html': '', 'public/favicon.svg': '<svg/>', 'src/a.html': '<p>' });
    assert.strictEqual(s.get('favicon.svg')?.contentType, 'image/svg+xml;charset=utf-8');
    assert.strictEqual(s.get('src/a.html')?.body, '<p>');
  });

  test('serves ?raw imports as modules exporting the text', async () => {
    const s = site({ 'index.html': '', 'src/a.html': '<p class="x">`${hi}`</p>' });
    const raw = s.get('src/a.html?raw')!;
    assert.match(raw.contentType, /^text\/javascript/);
    const module = await import(`data:text/javascript,${encodeURIComponent(raw.body)}`);
    assert.strictEqual(module.default, '<p class="x">`${hi}`</p>');
  });

  test('serves CSS imports as modules that add a style element', () => {
    const s = site({
      'index.html': '',
      'src/plain.css': 'p { color: red; }',
      'src/app.css': '@import "tailwindcss";\n.x { color: blue; }',
    });
    assert.match(s.get('src/plain.css?import')!.body, /'type', "text\/css"/);
    assert.match(s.get('src/app.css?import')!.body, /'type', "text\/tailwindcss"/);
    assert.match(s.get('src/app.css?import')!.body, /\.x \{ color: blue; \}/);
  });

  test('prepares index.html to run under the preview path', () => {
    const html = '<!doctype html><html><head lang="en"><title>App</title></head></html>';
    const index = site({ 'index.html': html }).get('index.html')!;
    const head = index.body.indexOf('<head lang="en">');
    // <base> comes first, so every relative URL after it resolves under the root.
    assert.strictEqual(index.body.indexOf('<base href="/base/preview/app/" />'), head + 17);
    assert.match(index.body, /window\.BOBA_BASE_URL = "\/base\/preview\/app\/"/);
    assert.match(index.body, /source: 'tsrs-preview'/);
    assert.ok(index.body.endsWith('<title>App</title></head></html>'));
    assert.ok(!index.body.includes('/assets/tailwind.js'));
  });

  test("loads Tailwind's browser build when a stylesheet imports tailwindcss", () => {
    const index = site({ 'index.html': '<head></head>', 'src/a.css': "@import 'tailwindcss';" }).get(
      'index.html'
    )!;
    assert.match(index.body, /<script src="\/assets\/tailwind\.js"><\/script>/);
  });

  test('guesses content types from extensions', () => {
    assert.strictEqual(contentTypeOf('a.CSS'), 'text/css;charset=utf-8');
    assert.strictEqual(contentTypeOf('a.bin'), 'application/octet-stream');
  });
});
