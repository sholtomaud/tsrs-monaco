/**
 * The hand-off to Phase 2 (emergy algebra).
 *
 * Phase 1 ends with each ecosystem's steady-state energy flows: the N×N
 * input–output flow matrix A of Li et al. (2010), whose element a_ij is the
 * steady flow from compartment i to compartment j, plus the flows across the
 * boundary (inputs from each source, outputs to each sink). That is what an
 * emergy pass needs, whether it computes transformities with the minimum
 * eigenvalue method (Collins & Odum, 2000), matrix inversion (Li et al.,
 * 2010) or the SVD of an overdetermined system (Patterson, 2012).
 *
 * Results are kept here, in memory, by name, for that pass to pick up.
 */

export interface EnergyFlows {
  /** Compartment names: the order of the rows and columns of A. */
  labels: string[];
  n: number;
  /** A[i * n + j]: steady-state flow from i to j (a_ii = 0). Row-major, n×n. */
  A: Float32Array;
  /** z_i: inflow into i from all sources. */
  inflow: Float32Array;
  /** y_i: outflow from i to all sinks. */
  outflow: Float32Array;
  /** Steady-state storages x*. */
  storage: Float32Array;
  /** Inputs from each source into each compartment. */
  sources: { name: string; flows: Float32Array }[];
  /** Outputs from each compartment to each sink. */
  sinks: { name: string; flows: Float32Array }[];
  /** dx/dt ≈ 0 to within the tolerance. */
  converged: boolean;
  /** The integration blew up (dt too large for the network). */
  diverged: boolean;
  steps: number;
  /** max_i |dx_i/dt| / (gross throughflow of i) at the end. */
  residual: number;
}

/** Throughflow of each compartment, T_i = z_i + Σ_k a_ki (inflow side). */
export function throughflow(f: EnergyFlows): number[] {
  return f.labels.map((_, i) => {
    let total = f.inflow[i];
    for (let k = 0; k < f.n; k++) total += f.A[k * f.n + i];
    return total;
  });
}

/** Largest relative imbalance, |in − out| / in, over the compartments. */
export function imbalance(f: EnergyFlows): number {
  const inflows = throughflow(f);
  return Math.max(
    0,
    ...f.labels.map((_, i) => {
      let out = f.outflow[i];
      for (let j = 0; j < f.n; j++) out += f.A[i * f.n + j];
      return inflows[i] > 0 ? Math.abs(inflows[i] - out) / inflows[i] : 0;
    })
  );
}

/**
 * A as a table: row i, column j is the flow from i to j. Columns are
 * numbered like the rows, to keep it narrow enough for the Console.
 */
export function formatFlows(f: EnergyFlows, width = 6): string {
  const label = Math.max(7, ...f.labels.map((l) => l.length)) + 3;
  const cell = (v: number | string) => (typeof v === 'number' ? v.toFixed(0) : v).padStart(width);
  const line = (head: string, cells: (number | string)[]) => head.padEnd(label) + cells.map(cell).join('');
  return [
    line('from \\ to', [...f.labels.map((_, j) => j + 1), 'sinks']),
    ...f.labels.map((name, i) =>
      line(`${i + 1} ${name}`, [...Array.from(f.A.subarray(i * f.n, (i + 1) * f.n)), f.outflow[i]])
    ),
    line('sources', Array.from(f.inflow)),
  ].join('\n');
}

const held = new Map<string, EnergyFlows>();

/** Keeps a result in memory for the emergy pass. */
export function holdForEmergy(name: string, flows: EnergyFlows): void {
  held.set(name, flows);
}

export function heldFlows(): ReadonlyMap<string, EnergyFlows> {
  return held;
}
