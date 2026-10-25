import { test, describe } from 'node:test';
import assert from 'node:assert';
import { outputPathFor, isSourceFile, toAbsolute, toRelative } from './project.ts';

describe('project paths', () => {
  test('maps sources to emitted files', () => {
    assert.strictEqual(outputPathFor('src/index.ts'), 'dist/index.js');
    assert.strictEqual(outputPathFor('src/lib/a.mts'), 'dist/lib/a.mjs');
    assert.strictEqual(outputPathFor('src/b.js'), 'dist/b.js');
  });

  test('round-trips absolute paths', () => {
    assert.strictEqual(toRelative(toAbsolute('src/a.ts')), 'src/a.ts');
  });

  test('recognises source files', () => {
    assert.ok(isSourceFile('src/a.ts'));
    assert.ok(isSourceFile('src/a.js'));
    assert.ok(!isSourceFile('src/a.d.ts'));
    assert.ok(!isSourceFile('tsconfig.json'));
  });
});
