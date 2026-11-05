# fluxkit

Write a dynamical system in plain TypeScript. fluxkit runs it as one WebGPU thread per parameter value, or
on the CPU when there is no GPU, with the same results to f32 precision. You never write WGSL, buffer
layouts, quaternion algebra or an integrator.

```ts
import * as fx from 'fluxkit';

const atwood = new fx.Model('Atwood machine', {
  params: {
    m1: 1, g: 9.81, inertia: 0.01, radius: 0.1, friction: 10,
    ratio: fx.sweep(0, 1, 101),            // 101 runs, one GPU thread each
  },
  state: { v: 0, pulley: fx.rotation() },
  rates(s, p) {
    const m2 = p.ratio * p.m1;
    const inertialMass = p.m1 + m2 + p.inertia / p.radius ** 2;
    return {
      v: ((p.m1 - m2) * p.g - p.friction * s.v) / inertialMass,
      pulley: fx.spin(0, 0, s.v / p.radius),   // a rotation's rate is its angular velocity
    };
  },
  outputs: (s, p) => ({ power: p.ratio * p.m1 * p.g * s.v }),
  until: fx.steady('v'),
  dt: 0.004,
});

const run = await atwood.run();            // WebGPU when available, otherwise the CPU
run.best('power').params.ratio;            // 0.5: Odum & Pinkerton's maximum power
run.series('ratio', 'power');              // [x, y][] for a chart
console.log(atwood.wgsl);                  // the kernel fluxkit generated
```

## A model

| Option | |
| --- | --- |
| `params` | Numbers, and **sweeps**: `sweep(from, to, count)` or `values([…])`. Every combination of the sweeps is one run (one GPU thread); the first sweep varies slowest. |
| `state` | Each field is a number, a vector `vec(x, y, z)`, or a rotation `rotation()` (a unit quaternion `[w, x, y, z]`). |
| `init(p)` | Optional starting values that depend on the parameters, e.g. a launch velocity from a swept angle. Plain TypeScript, run on the CPU, so it can do anything. |
| `rates(s, p, t)` | dx/dt for each field it changes; the others stay constant. A rotation's rate is its angular velocity, `spin(x, y, z)`. |
| `outputs(s, p, t)` | Numbers and vectors to report from each run's final state. |
| `until` | `steady(fields?, tol)`: stop when the fields change by at most `tol` × their size in a step. Or a condition, `(s, p, t) => s.y < 0`. Otherwise the run stops at `tEnd` or `maxSteps`. |
| `dt`, `tStart`, `tEnd`, `maxSteps` | The time step and limits. |
| `method` | `'rk4'` (default) or `'euler'`. |

`model.run()` returns a `Run` with `rows` (each run's `params`, final `state`, `outputs`, `t`, `steps` and
`done`), `column(name)`, `series(x, y)`, `best(name)`, and which `backend` ran it. `run({ backend: 'cpu' })`
forces the CPU.

## What a model function can say

`rates`, `outputs` and `until` are ordinary functions, and on the CPU they are simply called. For the GPU,
fluxkit reads each function's source (like GPU.js) and compiles it to WGSL. So they keep to what a rate law
needs, and anything else is a `CompileError` naming the line, before anything runs:

- `const` declarations and a `return`; arrow functions, `function`s or methods; destructured arguments
  (`({ v }, p) => …`).
- Arithmetic, comparisons, `&&`, `||`, `!`, and `a ? b : c` for choices (no `if` or loops). Small whole
  powers such as `x ** 2` become products, so a negative base works as it does in JavaScript.
- `Math`: `abs`, `sqrt`, `exp`, `log`, `log2`, `log10`, `sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `atan2`,
  `sinh`, `cosh`, `tanh`, `pow`, `min`, `max`, `hypot`, `floor`, `ceil`, `round`, `trunc`, `sign`, `cbrt`, and
  the `Math` constants. `Math.random` is refused: a GPU run must be repeatable.
- Vector helpers: `vec`, `add`, `sub`, `scale`, `dot`, `cross`, `length`, `normalize`, `[i]` for a component,
  and for rotations `rotate(q, v)`, `angle(q)` and `spin(…)`. JavaScript has no operator overloading, so `a + b`
  on vectors is an error that says to use `add(a, b)`.
- The function's arguments, its own consts, `Math` and the helpers. A constant from outside the function is
  refused: the GPU can't see it, so put it in `params`.

Anything that is constant for a run (a gear train's matrices, a lookup table) can be computed in plain
TypeScript before you build the model, and passed in as parameters. See `examples/fluxkit/src/hub.ts`.

## Numerics

- The GPU works in f32 and the CPU in f64; results agree to about 1e-6 relative, and both come back through
  the same f32 buffers.
- The state is updated with **Kahan summation**, and each step's whole increment is formed before it is
  added, so long runs of increments below f32's precision still accumulate. (Found on a capacitor charged to
  99.99%: without it the GPU run stalled at R = 50 while the CPU charged it.) Time is `t₀ + k·dt`, not a
  running sum.
- Rotations are renormalised after every step.

## Status

0.1, developed inside [tsrs-monaco](https://github.com/sholtomaud/tsrs-monaco), where it is a built-in
package of the playground (`import * as fx from 'fluxkit'`) and is tested there:

- `packages/fluxkit/test/`: unit tests on the CPU;
- `examples/fluxkit/`: four models checked against closed forms;
- the e2e suite: every model's generated kernel run on a WebGPU adapter and compared with the CPU.

It has no dependencies and imports nothing from the playground, so it can move to its own repository and npm
as it is.
