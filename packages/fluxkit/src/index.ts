/**
 * fluxkit: write a dynamical system in plain TypeScript; run it as many
 * GPU threads as you have parameter values, or on the CPU.
 *
 *   import * as fx from 'fluxkit';
 *
 *   const m = new fx.Model('Falling mass with drag', {
 *     params: { g: 9.81, drag: fx.sweep(0, 1, 64) },   // 64 runs, one per drag
 *     state: { v: 0 },
 *     rates: (s, p) => ({ v: p.g - p.drag * s.v * s.v }),
 *     outputs: (s) => ({ terminal: s.v }),
 *     until: fx.steady('v'),
 *     dt: 0.01,
 *   });
 *   const run = await m.run();                  // WebGPU if available, else CPU
 *   plot({ points: run.series('drag', 'terminal') });
 *
 * The functions are ordinary code: on the CPU they are called as they are.
 * For the GPU, fluxkit reads their source and compiles it to WGSL, so they
 * keep to what a rate law needs — consts, arithmetic, `Math`, `? :`, and the
 * vector helpers below — and a CompileError points at anything else.
 */

export {
  Model,
  Run,
  Rotation,
  Steady,
  Sweep,
  rotation,
  steady,
  sweep,
  values,
  type ModelDefinition,
  type Outputs,
  type ParamDefs,
  type ParamValues,
  type Rates,
  type Row,
  type RunOptions,
  type StateDefs,
  type StateValues,
} from './model.ts';
export {
  add,
  angle,
  axisAngle,
  cross,
  dot,
  length,
  normalize,
  qmul,
  rotate,
  scale,
  spin,
  sub,
  vec,
  type Quat,
  type Vec3,
} from './vec.ts';
export { CompileError } from './parse.ts';
export { WgslError, cpuEngine, createEngine, type Backend, type Engine } from './engine.ts';
