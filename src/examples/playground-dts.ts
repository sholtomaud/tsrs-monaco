// src/playground.d.ts in every example: types for the globals the run worker
// provides (see runtime/run.worker.ts). It only declares types and emits no JS.
export const PLAYGROUND_DTS = `// Globals the playground provides to your code. Types only: no JavaScript.

/** Draws a line chart in the Plot panel. Points are [x, y] pairs or y values. */
declare function plot(
  series: PlotSeries | PlotSeries[],
  options?: { title?: string; xLabel?: string; yLabel?: string }
): void;

interface PlotSeries {
  name?: string;
  points: Array<[number, number]> | number[];
}

/** Registers a test. Files named *.test.ts run when you press Test. */
declare function test(name: string, fn: () => void | Promise<void>): void;

declare function expect(actual: unknown): Matchers;

interface Matchers {
  not: Matchers;
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  /** Passes when |actual - expected| < 10^-digits / 2 (digits defaults to 2). */
  toBeCloseTo(expected: number, digits?: number): void;
  toBeGreaterThan(expected: number): void;
  toBeGreaterThanOrEqual(expected: number): void;
  toBeLessThan(expected: number): void;
  toBeLessThanOrEqual(expected: number): void;
  toBeTruthy(): void;
  toBeFalsy(): void;
  toThrow(expected?: string | RegExp): void;
}
`;
