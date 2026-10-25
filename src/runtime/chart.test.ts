import { test, describe } from 'node:test';
import assert from 'node:assert';
import { renderChart, ticks, toChart } from './chart.ts';

describe('toChart', () => {
  test('accepts y arrays and [x, y] pairs, dropping non-finite points', () => {
    const chart = toChart(
      [{ points: [3, 4] }, { name: 'M', points: [[0, 1], [1, NaN], [2, 3]] }],
      { title: 'CASH' }
    );
    assert.deepStrictEqual(chart.series, [
      { name: 'series 1', points: [[0, 3], [1, 4]] },
      { name: 'M', points: [[0, 1], [2, 3]] },
    ]);
    assert.strictEqual(chart.title, 'CASH');
  });

  test('rejects malformed input', () => {
    assert.throws(() => toChart({} as never), /expects/);
  });
});

describe('ticks', () => {
  test('picks round steps that cover the range', () => {
    assert.deepStrictEqual(ticks(0, 240), [0, 50, 100, 150, 200, 250]);
    assert.deepStrictEqual(ticks(0, 80), [0, 20, 40, 60, 80]);
    assert.deepStrictEqual(ticks(0, 1), [0, 0.2, 0.4, 0.6, 0.8, 1]);
  });

  test('widens an empty range', () => {
    const t = ticks(5, 5);
    assert.ok(t[0] <= 0 && t[t.length - 1] >= 10);
  });
});

describe('renderChart', () => {
  test('renders escaped labels and one path per series', () => {
    const svg = renderChart(
      toChart([{ name: '<M>', points: [1, 2, 3] }, { points: [3, 2, 1] }], {
        title: 'a & b',
      })
    );
    assert.match(svg, /^<svg/);
    assert.strictEqual(svg.match(/<path /g)?.length, 2);
    assert.ok(svg.includes('a &#38; b'));
    assert.ok(svg.includes('&#60;M&#62;'));
    assert.ok(!svg.includes('<M>'));
  });
});
