/**
 * Specification B: the Atwood machine as a model of maximum power
 * (Odum & Pinkerton, 1955, "Time's speed regulator").
 *
 * A falling mass M1 (the energy source) lifts a load M2 = R·M1 over a pulley
 * of moment of inertia I and radius r. One GPU thread per mass ratio R:
 *
 *     a = ((M1 − M2) g − b v) / (M1 + M2 + I/r²)        v ← v + a Δt
 *     ω = v / r  rotates the pulley:  q ← normalize(q_update(q, ω ẑ, Δt))
 *
 * b is a linear (viscous) friction in the bearing. Without it (b = 0) this
 * is the textbook a = (M1 − M2) g / (M1 + M2 + I/r²): the masses accelerate
 * for ever and there is no steady power to compare. Odum & Pinkerton's
 * argument needs exactly this dissipation, a flow proportional to its
 * driving force, which gives a steady speed
 *
 *     v* = (M1 − M2) g / b,    P_out = M2 g v* = R (1 − R) M1² g² / b,
 *
 * the useful power peaks at R = 1/2, and there the efficiency
 * P_out / P_in = M2 g v / M1 g v = R is 50%: a slower machine (R → 1) is
 * more efficient but delivers less power, a faster one (R → 0) wastes it all.
 */

import { type Engine, type Kernel } from './engine.ts';
import { IDENTITY, QUATERNION_WGSL, qNormalize, qUpdate, readQuat, writeQuat, type Quat } from './quaternion.ts';

/** Floats per thread in the state buffer: q (4), v, t, distance, steps. */
export const STATE_STRIDE = 8;
/** Floats per thread in the output buffer: R, v, P_out, P_in, P_loss, steady. */
export const OUTPUT_STRIDE = 6;

const params = [
  ['count', 'u32'],
  ['max_steps', 'u32'],
  ['m1', 'f32'],
  ['g', 'f32'],
  ['inertia', 'f32'],
  ['radius', 'f32'],
  ['friction', 'f32'],
  ['dt', 'f32'],
  ['tol', 'f32'],
] as const;

type Param = (typeof params)[number][0];

export const kernel: Kernel<Param> = {
  label: 'atwood',
  params,
  wgsl: /* wgsl */ `${QUATERNION_WGSL}
const STATE_STRIDE: u32 = ${STATE_STRIDE}u;
const OUTPUT_STRIDE: u32 = ${OUTPUT_STRIDE}u;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= params.count) {
    return;
  }
  let ratio = input[i];
  let m1 = params.m1;
  let m2 = ratio * m1;
  // Inertial mass: both masses plus the pulley, I / r^2.
  let m_eff = m1 + m2 + params.inertia / (params.radius * params.radius);

  let s = i * STATE_STRIDE;
  var q = vec4<f32>(state[s], state[s + 1u], state[s + 2u], state[s + 3u]);
  var v = state[s + 4u];
  var t = state[s + 5u];
  var distance = state[s + 6u];
  var steps = u32(state[s + 7u]);
  var steady = false;

  for (var k = 0u; k < params.max_steps; k++) {
    let a = ((m1 - m2) * params.g - params.friction * v) / m_eff;
    let v_next = v + a * params.dt;
    // The rope turns the pulley about its axle (z): omega = v / r.
    q = q_normalize(q_update(q, vec3<f32>(0.0, 0.0, v / params.radius), params.dt));
    distance += v * params.dt;
    t += params.dt;
    steps += 1u;
    // Steady when v is within tol of v* = v + a m_eff / b, or when f32 can't
    // move v any further. (Multiplied out, so b = 0 never divides.)
    let settled = abs(a) * m_eff <= params.tol * params.friction * abs(v_next) || v_next == v;
    v = v_next;
    if (settled) {
      steady = true;
      break;
    }
  }

  state[s] = q.x;
  state[s + 1u] = q.y;
  state[s + 2u] = q.z;
  state[s + 3u] = q.w;
  state[s + 4u] = v;
  state[s + 5u] = t;
  state[s + 6u] = distance;
  state[s + 7u] = f32(steps);

  let o = i * OUTPUT_STRIDE;
  output[o] = ratio;
  output[o + 1u] = v;
  output[o + 2u] = m2 * params.g * v;              // useful power, lifting M2
  output[o + 3u] = m1 * params.g * v;              // power from the falling M1
  output[o + 4u] = params.friction * v * v;        // dissipated as heat
  output[o + 5u] = select(0.0, 1.0, steady);
}
`,
  cpu({ params: p, input, state, output }) {
    for (let i = 0; i < p.count; i++) {
      const ratio = input[i];
      const m2 = ratio * p.m1;
      const mEff = p.m1 + m2 + p.inertia / (p.radius * p.radius);
      const s = i * STATE_STRIDE;
      let q = readQuat(state, s);
      let [v, t, distance, steps] = [state[s + 4], state[s + 5], state[s + 6], state[s + 7]];
      let steady = false;
      for (let k = 0; k < p.max_steps; k++) {
        const a = ((p.m1 - m2) * p.g - p.friction * v) / mEff;
        const vNext = v + a * p.dt;
        q = qNormalize(qUpdate(q, [0, 0, v / p.radius], p.dt));
        distance += v * p.dt;
        t += p.dt;
        steps++;
        const settled = Math.abs(a) * mEff <= p.tol * p.friction * Math.abs(vNext) || vNext === v;
        v = vNext;
        if (settled) {
          steady = true;
          break;
        }
      }
      writeQuat(state, s, q);
      state.set([v, t, distance, steps], s + 4);
      output.set(
        [ratio, v, m2 * p.g * v, p.m1 * p.g * v, p.friction * v * v, steady ? 1 : 0],
        i * OUTPUT_STRIDE
      );
    }
  },
};

export interface AtwoodOptions {
  /** The driving mass, kg. */
  m1: number;
  g: number;
  /** Pulley moment of inertia, kg·m². */
  inertia: number;
  /** Pulley radius, m. */
  radius: number;
  /** Viscous friction b, N·s/m (must be > 0 for a steady state). */
  friction: number;
}

export const defaults: AtwoodOptions = { m1: 1, g: 9.81, inertia: 0.01, radius: 0.1, friction: 10 };

export interface AtwoodRun {
  /** Mass ratios R = M2 / M1, one per thread. Defaults to 101 values over [0, 1]. */
  ratios?: number[];
  /** Time step; defaults to 1/50 of the fastest time constant (M1 + I/r²) / b. */
  dt?: number;
  /** Relative distance from the steady speed that counts as steady. */
  tol?: number;
  maxSteps?: number;
}

export interface AtwoodPoint {
  ratio: number;
  /** Speed of the masses, m/s. */
  velocity: number;
  powerOut: number;
  powerIn: number;
  powerLoss: number;
  /** P_out / P_in (= R once moving). */
  efficiency: number;
  steady: boolean;
  time: number;
  distance: number;
  steps: number;
  /** Final orientation of the pulley. */
  pulley: Quat;
}

export function steadyState(o: AtwoodOptions, ratio: number) {
  const velocity = ((1 - ratio) * o.m1 * o.g) / o.friction;
  return { velocity, powerOut: ratio * o.m1 * o.g * velocity };
}

export const linspace = (from: number, to: number, count: number) =>
  Array.from({ length: count }, (_, i) => (count === 1 ? from : from + ((to - from) * i) / (count - 1)));

export async function simulate(engine: Engine, o: AtwoodOptions = defaults, run: AtwoodRun = {}) {
  if (!(o.friction > 0)) {
    throw new RangeError('friction must be > 0: without dissipation there is no steady power');
  }
  if (!(o.m1 > 0 && o.radius > 0 && o.inertia >= 0)) {
    throw new RangeError('m1 and radius must be > 0, inertia >= 0');
  }
  const ratios = run.ratios ?? linspace(0, 1, 101);
  if (ratios.some((r) => !(r >= 0 && r <= 1))) throw new RangeError('ratios must be in [0, 1]');
  const fastest = (o.m1 + o.inertia / o.radius ** 2) / o.friction;
  const dt = run.dt ?? fastest / 50;

  const state = new Float32Array(ratios.length * STATE_STRIDE);
  for (let i = 0; i < ratios.length; i++) writeQuat(state, i * STATE_STRIDE, IDENTITY);

  const result = await engine.run(kernel, {
    params: {
      count: ratios.length,
      max_steps: run.maxSteps ?? 100_000,
      ...o,
      dt,
      tol: run.tol ?? 1e-5,
    },
    input: new Float32Array(ratios),
    state,
    outputLength: ratios.length * OUTPUT_STRIDE,
    workgroups: Math.ceil(ratios.length / 64),
  });

  const points = ratios.map((_, i): AtwoodPoint => {
    const out = result.output.subarray(i * OUTPUT_STRIDE, (i + 1) * OUTPUT_STRIDE);
    const s = i * STATE_STRIDE;
    return {
      ratio: out[0],
      velocity: out[1],
      powerOut: out[2],
      powerIn: out[3],
      powerLoss: out[4],
      efficiency: out[3] > 0 ? out[2] / out[3] : 0,
      steady: out[5] === 1,
      time: result.state[s + 5],
      distance: result.state[s + 6],
      steps: result.state[s + 7],
      pulley: readQuat(result.state, s),
    };
  });
  return { points, dt, ms: result.ms, backend: engine.backend };
}
