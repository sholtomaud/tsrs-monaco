import { GEARS, defaults, ride, transmission } from './bicycle.ts';
import { cpuEngine } from './engine.ts';

const relative = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);
const { sunTeeth: zs, ringTeeth: zr } = defaults.hub;
const eta = defaults.hub.meshEfficiency ** 2; // sun–planet and planet–ring meshes

test('the hub gears are 3/4, 1 and 4/3', () => {
  expect(transmission(GEARS.low, defaults.hub).ratio).toBeCloseTo(0.75, 12);
  expect(transmission(GEARS.direct, defaults.hub).ratio).toBeCloseTo(1, 12);
  expect(transmission(GEARS.high, defaults.hub).ratio).toBeCloseTo(4 / 3, 12);
});

test('only latent power pays the mesh losses', () => {
  // Closed forms for a planetary with the sun held (Wu & Cheng, 2014).
  expect(transmission(GEARS.high, defaults.hub).efficiency).toBeCloseTo((eta * (zr + zs)) / (eta * zr + zs), 12);
  expect(transmission(GEARS.low, defaults.hub).efficiency).toBeCloseTo((zr + eta * zs) / (zr + zs), 12);
  expect(transmission(GEARS.direct, defaults.hub).efficiency).toBeCloseTo(1, 12);
  // Both beat a single pair of meshes.
  expect(transmission(GEARS.high, defaults.hub).efficiency).toBeGreaterThan(eta);
  const lossless = { ...defaults.hub, meshEfficiency: 1 };
  for (const gear of Object.values(GEARS)) expect(transmission(gear, lossless).efficiency).toBeCloseTo(1, 12);
});

test('torques balance: sun + carrier + ring = 0', () => {
  for (const gear of Object.values(GEARS)) {
    const { torques } = transmission(gear, defaults.hub);
    expect(torques[0] + torques[1] + torques[2]).toBeCloseTo(0, 12);
  }
});

test('power peaks at T_max / 2a in every gear', async () => {
  const { maxTorque, slope } = defaults.rider;
  for (const gear of Object.values(GEARS)) {
    const result = await ride(cpuEngine, { gear });
    const reached = result.points.filter((p) => p.reached);
    expect(reached.length).toBeGreaterThan(45);
    for (const p of reached) {
      // T = T_max - a·PR, P_in = T·ω_crank, P_out = η_hub·P_in
      expect(p.crankTorque).toBeCloseTo(maxTorque - slope * p.cadence, 3);
      expect(p.powerIn).toBeCloseTo(p.crankTorque * p.cadence * (Math.PI / 30), 1);
      if (p.powerIn > 1) expect(relative(p.powerOut, p.hubEfficiency * p.powerIn)).toBeLessThan(1e-5);
    }
    const peak = result.points.reduce((a, b) => (b.powerOut > a.powerOut ? b : a));
    expect(Math.abs(peak.cadence - result.optimalCadence)).toBeLessThan(3);
  }
});

test('the gears stay unit quaternions as they spin', async () => {
  const { points } = await ride(cpuEngine, { cadences: [120] });
  expect(points[0].reached).toBe(true);
  for (const q of points[0].orientations) expect(Math.hypot(...q)).toBeCloseTo(1, 5);
});

test('rejects impossible gears and hubs', async () => {
  const errorOf = (p: Promise<unknown>) => p.then(() => 'no error', (e: Error) => e.message);
  expect(await errorOf(ride(cpuEngine, { gear: { input: 'sun', output: 'sun', fixed: 'ring' } }))).toBe(
    'The input and output must be different members'
  );
  expect(await errorOf(ride(cpuEngine, { hub: { ...defaults.hub, ringTeeth: 55 } }))).toBe(
    'ringTeeth − sunTeeth must be positive and even (it is twice the planet teeth)'
  );
});
