import { test, describe } from 'node:test';
import assert from 'node:assert';
import { formatArgs, formatValue } from './format.ts';

describe('formatValue', () => {
  test('prints top-level strings bare and nested strings quoted', () => {
    assert.strictEqual(formatArgs(['a', 1, true]), 'a 1 true');
    assert.strictEqual(formatValue({ name: 'Alice', tags: ['x'] }), '{ name: "Alice", tags: [ "x" ] }');
  });

  test('handles collections, bigint and circular references', () => {
    const obj: Record<string, unknown> = { n: 1n };
    obj.self = obj;
    assert.strictEqual(formatValue(obj), '{ n: 1n, self: [Circular] }');
    assert.strictEqual(formatValue(new Map([['k', 1]])), 'Map(1) { "k" => 1 }');
    assert.strictEqual(formatValue(new Set([1, 2])), 'Set(2) { 1, 2 }');
    assert.strictEqual(formatValue([]), '[]');
  });

  test('names class instances and functions', () => {
    class Point { x = 1; }
    assert.strictEqual(formatValue(new Point()), 'Point { x: 1 }');
    assert.strictEqual(formatValue(function hello() {}), '[Function: hello]');
  });
});
