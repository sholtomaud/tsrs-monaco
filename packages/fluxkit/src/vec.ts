/**
 * Vectors and rotations for model functions. Each helper is ordinary
 * JavaScript, which is what runs on the CPU, and has a WGSL twin the compiler
 * emits for the GPU. Vectors are `[x, y, z]` arrays; a rotation is a unit
 * quaternion `[w, x, y, z]` (scalar first, Ramtal & Dobre, 2014).
 *
 * JavaScript has no operator overloading, so `a + b` on two vectors is not a
 * vector sum: use `add(a, b)`, `sub`, `scale` and friends. The compiler says
 * so if you try.
 */

export type Vec3 = readonly [number, number, number];
export type Quat = readonly [number, number, number, number];

/** A vector. */
export const vec = (x: number, y: number, z: number): Vec3 => [x, y, z];
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
/** a · k */
export const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const length = (a: Vec3): number => Math.sqrt(dot(a, a));
export const normalize = (a: Vec3): Vec3 => scale(a, 1 / length(a));

/** Hamilton product of two quaternions. */
export const qmul = (a: Quat, b: Quat): Quat => [
  a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
  a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
  a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
  a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
];

/** Rotates a vector by a rotation: q ⊗ (0, v) ⊗ q*. */
export const rotate = (q: Quat, v: Vec3): Vec3 => {
  const r = qmul(qmul(q, [0, v[0], v[1], v[2]]), [q[0], -q[1], -q[2], -q[3]]);
  return [r[1], r[2], r[3]];
};

/**
 * The rate of a rotation: its angular velocity (rad per unit time, in the
 * body's frame). Return it for a `rotation()` state in `rates`.
 */
export function spin(x: number, y: number, z: number): Vec3;
export function spin(omega: Vec3): Vec3;
export function spin(x: number | Vec3, y?: number, z?: number): Vec3 {
  return typeof x === 'number' ? [x, y!, z!] : x;
}

/** The angle of a rotation, radians in [0, 2π). */
export const angle = (q: Quat): number => 2 * Math.atan2(Math.hypot(q[1], q[2], q[3]), q[0]);

/** dq/dt = ½ q ⊗ (0, ω): how a rotation's quaternion changes. */
export const quatRate = (q: Quat, w: Vec3): Quat => {
  const d = qmul(q, [0, w[0], w[1], w[2]]);
  return [d[0] / 2, d[1] / 2, d[2] / 2, d[3] / 2];
};

/** The rotation by `radians` about `axis` (normalised for you). */
export function axisAngle(axis: Vec3, radians: number): Quat {
  const [x, y, z] = normalize(axis);
  const s = Math.sin(radians / 2);
  return [Math.cos(radians / 2), x * s, y * s, z * s];
}

/** WGSL for the helpers, emitted once into every kernel. */
export const HELPERS_WGSL = /* wgsl */ `
fn fk_qmul(a: vec4<f32>, b: vec4<f32>) -> vec4<f32> {
  return vec4<f32>(
    a.x * b.x - a.y * b.y - a.z * b.z - a.w * b.w,
    a.x * b.y + a.y * b.x + a.z * b.w - a.w * b.z,
    a.x * b.z - a.y * b.w + a.z * b.x + a.w * b.y,
    a.x * b.w + a.y * b.z - a.z * b.y + a.w * b.x
  );
}
fn fk_rotate(q: vec4<f32>, v: vec3<f32>) -> vec3<f32> {
  return fk_qmul(fk_qmul(q, vec4<f32>(0.0, v)), vec4<f32>(q.x, -q.yzw)).yzw;
}
fn fk_quat_rate(q: vec4<f32>, w: vec3<f32>) -> vec4<f32> {
  return 0.5 * fk_qmul(q, vec4<f32>(0.0, w));
}
fn fk_angle(q: vec4<f32>) -> f32 {
  return 2.0 * atan2(length(q.yzw), q.x);
}
fn fk_round(x: f32) -> f32 {
  return floor(x + 0.5); // Math.round: halves round up (WGSL's round goes to even)
}
fn fk_cbrt(x: f32) -> f32 {
  return sign(x) * pow(abs(x), 1.0 / 3.0);
}
`;
