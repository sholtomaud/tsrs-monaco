import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { BUILTIN_TYPES, builtinShim, isBuiltin } from './builtin.ts';

test('fluxkit is built in, with its declaration files', () => {
  assert.ok(isBuiltin('fluxkit'));
  assert.ok(!isBuiltin('constructor'));
  assert.ok(BUILTIN_TYPES.fluxkit['node_modules/fluxkit/index.d.ts'].includes('export {'));
  assert.match(BUILTIN_TYPES.fluxkit['node_modules/fluxkit/package.json'], /"types": "index.d.ts"/);
});

test('src/packages/builtin-fluxkit.ts is in sync with packages/fluxkit/src', async () => {
  // @ts-expect-error: a plain JavaScript script, without type declarations
  const { build, outFile } = await import('../../scripts/build-fluxkit-types.mjs');
  assert.ok(fs.readFileSync(outFile, 'utf8') === build(), 'run: node scripts/build-fluxkit-types.mjs');
});

test('the shim re-exports a built-in by name', () => {
  assert.strictEqual(
    builtinShim('fluxkit', ['Model', 'sweep', 'default', 'not-a-name']),
    [
      'const m = globalThis.__playgroundBuiltins["fluxkit"];',
      'export const Model = m.Model;',
      'export const sweep = m.sweep;',
      'export default m;',
    ].join('\n')
  );
});
