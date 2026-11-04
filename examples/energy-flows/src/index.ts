import * as atwood from './atwood.ts';
import * as bicycle from './bicycle.ts';
import { solveEcosystems } from './ecosystem.ts';
import { createEngine } from './engine.ts';
import { formatFlows, holdForEmergy, imbalance } from './flows.ts';
import { silverSprings } from './silver-springs.ts';

// Phase 1, energy flows: three simulations, each a WGSL compute kernel run
// on the GPU when this browser has WebGPU, or on its CPU twin otherwise.
const engine = await createEngine();
console.info(`Running on ${engine.description}`);

// ---- B. The Atwood machine: maximum power at 50% efficiency -------------
// One thread per mass ratio R = M2/M1 from 0 to 1.
const machine = await atwood.simulate(engine);
const best = machine.points.reduce((a, b) => (b.powerOut > a.powerOut ? b : a));
console.log(
  `Atwood: ${machine.points.length} ratios in ${machine.ms.toFixed(1)} ms; ` +
    `maximum power ${best.powerOut.toFixed(3)} W at R = ${best.ratio.toFixed(2)}, ` +
    `efficiency ${(100 * best.efficiency).toFixed(0)}%`
);
plot(
  [
    { name: 'useful power M2·g·v', points: machine.points.map((p): [number, number] => [p.ratio, p.powerOut]) },
    { name: 'heat b·v²', points: machine.points.map((p): [number, number] => [p.ratio, p.powerLoss]) },
  ],
  { title: 'Atwood machine at steady speed (Odum & Pinkerton, 1955)', xLabel: 'Load ratio R = M2 / M1', yLabel: 'Power (W)' }
);

// ---- A. Pedalling through a planetary hub ------------------------------
// One thread per target cadence, for each of the hub's three gears.
const rides = await Promise.all(
  Object.entries(bicycle.GEARS).map(async ([name, gear]) => ({ name, ...(await bicycle.ride(engine, { gear })) }))
);
for (const { name, points, optimalCadence } of rides) {
  const peak = points.reduce((a, b) => (b.powerOut > a.powerOut ? b : a));
  console.log(
    `Bicycle, ${name.padEnd(6)} gear ${peak.gearRatio.toFixed(2)}: hub efficiency ` +
      `${(100 * peak.hubEfficiency).toFixed(2)}%, peak ${peak.powerOut.toFixed(0)} W at ` +
      `${peak.cadence.toFixed(0)} rpm (T_max/2a = ${optimalCadence.toFixed(0)} rpm), ` +
      `spin-up ${peak.spinUp.toFixed(2)} s`
  );
}
plot(
  rides.map(({ name, points }) => ({
    name: `${name} gear`,
    points: points.map((p): [number, number] => [p.cadence, p.powerOut]),
  })),
  { title: 'Power at the hub output vs pedalling rate (Gardner et al., 2007)', xLabel: 'Pedalling rate (rpm)', yLabel: 'Power (W)' }
);

// ---- C. Silver Springs: energy flows to steady state --------------------
// One workgroup per configuration: the published budget, then a sweep of
// the grazing pressure on the producers.
const grazing = Array.from({ length: 16 }, (_, i) => 0.25 + i * 0.25);
const networks = [silverSprings(), ...grazing.map((g) => silverSprings({ grazing: g }))];
const { results, ms } = await solveEcosystems(engine, networks);
const [budget, ...sweep] = results;
console.log(
  `Silver Springs: ${results.length} networks to steady state in ${ms.toFixed(1)} ms ` +
    `(${budget.steps} steps, residual ${budget.residual.toExponential(1)}, ` +
    `balance error ${imbalance(budget).toExponential(1)})`
);
console.log(`Steady-state energy flow matrix A, kcal/m²/yr:\n${formatFlows(budget)}`);

// Held in memory for Phase 2, the emergy pass.
holdForEmergy('silver-springs', budget);

// In a linear donor-controlled food chain, everything above the herbivores
// scales with them; the producers and decomposers respond differently.
const series = ['producers', 'herbivores', 'decomposers'].map((name) => {
  const i = budget.labels.indexOf(name);
  return {
    name,
    points: sweep.map((r, k): [number, number] => [grazing[k], r.storage[i] / budget.storage[i]]),
  };
});
plot(series, {
  title: 'Silver Springs: steady storages vs grazing',
  xLabel: 'Grazing (× the measured producers → herbivores flow)',
  yLabel: '× measured storage',
});

// Try: edit the network in silver-springs.ts (add a pathway, or a second
// source), change the friction in atwood.ts, or the hub's teeth in bicycle.ts.
