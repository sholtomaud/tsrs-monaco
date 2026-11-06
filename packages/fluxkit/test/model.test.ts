import { test, describe } from 'node:test';
import assert from 'node:assert';
import * as fx from '../src/index.ts';

const cpu = { backend: 'cpu' } as const;

describe('integration', () => {
  // x'' = −x from (1, 0): x = cos t, v = −sin t.
  const oscillator = (method: 'euler' | 'rk4', dt: number) =>
    new fx.Model('oscillator', {
      state: { x: 1, v: 0 },
      rates: (s) => ({ x: s.v, v: -s.x }),
      outputs: (s) => ({ energy: (s.x ** 2 + s.v ** 2) / 2 }),
      dt,
      tEnd: 2 * Math.PI,
      method,
    });

  test('RK4 is fourth order: one period of x\'\' = −x', async () => {
    const error = async (dt: number) => {
      const [row] = (await oscillator('rk4', dt).run(cpu)).rows;
      return Math.hypot(row.state.x - Math.cos(row.t), row.state.v + Math.sin(row.t));
    };
    const coarse = await error((2 * Math.PI) / 50);
    const fine = await error((2 * Math.PI) / 100);
    // Results come back through the same f32 buffers as the GPU's, so stay above ~1e-7.
    assert.ok(coarse < 5e-5, `error ${coarse}`);
    assert.ok(coarse / fine > 12 && coarse / fine < 24, `halving dt divided the error by ${coarse / fine}`);
  });

  test('forward Euler gains energy on an oscillator, as it should', async () => {
    const [row] = (await oscillator('euler', 0.01).run(cpu)).rows;
    assert.ok(row.outputs.energy > 0.5 * 1.05);
  });

  test('tEnd runs (tEnd − tStart) / dt steps and is done', async () => {
    const [row] = (await oscillator('rk4', 0.01).run(cpu)).rows;
    assert.strictEqual(row.steps, Math.round((2 * Math.PI) / 0.01));
    assert.ok(Math.abs(row.t - 2 * Math.PI) < 0.01);
    assert.strictEqual(row.done, true);
  });

  test('a rotation turns at its angular velocity and stays unit length', async () => {
    const m = new fx.Model('spinner', {
      params: { w: fx.values([0.5, 1, 2]) },
      state: { q: fx.rotation() },
      rates: (_s, p) => ({ q: fx.spin(0, 0, p.w) }),
      outputs: (s) => ({ x: fx.rotate(s.q, fx.vec(1, 0, 0)) }),
      dt: 0.001,
      tEnd: 1,
    });
    for (const row of (await m.run(cpu)).rows) {
      const [x, y] = row.outputs.x;
      // To f32 precision: results come back through the GPU's buffer layout.
      assert.ok(Math.abs(x - Math.cos(row.params.w)) < 1e-6 && Math.abs(y - Math.sin(row.params.w)) < 1e-6);
      assert.ok(Math.abs(Math.hypot(...row.state.q) - 1) < 1e-6);
    }
  });
});

describe('parameters, stopping and results', () => {
  test('sweeps run every combination, the first sweep varying slowest', () => {
    const m = new fx.Model('grid', {
      params: { a: fx.values([1, 2]), k: 3, b: fx.sweep(0, 1, 3) },
      state: { x: 0 },
      rates: () => ({ x: 1 }),
      dt: 1,
      tEnd: 1,
    });
    assert.deepStrictEqual(
      m.runs.map((r) => [r.a, r.k, r.b]),
      [[1, 3, 0], [1, 3, 0.5], [1, 3, 1], [2, 3, 0], [2, 3, 0.5], [2, 3, 1]]
    );
  });

  test('steady() stops when the field stops changing; until() on a condition', async () => {
    const decay = new fx.Model('decay', {
      params: { k: fx.values([1, 2]) },
      state: { x: 0 },
      rates: (s, p) => ({ x: p.k * (3 - s.x) }),
      until: fx.steady('x', 1e-9),
      dt: 0.01,
    });
    for (const row of (await decay.run(cpu)).rows) {
      assert.ok(row.done && Math.abs(row.state.x - 3) < 1e-6);
    }
    const fill = new fx.Model('fill', {
      state: { x: 0 },
      rates: () => ({ x: 2 }),
      until: (s) => s.x >= 10,
      dt: 0.5,
    });
    const [row] = (await fill.run(cpu)).rows;
    assert.strictEqual(row.steps, 10);
    assert.ok(row.done);
  });

  test('init() sets per-run starting values; omitted fields keep the state defaults', async () => {
    const m = new fx.Model('throw', {
      params: { v0: fx.values([1, 2]) },
      state: { y: 5, v: 0 },
      init: (p) => ({ v: p.v0 }),
      rates: (s) => ({ y: s.v }),
      dt: 1,
      tEnd: 1,
    });
    assert.deepStrictEqual((await m.run(cpu)).rows.map((r) => r.state.y), [6, 7]);
    const bad = new fx.Model('bad', { state: { y: 0 }, init: () => ({ z: 1 }) as never, rates: () => ({}), dt: 1, tEnd: 1 });
    await assert.rejects(bad.run(cpu), /init\(\) returned 'z', which is not in the state/);
  });

  test('columns, series and best read params, outputs and state', async () => {
    const m = new fx.Model('line', {
      params: { k: fx.values([1, 3, 2]) },
      state: { x: 0, at: fx.vec(0, 0, 0) },
      rates: (_s, p) => ({ x: p.k, at: fx.vec(p.k, 0, 0) }),
      outputs: (s) => ({ twice: 2 * s.x }),
      dt: 1,
      tEnd: 1,
    });
    const run = await m.run(cpu);
    assert.deepStrictEqual(run.series('k', 'twice'), [[1, 2], [3, 6], [2, 4]]);
    assert.deepStrictEqual(run.column('at', 0), [1, 3, 2]);
    assert.strictEqual(run.best('twice').params.k, 3);
    assert.throws(() => run.column('at'), /is a vector: pass a component/);
  });

  test('a model must say when to stop', () => {
    assert.throws(() => new fx.Model('forever', { state: { x: 0 }, rates: () => ({ x: 1 }), dt: 1 }), /Say when to stop/);
  });
});

describe('compiling to WGSL', () => {
  const errorOf = (rates: (s: { readonly x: number }, p: { readonly k: number }) => { x?: number }) => {
    try {
      void new fx.Model('m', { params: { k: 1 }, state: { x: 0 }, rates, dt: 1, tEnd: 1 }).wgsl;
    } catch (error) {
      return (error as Error).message;
    }
    return 'compiled';
  };
  const outside = 2;

  test('refuses what the GPU could not run the same way, naming the line', () => {
    assert.match(errorOf((s, p) => ({ x: s.x * outside * p.k })), /unknown name 'outside'.*Put other constants in params/s);
    assert.match(
      errorOf((s) => {
        if (s.x > 1) return { x: 0 };
        return { x: 1 };
      }),
      /line 2:\d+: 'if' statements are not supported: use a ternary/
    );
    assert.match(errorOf((s) => ({ x: Number(s.x) })), /only Math functions and fluxkit's helpers can be called/);
    assert.match(errorOf((s) => ({ x: Math.random() + s.x })), /Math.random is not available on the GPU/);
    assert.match(errorOf(() => ({ y: 1 }) as never), /'y' is not in the state \(x\)/);
  });

  test('explains vector arithmetic', () => {
    const m = new fx.Model('v', {
      state: { a: fx.vec(0, 0, 0) },
      // @ts-expect-error: a vector plus a vector is not a vector in JavaScript
      rates: (s) => ({ a: s.a + s.a }),
      dt: 1,
      tEnd: 1,
    });
    assert.throws(() => m.wgsl, /'\+' on a vector is not vector arithmetic in JavaScript: use add\(a, b\)/);
  });

  test('a rotation\'s rate must be an angular velocity', () => {
    const m = new fx.Model('r', { state: { q: fx.rotation() }, rates: () => ({ q: 1 as never }), dt: 1, tEnd: 1 });
    assert.throws(() => m.wgsl, /the rate of rotation 'q' is its angular velocity: spin\(x, y, z\)/);
  });

  test('names that are WGSL keywords are safe', () => {
    const m = new fx.Model('keywords', {
      params: { target: 1, select: 2 },
      state: { loop: 0 },
      rates: (s, p) => {
        const fn = p.target * p.select;
        return { loop: fn - s.loop };
      },
      dt: 1,
      tEnd: 1,
    });
    assert.match(m.wgsl, /let l_fn = \(fk_p\.p_target \* fk_p\.p_select\);/);
    assert.match(m.wgsl, /s_loop: f32,/);
  });

  test('small powers expand to products, so a negative base works as in JavaScript', () => {
    const m = new fx.Model('powers', {
      state: { x: -2 },
      rates: (s) => ({ x: s.x ** 2 + Math.pow(s.x, 3) + s.x ** 0.5 }),
      dt: 1,
      tEnd: 1,
    });
    assert.match(m.wgsl, /\(fk_s\.s_x \* fk_s\.s_x\)/);
    assert.match(m.wgsl, /\(fk_s\.s_x \* fk_s\.s_x \* fk_s\.s_x\)/);
    assert.match(m.wgsl, /pow\(fk_s\.s_x, 0\.5\)/);
  });

  test('the kernel keeps f32 accumulation honest', () => {
    // Found on the GPU: charging a capacitor to 99.99% stalled at R = 50,
    // because each RK4 stage's increment fell below half an f32 ULP of the
    // state and rounded away. The CPU, in f64, never sees this; the e2e
    // tests compare the two. Here: the shape of the fix.
    const wgsl = new fx.Model('acc', { state: { x: 0 }, rates: () => ({ x: 1 }), dt: 1, tEnd: 1 }).wgsl;
    assert.match(wgsl, /let sum = fk_kahan\(s, c, fk_delta\(s, p, t, params\.dt\)\);/); // compensated sum
    assert.match(wgsl, /fk_scale\(fk_axpy\(fk_axpy\(fk_axpy\(k1, k2, 2\.0\), k3, 2\.0\), k4, 1\.0\), dt \/ 6\.0\)/); // one increment
    assert.match(wgsl, /t = t0 \+ f32\(k \+ 1u\) \* params\.dt;/); // time without drift
  });

  test('arrow functions, methods and destructuring all compile', () => {
    const forms = [
      (s: { readonly x: number }) => ({ x: -s.x }),
      function (s: { readonly x: number }) {
        return { x: -s.x };
      },
      ({ x }: { readonly x: number }) => ({ x: -x }),
    ];
    for (const rates of forms) {
      assert.match(new fx.Model('forms', { state: { x: 1 }, rates, dt: 1, tEnd: 1 }).wgsl, /\(-fk_s\.s_x\)/);
    }
    const method = new fx.Model('method', {
      state: { x: 1 },
      rates(s) {
        return { x: -s.x };
      },
      dt: 1,
      tEnd: 1,
    });
    assert.match(method.wgsl, /\(-fk_s\.s_x\)/);
  });
});
