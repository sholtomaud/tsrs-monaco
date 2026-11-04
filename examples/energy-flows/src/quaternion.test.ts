import { IDENTITY, qMultiply, qNormalize, qRotate, qUpdate, type Quat } from './quaternion.ts';

const i: Quat = [0, 1, 0, 0];
const j: Quat = [0, 0, 1, 0];

test('quaternion multiplication is not commutative: ij = k, ji = -k', () => {
  expect(qMultiply(i, j)).toEqual([0, 0, 0, 1]);
  expect(qMultiply(j, i)).toEqual([0, 0, 0, -1]);
  expect(qMultiply(i, i)).toEqual([-1, 0, 0, 0]);
});

test('q_update integrates a constant angular velocity', () => {
  // 2 rad/s about z for 1 s turns the x axis by 2 rad.
  let q = IDENTITY;
  for (let n = 0; n < 1000; n++) q = qNormalize(qUpdate(q, [0, 0, 2], 1e-3));
  const [x, y, z] = qRotate(q, [1, 0, 0]);
  expect(x).toBeCloseTo(Math.cos(2), 5);
  expect(y).toBeCloseTo(Math.sin(2), 5);
  expect(z).toBeCloseTo(0, 10);
  expect(Math.hypot(...q)).toBeCloseTo(1, 12);
});

test('without renormalising, the first-order update drifts off unit length', () => {
  let q = IDENTITY;
  for (let n = 0; n < 1000; n++) q = qUpdate(q, [0, 0, 2], 1e-3);
  // Each step scales |q| by sqrt(1 + (ω dt / 2)²).
  expect(Math.hypot(...q)).toBeCloseTo(Math.sqrt(1 + 1e-6) ** 1000, 9);
  expect(Math.hypot(...q)).toBeGreaterThan(1.0004);
});
