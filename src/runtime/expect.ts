// The `expect` global available to playground tests: a small, Jest-flavoured
// subset that needs no imports in the user's code.

import { formatValue } from './format.ts';

export class AssertionError extends Error {
  override name = 'AssertionError';
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  if (a instanceof Date) return a.getTime() === (b as Date).getTime();
  if (a instanceof Map || a instanceof Set) {
    return deepEqual([...a], [...(b as Map<unknown, unknown>)]);
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  return (
    keysA.length === keysB.length &&
    keysA.every((k) =>
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
    )
  );
}

const show = (value: unknown) =>
  typeof value === 'string' ? JSON.stringify(value) : formatValue(value, 1);

export interface Matchers {
  not: Matchers;
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toBeCloseTo(expected: number, digits?: number): void;
  toBeGreaterThan(expected: number): void;
  toBeGreaterThanOrEqual(expected: number): void;
  toBeLessThan(expected: number): void;
  toBeLessThanOrEqual(expected: number): void;
  toBeTruthy(): void;
  toBeFalsy(): void;
  toThrow(expected?: string | RegExp): void;
}

function matchers(actual: unknown, negated: boolean): Matchers {
  const check = (pass: boolean, description: string) => {
    if (pass === negated) {
      throw new AssertionError(
        `expect(${show(actual)})${negated ? '.not' : ''}.${description}`
      );
    }
  };
  const num = (name: string) => {
    if (typeof actual !== 'number') {
      throw new AssertionError(`${name} expects a number, received ${show(actual)}`);
    }
    return actual;
  };

  return {
    get not() {
      return matchers(actual, !negated);
    },
    toBe: (expected) => check(Object.is(actual, expected), `toBe(${show(expected)})`),
    toEqual: (expected) =>
      check(deepEqual(actual, expected), `toEqual(${show(expected)})`),
    toBeCloseTo: (expected, digits = 2) => {
      const diff = Math.abs(num('toBeCloseTo') - expected);
      check(
        diff < 10 ** -digits / 2,
        `toBeCloseTo(${expected}, ${digits}) (difference ${diff})`
      );
    },
    toBeGreaterThan: (n) =>
      check(num('toBeGreaterThan') > n, `toBeGreaterThan(${n})`),
    toBeGreaterThanOrEqual: (n) =>
      check(num('toBeGreaterThanOrEqual') >= n, `toBeGreaterThanOrEqual(${n})`),
    toBeLessThan: (n) => check(num('toBeLessThan') < n, `toBeLessThan(${n})`),
    toBeLessThanOrEqual: (n) =>
      check(num('toBeLessThanOrEqual') <= n, `toBeLessThanOrEqual(${n})`),
    toBeTruthy: () => check(!!actual, 'toBeTruthy()'),
    toBeFalsy: () => check(!actual, 'toBeFalsy()'),
    toThrow: (expected) => {
      if (typeof actual !== 'function') {
        throw new AssertionError(`toThrow expects a function, received ${show(actual)}`);
      }
      let thrown: unknown;
      let threw = false;
      try {
        actual();
      } catch (error) {
        threw = true;
        thrown = error;
      }
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      const matches =
        threw &&
        (expected === undefined ||
          (typeof expected === 'string'
            ? message.includes(expected)
            : expected.test(message)));
      check(matches, `toThrow(${expected === undefined ? '' : show(expected)})`);
    },
  };
}

export function expect(actual: unknown): Matchers {
  return matchers(actual, false);
}
