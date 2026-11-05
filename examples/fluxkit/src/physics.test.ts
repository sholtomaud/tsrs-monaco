// The models against their closed forms. These run on the CPU or the GPU,
// whichever this browser has.
import { atwood } from './atwood.ts';
import { ride } from './bicycle.ts';
import { capacitor } from './capacitor.ts';
import { GEARS, TEETH, transmission } from './hub.ts';
import { projectile } from './projectile.ts';

const relative = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);

// One run of each model, shared by the tests.
const once = <T>(start: () => Promise<T>) => {
  let result: Promise<T> | undefined;
  return () => (result ??= start());
};
const atwoodRun = once(() => atwood.run());
const capacitorRun = once(() => capacitor.run());
const stillRun = once(() => projectile(0).run());
const airRun = once(() => projectile(0.01).run());
const highGearRun = once(() => ride(GEARS.high).run());

test('Atwood: the steady speed is (M1 − M2) g / b', async () => {
  const run = await atwoodRun();
  for (const { params: p, state, done } of run.rows.filter((r) => r.params.ratio < 1)) {
    expect(done).toBe(true);
    expect(relative(state.v, ((1 - p.ratio) * p.m1 * p.g) / p.friction)).toBeLessThan(1e-3);
  }
});

test('Atwood: power peaks at R = 0.5, at 50% efficiency', async () => {
  const best = (await atwoodRun()).best('power');
  expect(best.params.ratio).toBeCloseTo(0.5, 5);
  expect(best.outputs.efficiency).toBeCloseTo(0.5, 5);
  const { m1, g, friction } = best.params;
  expect(relative(best.outputs.power, (m1 * g) ** 2 / (4 * friction))).toBeLessThan(1e-3);
});

test('Atwood: the pulley stays a unit quaternion', async () => {
  const run = await atwoodRun();
  for (const { state } of run.rows) expect(Math.hypot(...state.pulley)).toBeCloseTo(1, 4);
});

test('capacitor: half the energy is lost in R, whatever R is', async () => {
  const run = await capacitorRun();
  for (const { params: p, outputs: o } of run.rows) {
    expect(o.efficiency).toBeCloseTo(0.5, 3);
    expect(relative(o.stored, 0.5 * p.C * (0.9999 * p.Vs) ** 2)).toBeLessThan(1e-3);
    // The books balance: delivered = stored + heat.
    expect(relative(o.stored + o.heat, o.delivered)).toBeLessThan(1e-3);
  }
});

test('capacitor: 99.99% charged after τ ln(10⁴)', async () => {
  const run = await capacitorRun();
  for (const { t, outputs } of run.rows) {
    expect(relative(t, outputs.timeConstant * Math.log(1e4))).toBeLessThan(0.01);
  }
});

test('projectile: without drag, range = v² sin 2θ / g, farthest at 45°', async () => {
  const run = await stillRun();
  for (const { params: p, outputs } of run.rows.filter((_, i) => i % 10 === 0)) {
    const exact = (p.speed ** 2 * Math.sin((2 * p.angle * Math.PI) / 180)) / p.g;
    expect(relative(outputs.range, exact)).toBeLessThan(0.01);
  }
  expect(run.best('range').params.angle).toBe(45);
});

test('projectile: drag shortens the throw and lowers the best angle', async () => {
  const [still, air] = await Promise.all([stillRun(), airRun()]);
  expect(air.best('range').params.angle).toBeLessThan(45);
  expect(air.best('range').outputs.range).toBeLessThan(still.best('range').outputs.range);
});

test('hub: ratios 3/4, 1 and 4/3; only latent power pays the mesh losses', () => {
  const eta = TEETH.mesh ** 2;
  const { sun: zs, ring: zr } = TEETH;
  expect(transmission(GEARS.low).ratio).toBeCloseTo(0.75, 12);
  expect(transmission(GEARS.direct).ratio).toBeCloseTo(1, 12);
  expect(transmission(GEARS.high).ratio).toBeCloseTo(4 / 3, 12);
  expect(transmission(GEARS.high).efficiency).toBeCloseTo((eta * (zr + zs)) / (eta * zr + zs), 12);
  expect(transmission(GEARS.low).efficiency).toBeCloseTo((zr + eta * zs) / (zr + zs), 12);
});

test('bicycle: power peaks at T_max / 2a, and P_out = η_hub · P_in', async () => {
  const run = await highGearRun();
  const peak = run.best('powerOut');
  expect(Math.abs(peak.outputs.cadence - 129)).toBeLessThan(3);
  const efficiency = transmission(GEARS.high).efficiency;
  for (const { outputs } of run.rows.filter((r) => r.outputs.powerIn > 1)) {
    expect(relative(outputs.powerOut, efficiency * outputs.powerIn)).toBeLessThan(1e-4);
  }
});
