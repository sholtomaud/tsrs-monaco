import { test, describe } from 'node:test';
import assert from 'node:assert';
import { AssertionError, deepEqual, expect } from './expect.ts';

describe('deepEqual', () => {
  test('compares structurally', () => {
    assert.ok(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }));
    assert.ok(!deepEqual({ a: 1 }, { a: 1, b: undefined }));
    assert.ok(!deepEqual([1], { 0: 1 }));
    assert.ok(deepEqual(new Map([[1, 'x']]), new Map([[1, 'x']])));
    assert.ok(deepEqual(NaN, NaN));
  });
});

describe('expect', () => {
  test('passes matching assertions', () => {
    expect(1 + 1).toBe(2);
    expect({ a: [1] }).toEqual({ a: [1] });
    expect(0.1 + 0.2).toBeCloseTo(0.3, 10);
    expect(3).toBeGreaterThan(2);
    expect(2).toBeLessThanOrEqual(2);
    expect('x').toBeTruthy();
    expect(() => {
      throw new Error('boom!');
    }).toThrow(/boom/);
    expect(1).not.toBe(2);
  });

  test('fails with a readable message', () => {
    assert.throws(() => expect([1, 2]).toEqual([1, 3]), {
      name: 'AssertionError',
      message: 'expect([ 1, 2 ]).toEqual([ 1, 3 ])',
    });
    assert.throws(() => expect('a').not.toBe('a'), {
      message: 'expect("a").not.toBe("a")',
    });
    assert.throws(() => expect(1).toBeCloseTo(1.1), /difference/);
    assert.throws(() => expect(() => {}).toThrow(), AssertionError);
    assert.throws(() => expect('1').toBeGreaterThan(0), /expects a number/);
  });
});
