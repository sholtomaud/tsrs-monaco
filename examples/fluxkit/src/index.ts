import { atwood } from './atwood.ts';
import { ride } from './bicycle.ts';
import { capacitor } from './capacitor.ts';
import { GEARS, transmission } from './hub.ts';
import { projectile } from './projectile.ts';

// Each model is plain TypeScript. fluxkit compiles it to a WebGPU kernel
// (one thread per swept value) when this browser has WebGPU, and otherwise
// runs the same functions on the CPU. Open atwood.ts to start.

// ---- The Atwood machine: maximum power at 50% efficiency ----
const machine = await atwood.run();
console.info(`Running on ${machine.description}`);
const best = machine.best('power');
console.log(
  `Atwood: ${machine.rows.length} runs in ${machine.ms.toFixed(0)} ms. Most power ` +
    `${best.outputs.power.toFixed(3)} W at R = ${best.params.ratio.toFixed(2)}, efficiency ${(100 * best.outputs.efficiency).toFixed(0)}%`
);
plot(
  [
    { name: 'useful power', points: machine.series('ratio', 'power') },
    { name: 'heat', points: machine.series('ratio', 'heat') },
  ],
  { title: 'Atwood machine (Odum & Pinkerton, 1955)', xLabel: 'Load ratio R = M2 / M1', yLabel: 'Power (W)' }
);

// ---- A bicycle sprint through a three-speed hub ----
const rides = [];
for (const [name, gear] of Object.entries(GEARS)) {
  const run = await ride(gear).run();
  const peak = run.best('powerOut');
  console.log(
    `Bicycle, ${name.padEnd(6)}: hub ${(100 * transmission(gear).efficiency).toFixed(2)}% efficient, ` +
      `peak ${peak.outputs.powerOut.toFixed(0)} W at ${peak.outputs.cadence.toFixed(0)} rpm`
  );
  rides.push({ name: `${name} gear`, points: run.series('cadence', 'powerOut') });
}
plot(rides, { title: 'Power vs pedalling rate (Gardner et al., 2007)', xLabel: 'Cadence (rpm)', yLabel: 'Power (W)' });

// ---- Charging a capacitor: half the energy is always lost ----
const charge = await capacitor.run();
for (const { params, outputs } of charge.rows) {
  console.log(
    `RC: R = ${String(params.R).padStart(3)} Ω, τ = ${(1000 * outputs.timeConstant).toFixed(0).padStart(3)} ms: ` +
      `stored ${outputs.stored.toFixed(4)} J, heat ${outputs.heat.toFixed(4)} J, efficiency ${(100 * outputs.efficiency).toFixed(1)}%`
  );
}
plot(
  [
    { name: 'stored ½CV²', points: charge.series('R', 'stored') },
    { name: 'heat in R', points: charge.series('R', 'heat') },
  ],
  { title: 'Charging a capacitor through R', xLabel: 'Resistance (Ω)', yLabel: 'Energy (J)' }
);

// ---- A projectile, with and without air drag ----
const throws = [];
for (const drag of [0, 0.01]) {
  const run = await projectile(drag).run();
  const far = run.best('range');
  console.log(`Projectile, drag ${drag}: farthest ${far.outputs.range.toFixed(1)} m at ${far.params.angle}°`);
  throws.push({ name: drag ? 'with drag' : 'no drag', points: run.series('angle', 'range') });
}
plot(throws, { title: 'Range vs launch angle at 30 m/s', xLabel: 'Angle (degrees)', yLabel: 'Range (m)' });

// Try: change a rate law and Run. Print atwood.wgsl to see the kernel
// fluxkit generated for it.
