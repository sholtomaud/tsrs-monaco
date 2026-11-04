import { defaults, simulate, steadyState } from './atwood.ts';
import { cpuEngine } from './engine.ts';
import { qRotate } from './quaternion.ts';

const relative = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);
const run = await simulate(cpuEngine);

test('reaches the steady speed v* = (M1 - M2) g / b', () => {
  for (const p of run.points.filter((p) => p.ratio < 1)) {
    expect(p.steady).toBe(true);
    expect(relative(p.velocity, steadyState(defaults, p.ratio).velocity)).toBeLessThan(1e-4);
  }
});

test('useful power peaks at R = 0.5, where the efficiency is 50%', () => {
  const best = run.points.reduce((a, b) => (b.powerOut > a.powerOut ? b : a));
  expect(best.ratio).toBeCloseTo(0.5, 6);
  expect(best.efficiency).toBeCloseTo(0.5, 6);
  // P_max = M1² g² / 4b
  expect(relative(best.powerOut, (defaults.m1 * defaults.g) ** 2 / (4 * defaults.friction))).toBeLessThan(1e-4);
});

test('steady power in = useful power + heat', () => {
  for (const p of run.points.filter((p) => p.powerIn > 0)) {
    expect(relative(p.powerOut + p.powerLoss, p.powerIn)).toBeLessThan(1e-3);
  }
});

test('the pulley turns through distance / radius', () => {
  for (const p of run.points.filter((_, i) => i % 10 === 0)) {
    const angle = p.distance / defaults.radius;
    const [x, y] = qRotate(p.pulley, [1, 0, 0]);
    expect(Math.hypot(x - Math.cos(angle), y - Math.sin(angle))).toBeLessThan(0.01);
  }
});

test('needs friction for a steady state', async () => {
  let message = '';
  await simulate(cpuEngine, { ...defaults, friction: 0 }).catch((e: Error) => (message = e.message));
  expect(message).toBe('friction must be > 0: without dissipation there is no steady power');
});
