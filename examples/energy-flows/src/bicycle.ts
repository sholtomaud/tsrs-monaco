/**
 * Specification A: pedalling a bicycle through an epicyclic (planetary)
 * in-hub gear.
 *
 * The rider: maximal torque falls linearly with pedalling rate PR (rpm),
 *
 *     T = T_max − a·PR                     (Gardner et al., 2007)
 *
 * so crank power T·ω is a parabola, peaking at PR = T_max / 2a. The default
 * T_max and a put the peak near 1.8 kW at about 130 rpm, the order of the
 * maxima reported for elite sprint cyclists.
 *
 * The hub: sun (S), carrier (C, carrying the planets P) and ring (R). Its
 * fundamental circuit equation (Willis; Wu & Cheng, 2014) ties the speeds
 * together relative to the carrier,
 *
 *     Z_S (ω_S − ω_C) + Z_R (ω_R − ω_C) = 0,
 *
 * and with one member held (or the hub locked) and one driven, the speeds
 * and torques come from two 3×3 linear systems — the transmission matrix:
 *
 *     speeds   [ Z_S  −(Z_S+Z_R)  Z_R ] [ω_S]   [0]
 *              [ fixed member = 0     ] [ω_C] = [0]
 *              [ input member = 1     ] [ω_R]   [1]
 *
 *     torques  [ 1        1      1        ] [T_S]   [0]   (equilibrium)
 *              [ e_S·ΔS   0      e_R·ΔR   ] [T_C] = [0]   (latent power)
 *              [ input member = 1         ] [T_R]   [1]
 *
 * ΔS = ω_S − ω_C and ΔR = ω_R − ω_C are the speeds seen from the carrier.
 * Only this "latent" power, T·Δ, passes through the meshes, so only it pays
 * the gear-mesh losses: the member that drives in the carrier's frame sends
 * η = η_mesh² of its latent power on (two meshes, sun–planet and
 * planet–ring), so its weight e is η and the other's 1. Which one drives is
 * read from the lossless solution. That is why a planetary hub is more
 * efficient than η: e.g. η(Z_R + Z_S)/(ηZ_R + Z_S) in its overdrive.
 *
 * The ride, one GPU thread per target cadence: an isokinetic ergometer lets
 * the rider spin a flywheel (inertia I at the hub output) up from rest,
 *
 *     α = T_out / I,   ω ← ω + α Δt,   q ← normalize(q_update(q, ω, Δt))
 *
 * for the sun, carrier, ring and a planet, then holds the cadence. There the
 * steady power is P = T_out · ω.
 */

import { type Engine, type Kernel } from './engine.ts';
import { solve } from './matrix.ts';
import { IDENTITY, QUATERNION_WGSL, qNormalize, qUpdate, readQuat, writeQuat, type Quat } from './quaternion.ts';

export const MEMBERS = ['sun', 'carrier', 'ring'] as const;
export type Member = (typeof MEMBERS)[number];
/** fixed: 'none' locks the hub (direct drive). */
export interface Gear {
  input: Member;
  output: Member;
  fixed: Member | 'none';
}

/** A classic three-speed hub's gears with the default teeth: 3/4, 1 and 4/3. */
export const GEARS = {
  low: { input: 'ring', output: 'carrier', fixed: 'sun' },
  direct: { input: 'carrier', output: 'ring', fixed: 'none' },
  high: { input: 'carrier', output: 'ring', fixed: 'sun' },
} satisfies Record<string, Gear>;

export interface Hub {
  sunTeeth: number;
  ringTeeth: number;
  /** Efficiency of one gear mesh. */
  meshEfficiency: number;
}

export interface Rider {
  /** Torque at zero cadence, N·m. */
  maxTorque: number;
  /** Fall in torque per rpm, N·m/rpm. */
  slope: number;
}

export interface Bike {
  /** ω_hub / ω_crank: chainring teeth / sprocket teeth. */
  chainRatio: number;
  /** Flywheel inertia reflected to the hub output, kg·m². */
  inertia: number;
}

export const defaults = {
  hub: { sunTeeth: 18, ringTeeth: 54, meshEfficiency: 0.98 } satisfies Hub,
  rider: { maxTorque: 266, slope: 266 / 258 } satisfies Rider,
  bike: { chainRatio: 44 / 16, inertia: 2 } satisfies Bike,
};

/** Floats per thread in the state buffer: 4 quaternions (sun, carrier, ring, planet), ω_out, t, steps, reached. */
export const STATE_STRIDE = 20;
/** Floats per thread in the output buffer (see `CadencePoint`). */
export const OUTPUT_STRIDE = 10;
const NONE = 3;

const params = [
  ['count', 'u32'],
  ['max_steps', 'u32'],
  ['input_member', 'u32'],
  ['output_member', 'u32'],
  ['fixed_member', 'u32'],
  ['t_max', 'f32'],
  ['slope', 'f32'],
  ['inertia', 'f32'],
  ['chain_ratio', 'f32'],
  ['z_sun', 'f32'],
  ['z_ring', 'f32'],
  ['eta_mesh', 'f32'],
  ['dt', 'f32'],
] as const;

type Param = (typeof params)[number][0];

export const kernel: Kernel<Param> = {
  label: 'bicycle',
  params,
  wgsl: /* wgsl */ `${QUATERNION_WGSL}
const STATE_STRIDE: u32 = ${STATE_STRIDE}u;
const OUTPUT_STRIDE: u32 = ${OUTPUT_STRIDE}u;
const SUN: u32 = 0u;
const CARRIER: u32 = 1u;
const RING: u32 = 2u;
const NONE: u32 = ${NONE}u;
const RPM: f32 = 0.10471975512; // rad/s per rpm

fn unit(i: u32) -> vec3<f32> {
  var e = vec3<f32>(0.0);
  e[i] = 1.0;
  return e;
}

// Solves M x = b for M given by its rows (Cramer's rule).
fn solve3(r0: vec3<f32>, r1: vec3<f32>, r2: vec3<f32>, b: vec3<f32>) -> vec3<f32> {
  let m = transpose(mat3x3<f32>(r0, r1, r2)); // m[k] is column k
  let det = determinant(m);
  return vec3<f32>(
    determinant(mat3x3<f32>(b, m[1], m[2])),
    determinant(mat3x3<f32>(m[0], b, m[2])),
    determinant(mat3x3<f32>(m[0], m[1], b))
  ) / det;
}

struct Transmission {
  speeds: vec3<f32>,   // (sun, carrier, ring) per unit input speed
  torques: vec3<f32>,  // external torques per unit input torque
}

fn transmission() -> Transmission {
  let zs = params.z_sun;
  let zr = params.z_ring;
  let input_row = unit(params.input_member);
  let direct = params.fixed_member == NONE;

  // Speeds: the fundamental circuit equation, the held member (or the hub
  // locked: sun turning with the carrier) and the driven member.
  let willis = vec3<f32>(zs, -(zs + zr), zr);
  let held = select(unit(min(params.fixed_member, RING)), vec3<f32>(1.0, -1.0, 0.0), direct);
  let w = solve3(willis, held, input_row, vec3<f32>(0.0, 0.0, 1.0));

  // Torques: equilibrium, latent power through the meshes, the input torque.
  let rel = vec3<f32>(w.x - w.y, 0.0, w.z - w.y);
  let balance = vec3<f32>(1.0, 1.0, 1.0);
  let b = vec3<f32>(0.0, 0.0, 1.0);
  if (direct) {
    // A locked hub carries no torque through the gears.
    return Transmission(w, solve3(balance, vec3<f32>(1.0, 0.0, 0.0), input_row, b));
  }
  let lossless = solve3(balance, rel, input_row, b);
  let eta = params.eta_mesh * params.eta_mesh;
  // The sun drives in the carrier's frame when its latent power flows in.
  let sun_drives = lossless.x * rel.x > 0.0;
  let e = select(vec3<f32>(1.0, 0.0, eta), vec3<f32>(eta, 0.0, 1.0), sun_drives);
  return Transmission(w, solve3(balance, rel * e, input_row, b));
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= params.count) {
    return;
  }
  let hub = transmission();
  let ratio = hub.speeds[params.output_member];            // ω_out / ω_in
  let torque_factor = -hub.torques[params.output_member];  // T_out / T_in
  let gear = params.chain_ratio * ratio;                   // ω_out / ω_crank
  let planet_teeth = 0.5 * (params.z_ring - params.z_sun);

  let target_cadence = input[i];
  let omega_target = target_cadence * RPM * gear;

  let s = i * STATE_STRIDE;
  var q: array<vec4<f32>, 4>;
  for (var k = 0u; k < 4u; k++) {
    let o = s + 4u * k;
    q[k] = vec4<f32>(state[o], state[o + 1u], state[o + 2u], state[o + 3u]);
  }
  var omega = state[s + 16u];
  var t = state[s + 17u];
  var steps = u32(state[s + 18u]);
  var reached = false;

  for (var k = 0u; k < params.max_steps; k++) {
    if (omega >= omega_target) {
      omega = omega_target;
      reached = true;
      break;
    }
    let cadence = omega / (gear * RPM);
    let t_crank = params.t_max - params.slope * cadence;
    if (t_crank <= 0.0) {
      break;
    }
    let t_out = t_crank / params.chain_ratio * torque_factor;

    // Rotate each member about the axle (x) at its own speed.
    let w = hub.speeds * (omega / ratio);
    let w_planet = w.y - params.z_sun / planet_teeth * (w.x - w.y);
    var spins = array<f32, 4>(w.x, w.y, w.z, w_planet);
    for (var m = 0u; m < 4u; m++) {
      q[m] = q_normalize(q_update(q[m], vec3<f32>(spins[m], 0.0, 0.0), params.dt));
    }

    let alpha = t_out / params.inertia;
    omega = min(omega + alpha * params.dt, omega_target);
    t += params.dt;
    steps += 1u;
  }

  for (var k = 0u; k < 4u; k++) {
    let o = s + 4u * k;
    state[o] = q[k].x;
    state[o + 1u] = q[k].y;
    state[o + 2u] = q[k].z;
    state[o + 3u] = q[k].w;
  }
  state[s + 16u] = omega;
  state[s + 17u] = t;
  state[s + 18u] = f32(steps);
  state[s + 19u] = select(0.0, 1.0, reached);

  let cadence = omega / (gear * RPM);
  let t_crank = max(params.t_max - params.slope * cadence, 0.0);
  let t_out = t_crank / params.chain_ratio * torque_factor;
  let p_in = t_crank * cadence * RPM;
  let p_out = t_out * omega;
  let o = i * OUTPUT_STRIDE;
  output[o] = cadence;
  output[o + 1u] = t_crank;
  output[o + 2u] = t_out;
  output[o + 3u] = omega;
  output[o + 4u] = p_in;
  output[o + 5u] = p_out;
  output[o + 6u] = torque_factor * ratio; // hub efficiency
  output[o + 7u] = gear;
  output[o + 8u] = t;
  output[o + 9u] = select(0.0, 1.0, reached);
}
`,
  cpu({ params: p, input, state, output }) {
    const fixed = p.fixed_member === NONE ? 'none' : MEMBERS[p.fixed_member];
    const hub = transmission(
      { input: MEMBERS[p.input_member], output: MEMBERS[p.output_member], fixed },
      { sunTeeth: p.z_sun, ringTeeth: p.z_ring, meshEfficiency: p.eta_mesh }
    );
    const ratio = hub.speeds[p.output_member];
    const torqueFactor = -hub.torques[p.output_member];
    const gear = p.chain_ratio * ratio;
    const planetTeeth = 0.5 * (p.z_ring - p.z_sun);
    const RPM = Math.fround(0.10471975512);

    for (let i = 0; i < p.count; i++) {
      const target = input[i] * RPM * gear;
      const s = i * STATE_STRIDE;
      const q = [0, 1, 2, 3].map((k) => readQuat(state, s + 4 * k));
      let [omega, t, steps] = [state[s + 16], state[s + 17], state[s + 18]];
      let reached = false;
      for (let k = 0; k < p.max_steps; k++) {
        if (omega >= target) {
          omega = target;
          reached = true;
          break;
        }
        const tCrank = p.t_max - p.slope * (omega / (gear * RPM));
        if (tCrank <= 0) break;
        const tOut = (tCrank / p.chain_ratio) * torqueFactor;
        const [ws, wc, wr] = hub.speeds.map((x) => x * (omega / ratio));
        const wPlanet = wc - (p.z_sun / planetTeeth) * (ws - wc);
        [ws, wc, wr, wPlanet].forEach((spin, m) => {
          q[m] = qNormalize(qUpdate(q[m], [spin, 0, 0], p.dt));
        });
        omega = Math.min(omega + (tOut / p.inertia) * p.dt, target);
        t += p.dt;
        steps++;
      }
      q.forEach((quat, k) => writeQuat(state, s + 4 * k, quat));
      state.set([omega, t, steps, reached ? 1 : 0], s + 16);

      const cadence = omega / (gear * RPM);
      const tCrank = Math.max(p.t_max - p.slope * cadence, 0);
      const tOut = (tCrank / p.chain_ratio) * torqueFactor;
      output.set(
        [cadence, tCrank, tOut, omega, tCrank * cadence * RPM, tOut * omega, torqueFactor * ratio, gear, t, reached ? 1 : 0],
        i * OUTPUT_STRIDE
      );
    }
  },
};

/** The transmission matrix solved on the CPU (as the kernel does). */
export function transmission(gear: Gear, hub: Hub) {
  const unit = (m: Member) => [0, 1, 2].map((k) => (k === MEMBERS.indexOf(m) ? 1 : 0));
  const zs = hub.sunTeeth;
  const zr = hub.ringTeeth;
  const direct = gear.fixed === 'none';
  const held = gear.fixed === 'none' ? [1, -1, 0] : unit(gear.fixed);
  const speeds = solve([zs, -(zs + zr), zr, ...held, ...unit(gear.input)], [0, 0, 1], 3);
  const rel = [speeds[0] - speeds[1], 0, speeds[2] - speeds[1]];
  const torquesWith = (row: number[]) => solve([1, 1, 1, ...row, ...unit(gear.input)], [0, 0, 1], 3);
  let torques: number[];
  if (direct) {
    torques = torquesWith([1, 0, 0]);
  } else {
    const lossless = torquesWith(rel);
    const eta = hub.meshEfficiency ** 2;
    const e = lossless[0] * rel[0] > 0 ? [eta, 0, 1] : [1, 0, eta];
    torques = torquesWith(rel.map((r, k) => r * e[k]));
  }
  const out = MEMBERS.indexOf(gear.output);
  return {
    speeds,
    torques,
    ratio: speeds[out],
    efficiency: -torques[out] * speeds[out],
  };
}

export interface CadencePoint {
  /** Pedalling rate reached, rpm. */
  cadence: number;
  crankTorque: number;
  outputTorque: number;
  /** Hub output speed, rad/s. */
  omega: number;
  powerIn: number;
  powerOut: number;
  hubEfficiency: number;
  /** ω_out / ω_crank */
  gearRatio: number;
  /** Time to spin up to the cadence, s. */
  spinUp: number;
  reached: boolean;
  /** Final orientations: sun, carrier, ring, planet. */
  orientations: Quat[];
}

export interface RideOptions {
  gear?: Gear;
  hub?: Hub;
  rider?: Rider;
  bike?: Bike;
  /** Target cadences, rpm, one per thread. Defaults to 51 from 0 to T_max/a. */
  cadences?: number[];
  dt?: number;
  maxSteps?: number;
}

function check(gear: Gear, hub: Hub) {
  if (gear.input === gear.output) throw new RangeError('The input and output must be different members');
  if (gear.fixed === gear.input || gear.fixed === gear.output) {
    throw new RangeError('The held member cannot be the input or the output');
  }
  const planet = (hub.ringTeeth - hub.sunTeeth) / 2;
  if (!(planet > 0) || !Number.isInteger(planet)) {
    throw new RangeError('ringTeeth − sunTeeth must be positive and even (it is twice the planet teeth)');
  }
  if (!(hub.meshEfficiency > 0 && hub.meshEfficiency <= 1)) {
    throw new RangeError('meshEfficiency must be in (0, 1]');
  }
}

export async function ride(engine: Engine, options: RideOptions = {}) {
  const gear = options.gear ?? GEARS.high;
  const hub = options.hub ?? defaults.hub;
  const rider = options.rider ?? defaults.rider;
  const bike = options.bike ?? defaults.bike;
  check(gear, hub);
  const maxCadence = rider.maxTorque / rider.slope;
  const cadences =
    options.cadences ?? Array.from({ length: 51 }, (_, i) => (maxCadence * i) / 50);

  const state = new Float32Array(cadences.length * STATE_STRIDE);
  for (let i = 0; i < cadences.length; i++) {
    for (let k = 0; k < 4; k++) writeQuat(state, i * STATE_STRIDE + 4 * k, IDENTITY);
  }
  const result = await engine.run(kernel, {
    params: {
      count: cadences.length,
      max_steps: options.maxSteps ?? 30_000,
      input_member: MEMBERS.indexOf(gear.input),
      output_member: MEMBERS.indexOf(gear.output),
      fixed_member: gear.fixed === 'none' ? NONE : MEMBERS.indexOf(gear.fixed),
      t_max: rider.maxTorque,
      slope: rider.slope,
      inertia: bike.inertia,
      chain_ratio: bike.chainRatio,
      z_sun: hub.sunTeeth,
      z_ring: hub.ringTeeth,
      eta_mesh: hub.meshEfficiency,
      dt: options.dt ?? 1e-3,
    },
    input: new Float32Array(cadences),
    state,
    outputLength: cadences.length * OUTPUT_STRIDE,
    workgroups: Math.ceil(cadences.length / 64),
  });

  const points = cadences.map((_, i): CadencePoint => {
    const o = result.output.subarray(i * OUTPUT_STRIDE, (i + 1) * OUTPUT_STRIDE);
    const s = i * STATE_STRIDE;
    return {
      cadence: o[0],
      crankTorque: o[1],
      outputTorque: o[2],
      omega: o[3],
      powerIn: o[4],
      powerOut: o[5],
      hubEfficiency: o[6],
      gearRatio: o[7],
      spinUp: o[8],
      reached: o[9] === 1,
      orientations: [0, 1, 2, 3].map((k) => readQuat(result.state, s + 4 * k)),
    };
  });
  return { points, ms: result.ms, backend: engine.backend, optimalCadence: maxCadence / 2 };
}
