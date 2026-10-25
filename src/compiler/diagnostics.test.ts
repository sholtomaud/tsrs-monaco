import { test, describe } from 'node:test';
import assert from 'node:assert';
import { toProblem, severityOf, formatProblem } from './diagnostics.ts';

describe('toProblem', () => {
  test('converts 0-based tsrs positions to 1-based Monaco ranges', () => {
    const problem = toProblem({
      fileName: '/project/src/index.ts',
      startPosition: { line: 2, character: 6 },
      endPosition: { line: 2, character: 7 },
      code: 2322,
      category: 1,
      text: "Type 'string' is not assignable to type 'number'.",
    });
    assert.deepStrictEqual(problem, {
      file: 'src/index.ts',
      severity: 'error',
      code: 2322,
      message: "Type 'string' is not assignable to type 'number'.",
      startLineNumber: 3,
      startColumn: 7,
      endLineNumber: 3,
      endColumn: 8,
    });
  });

  test('widens zero-width ranges to one character', () => {
    const problem = toProblem({
      fileName: '/project/src/a.ts',
      startPosition: { line: 0, character: 4 },
      endPosition: { line: 0, character: 4 },
      code: 1005,
      category: 1,
      text: "';' expected.",
    });
    assert.strictEqual(problem.startColumn, 5);
    assert.strictEqual(problem.endColumn, 6);
  });

  test('handles global diagnostics with no file', () => {
    const problem = toProblem({ code: 6053, category: 1, text: 'No inputs' });
    assert.strictEqual(problem.file, null);
    assert.strictEqual(formatProblem(problem), 'error TS6053: No inputs');
  });
});

describe('severityOf', () => {
  test('maps TypeScript categories', () => {
    assert.strictEqual(severityOf(0), 'warning');
    assert.strictEqual(severityOf(1), 'error');
    assert.strictEqual(severityOf(2), 'hint');
    assert.strictEqual(severityOf(3), 'info');
  });
});
