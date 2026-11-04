/**
 * Specification C: an ecosystem's energy flows, integrated to steady state.
 *
 * Each workgroup takes one ecosystem configuration (an interaction matrix C
 * and external input u, from the dialect) and integrates
 *
 *     x(t+1) = x(t) + Δt (C x(t) + u)            (forward Euler)
 *
 * with invocation i owning compartment i: it computes row i of C x from the
 * x the workgroup shares, then updates x_i. The workgroup stops when every
 * compartment is steady, |dx_i/dt| ≤ tol · (its gross throughflow), when f32
 * can't move x any further, or if the integration diverges.
 *
 * At steady state it writes the energy flow matrix (Li et al., 2010, eq. 12)
 *
 *     a_ij = C[j][i] · x_i     (i ≠ j): the flow from i to j,
 *
 * the inputs z_i = u_i and the outputs to sinks y_i = −(Σ_j C[j][i]) x_i,
 * the hand-off to Phase 2 (see flows.ts).
 *
 * Forward Euler is stable for these donor-controlled networks when
 * Δt ≤ 1 / max_i |C_ii| (every eigenvalue lies in a Gershgorin disc centred
 * on C_ii with radius ≤ |C_ii|), so the default Δt is half that.
 */

import type { Network } from './dialect.ts';
import { type Engine, type Kernel } from './engine.ts';
import type { EnergyFlows } from './flows.ts';
import { MATRIX_WGSL, MAX_N, flatIndex, solve } from './matrix.ts';

/** Per configuration: C (n×n) then u (n). */
export const inputStride = (n: number) => n * n + n;
/** Per configuration: x (n), then steps, residual, converged, diverged. */
export const stateStride = (n: number) => n + 4;
/** Per configuration: A (n×n), then inflows z (n), then outflows y (n). */
export const outputStride = (n: number) => n * n + 2 * n;

const params = [
  ['n', 'u32'],
  ['configs', 'u32'],
  ['max_steps', 'u32'],
  ['dt', 'f32'],
  ['tol', 'f32'],
] as const;

type Param = (typeof params)[number][0];

const UNSTEADY = 1;
const MOVED = 2;
const DIVERGED = 4;

export const kernel: Kernel<Param> = {
  label: 'ecosystem',
  params,
  wgsl: /* wgsl */ `${MATRIX_WGSL}
var<workgroup> wg_flags: array<u32, MAX_N>;
var<workgroup> wg_residual: array<f32, MAX_N>;
var<workgroup> wg_done: u32;

const UNSTEADY: u32 = ${UNSTEADY}u;
const MOVED: u32 = ${MOVED}u;
const DIVERGED: u32 = ${DIVERGED}u;

fn is_finite(v: f32) -> bool {
  return (bitcast<u32>(v) & 0x7f800000u) != 0x7f800000u;
}

@compute @workgroup_size(MAX_N)
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_index) i: u32) {
  let n = params.n;
  let config = wg.x;
  if (config >= params.configs) {
    return;
  }
  let in_base = config * (n * n + n);
  let state_base = config * (n + 4u);
  let out_base = config * (n * n + 2u * n);
  let row = i < n;

  // Stage C and x(0) in workgroup memory: invocation i loads row i.
  var u_i = 0.0;
  if (row) {
    for (var j = 0u; j < n; j++) {
      wg_matrix[flat_index(i, j, n)] = input[in_base + flat_index(i, j, n)];
    }
    u_i = input[in_base + n * n + i];
    wg_vector[i] = state[state_base + i];
  }
  workgroupBarrier();
  var c_ii = 0.0;
  if (row) {
    c_ii = wg_matrix[flat_index(i, i, n)];
  }

  var taken = 0u;
  for (var k = 0u; k < params.max_steps; k++) {
    var dx = 0.0;
    if (row) {
      dx = mat_vec_row(i, n) + u_i; // (C x + u)_i
    }
    workgroupBarrier(); // everyone has read x(t) before it changes
    var flags = 0u;
    if (row) {
      let x_old = wg_vector[i];
      let x_new = x_old + params.dt * dx;
      wg_vector[i] = x_new;
      if (abs(dx) > params.tol * (abs(c_ii * x_old) + abs(u_i))) {
        flags |= UNSTEADY;
      }
      if (x_new != x_old) {
        flags |= MOVED;
      }
      if (!is_finite(x_new)) {
        flags |= DIVERGED;
      }
    }
    wg_flags[i] = flags;
    taken += 1u;
    workgroupBarrier();
    if (i == 0u) {
      var all = 0u;
      for (var r = 0u; r < n; r++) {
        all |= wg_flags[r];
      }
      let stop = (all & UNSTEADY) == 0u || (all & MOVED) == 0u || (all & DIVERGED) != 0u;
      wg_done = select(0u, 1u, stop);
    }
    if (workgroupUniformLoad(&wg_done) == 1u) {
      break;
    }
  }

  // Residual at the final state, relative to each compartment's throughflow.
  var x_i = 0.0;
  if (row) {
    x_i = wg_vector[i];
    let dx = mat_vec_row(i, n) + u_i;
    wg_residual[i] = abs(dx) / max(abs(c_ii * x_i) + abs(u_i), 1e-30);
    wg_flags[i] = select(DIVERGED, 0u, is_finite(x_i));
    state[state_base + i] = x_i;
  }
  workgroupBarrier();
  if (i == 0u) {
    var residual = 0.0;
    var diverged = false;
    for (var r = 0u; r < n; r++) {
      residual = max(residual, wg_residual[r]);
      diverged = diverged || wg_flags[r] != 0u;
    }
    state[state_base + n] = state[state_base + n] + f32(taken);
    state[state_base + n + 1u] = residual;
    state[state_base + n + 2u] = select(0.0, 1.0, !diverged && residual <= params.tol);
    state[state_base + n + 3u] = select(0.0, 1.0, diverged);
  }

  // The steady-state flow matrix: invocation i writes row i (flows out of i).
  if (row) {
    var column_sum = 0.0;
    for (var j = 0u; j < n; j++) {
      let c_ji = wg_matrix[flat_index(j, i, n)];
      column_sum += c_ji;
      output[out_base + flat_index(i, j, n)] = select(c_ji * x_i, 0.0, i == j);
    }
    output[out_base + n * n + i] = u_i;
    output[out_base + n * n + n + i] = -column_sum * x_i;
  }
}
`,
  cpu({ params: p, input, state, output }) {
    const n = p.n;
    for (let config = 0; config < p.configs; config++) {
      const inBase = config * inputStride(n);
      const stateBase = config * stateStride(n);
      const outBase = config * outputStride(n);
      const C = input.subarray(inBase, inBase + n * n);
      const u = input.subarray(inBase + n * n, inBase + n * n + n);
      const x = Array.from(state.subarray(stateBase, stateBase + n));
      const rate = (i: number) => {
        let sum = u[i];
        for (let j = 0; j < n; j++) sum += C[flatIndex(i, j, n)] * x[j];
        return sum;
      };
      let taken = 0;
      for (let k = 0; k < p.max_steps; k++) {
        const dx = x.map((_, i) => rate(i));
        let all = 0;
        for (let i = 0; i < n; i++) {
          const xNew = x[i] + p.dt * dx[i];
          if (Math.abs(dx[i]) > p.tol * (Math.abs(C[flatIndex(i, i, n)] * x[i]) + Math.abs(u[i]))) all |= UNSTEADY;
          if (xNew !== x[i]) all |= MOVED;
          if (!Number.isFinite(xNew)) all |= DIVERGED;
          x[i] = xNew;
        }
        taken++;
        if (!(all & UNSTEADY) || !(all & MOVED) || all & DIVERGED) break;
      }
      let residual = 0;
      let diverged = false;
      for (let i = 0; i < n; i++) {
        const throughflow = Math.abs(C[flatIndex(i, i, n)] * x[i]) + Math.abs(u[i]);
        residual = Math.max(residual, Math.abs(rate(i)) / Math.max(throughflow, 1e-30));
        diverged ||= !Number.isFinite(x[i]);
      }
      state.set(x, stateBase);
      state.set(
        [state[stateBase + n] + taken, residual, !diverged && residual <= p.tol ? 1 : 0, diverged ? 1 : 0],
        stateBase + n
      );
      for (let i = 0; i < n; i++) {
        let columnSum = 0;
        for (let j = 0; j < n; j++) {
          const cji = C[flatIndex(j, i, n)];
          columnSum += cji;
          output[outBase + flatIndex(i, j, n)] = i === j ? 0 : cji * x[i];
        }
        output[outBase + n * n + i] = u[i];
        output[outBase + n * n + n + i] = -columnSum * x[i];
      }
    }
  },
};

/** The exact steady state, x* = −C⁻¹ u. */
export function steadyState(network: Network): number[] {
  return solve(network.C, network.u.map((v) => -v), network.storages.length);
}

/** Largest |C_ii|: the fastest turnover in the network. */
export function fastestTurnover(network: Network): number {
  const n = network.storages.length;
  return Math.max(0, ...network.storages.map((_, i) => Math.abs(network.C[i * n + i])));
}

export interface SolveOptions {
  /** Time step. Defaults to 1 / (2 max |C_ii|) over all the networks. */
  dt?: number;
  /** Steady when |dx_i/dt| ≤ tol × throughflow_i for every i. */
  tol?: number;
  maxSteps?: number;
}

/**
 * Integrates each network to steady state, one workgroup per network, and
 * returns their energy flows. Networks of different sizes are padded with
 * empty compartments, which stay empty.
 */
export async function solveEcosystems(engine: Engine, networks: Network[], options: SolveOptions = {}) {
  if (networks.length === 0) throw new RangeError('No networks to solve');
  const n = Math.max(...networks.map((net) => net.storages.length));
  if (n > MAX_N) throw new RangeError(`A network has ${n} storages; the kernel handles up to ${MAX_N}`);
  const fastest = Math.max(...networks.map(fastestTurnover));
  const dt = options.dt ?? (fastest > 0 ? 0.5 / fastest : 1);
  if (!(dt > 0)) throw new RangeError('dt must be positive');

  const input = new Float32Array(networks.length * inputStride(n));
  const state = new Float32Array(networks.length * stateStride(n));
  networks.forEach((net, k) => {
    const m = net.storages.length;
    const base = k * inputStride(n);
    for (let i = 0; i < m; i++) {
      for (let j = 0; j < m; j++) input[base + i * n + j] = net.C[i * m + j];
      input[base + n * n + i] = net.u[i];
    }
    state.set(net.x0, k * stateStride(n));
  });

  const result = await engine.run(kernel, {
    params: {
      n,
      configs: networks.length,
      max_steps: options.maxSteps ?? 1_000_000,
      dt,
      tol: options.tol ?? 1e-4,
    },
    input,
    state,
    outputLength: networks.length * outputStride(n),
    workgroups: networks.length,
  });

  const results = networks.map((net, k): EnergyFlows => {
    const m = net.storages.length;
    const out = result.output.subarray(k * outputStride(n), (k + 1) * outputStride(n));
    const st = result.state.subarray(k * stateStride(n), (k + 1) * stateStride(n));
    const A = new Float32Array(m * m);
    for (let i = 0; i < m; i++) A.set(out.subarray(i * n, i * n + m), i * m);
    const storage = st.slice(0, m);
    return {
      labels: [...net.storages],
      n: m,
      A,
      inflow: out.slice(n * n, n * n + m),
      outflow: out.slice(n * n + n, n * n + n + m),
      storage,
      sources: net.sources.map((s) => ({ name: s.name, flows: Float32Array.from(s.flows) })),
      sinks: net.sinks.map((s) => ({
        name: s.name,
        flows: Float32Array.from(s.coefficients, (c, i) => c * storage[i]),
      })),
      steps: st[n],
      residual: st[n + 1],
      converged: st[n + 2] === 1,
      diverged: st[n + 3] === 1,
    };
  });
  return { results, dt, ms: result.ms, backend: engine.backend };
}
