import { parseNetwork } from './dialect.ts';
import { fastestTurnover, solveEcosystems, steadyState } from './ecosystem.ts';
import { cpuEngine } from './engine.ts';
import { heldFlows, holdForEmergy, imbalance } from './flows.ts';
import { BUDGET, silverSprings } from './silver-springs.ts';

const relative = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);
const network = silverSprings();
const {
  results: [flows],
} = await solveEcosystems(cpuEngine, [network]);

test('integrates to the exact steady state x* = -C⁻¹u', () => {
  expect(flows.converged).toBe(true);
  expect(flows.diverged).toBe(false);
  steadyState(network).forEach((x, i) => expect(relative(flows.storage[i], x)).toBeLessThan(1e-3));
});

test('the flow matrix A reproduces the Silver Springs budget', () => {
  for (const [from, to, flow] of BUDGET) {
    const i = flows.labels.indexOf(from);
    const j = flows.labels.indexOf(to);
    expect(relative(flows.A[i * flows.n + j], flow)).toBeLessThan(1e-3);
  }
  // Nothing flows back up the food chain, and a_ii = 0.
  for (let i = 0; i < flows.n; i++) {
    for (let j = 0; j <= i; j++) expect(flows.A[i * flows.n + j]).toBe(0);
  }
});

test('energy is conserved: inputs = flows out + losses to sinks', () => {
  expect(imbalance(flows)).toBeLessThan(1e-3);
  const sink = (name: string) => flows.sinks.find((s) => s.name === name)!.flows.reduce((a, b) => a + b, 0);
  expect(relative(sink('respiration'), 11977 + 1890 + 316 + 13 + 4149)).toBeLessThan(1e-3);
  expect(relative(sink('export'), 2465)).toBeLessThan(1e-3);
  expect(relative(sink('respiration') + sink('export'), 20810)).toBeLessThan(1e-3);
});

test('networks of different sizes share one dispatch', async () => {
  // Odum's CASH tank (dM/dt = 4 - 0.05 M) next to Silver Springs.
  const cash = parseNetwork('storage M\nsource J\nsink spent\nJ -> M = 4\nM -> spent = 0.05 * M');
  const { results } = await solveEcosystems(cpuEngine, [network, cash, network]);
  expect(results.map((r) => r.n)).toEqual([5, 1, 5]);
  expect(relative(results[1].storage[0], 80)).toBeLessThan(1e-3);
  expect(Array.from(results[2].A)).toEqual(Array.from(results[0].A));
});

test('flags a time step too large for forward Euler', async () => {
  const dt = 3 / fastestTurnover(network);
  const { results } = await solveEcosystems(cpuEngine, [network], { dt, maxSteps: 10_000 });
  expect(results[0].diverged).toBe(true);
  expect(results[0].converged).toBe(false);
});

test('holds the result in memory for the emergy pass', () => {
  holdForEmergy('test', flows);
  expect(heldFlows().get('test')).toBe(flows);
});
