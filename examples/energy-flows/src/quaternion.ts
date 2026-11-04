/**
 * Quaternions for 3D rigid-body rotation (Ramtal & Dobre, 2014, ch. 13):
 * no gimbal lock, and cheaper to integrate and renormalise than a rotation
 * matrix.
 *
 * Convention: scalar first. q = w + xi + yj + zk is stored as
 * vec4<f32>(w, x, y, z), i.e. q.x is the scalar part, so that the angular
 * velocity quaternion reads Ω = (0, ωx, ωy, ωz) exactly as in the update rule
 *
 *     q[n+1] = q[n] + ½ Δt (q[n] ⊗ Ω)
 *
 * with ω in the body frame. The update is first order, so kernels renormalise
 * after every step: q_normalize(q_update(q, ω, dt)).
 */

export const QUATERNION_WGSL = /* wgsl */ `
// ---- Quaternion library: q = vec4(w, x, y, z), scalar first ----

const Q_IDENTITY = vec4<f32>(1.0, 0.0, 0.0, 0.0);

// Hamilton product q1 ⊗ q2 (not commutative).
fn q_multiply(q1: vec4<f32>, q2: vec4<f32>) -> vec4<f32> {
  return vec4<f32>(
    q1.x * q2.x - q1.y * q2.y - q1.z * q2.z - q1.w * q2.w,
    q1.x * q2.y + q1.y * q2.x + q1.z * q2.w - q1.w * q2.z,
    q1.x * q2.z - q1.y * q2.w + q1.z * q2.x + q1.w * q2.y,
    q1.x * q2.w + q1.y * q2.z - q1.z * q2.y + q1.w * q2.x
  );
}

fn q_normalize(q: vec4<f32>) -> vec4<f32> {
  return normalize(q);
}

// One forward-Euler step of dq/dt = ½ q ⊗ (0, ω).
fn q_update(q: vec4<f32>, omega: vec3<f32>, dt: f32) -> vec4<f32> {
  let big_omega = vec4<f32>(0.0, omega);
  return q + 0.5 * dt * q_multiply(q, big_omega);
}
`;

/** [w, x, y, z] */
export type Quat = [number, number, number, number];
export type Vec3 = [number, number, number];

export const IDENTITY: Quat = [1, 0, 0, 0];

export function qMultiply([w1, x1, y1, z1]: Quat, [w2, x2, y2, z2]: Quat): Quat {
  return [
    w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2,
    w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2,
    w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2,
    w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2,
  ];
}

export function qNormalize(q: Quat): Quat {
  const length = Math.hypot(...q);
  return q.map((c) => c / length) as Quat;
}

export function qUpdate(q: Quat, [wx, wy, wz]: Vec3, dt: number): Quat {
  const dq = qMultiply(q, [0, wx, wy, wz]);
  return q.map((c, i) => c + 0.5 * dt * dq[i]) as Quat;
}

/** The rotation by `angle` radians about a unit `axis`. */
export function qFromAxisAngle([ax, ay, az]: Vec3, angle: number): Quat {
  const s = Math.sin(angle / 2);
  return [Math.cos(angle / 2), ax * s, ay * s, az * s];
}

/** Rotation angle of a unit quaternion, in [0, 2π). */
export function qAngle(q: Quat): number {
  return 2 * Math.atan2(Math.hypot(q[1], q[2], q[3]), q[0]);
}

/** Rotates a vector: q ⊗ (0, v) ⊗ q*. */
export function qRotate(q: Quat, [vx, vy, vz]: Vec3): Vec3 {
  const conjugate: Quat = [q[0], -q[1], -q[2], -q[3]];
  const [, x, y, z] = qMultiply(qMultiply(q, [0, vx, vy, vz]), conjugate);
  return [x, y, z];
}

/** Reads the quaternion stored as [w, x, y, z] at `offset`. */
export function readQuat(buffer: ArrayLike<number>, offset: number): Quat {
  return [buffer[offset], buffer[offset + 1], buffer[offset + 2], buffer[offset + 3]];
}

export function writeQuat(buffer: Float32Array, offset: number, q: Quat): void {
  buffer.set(q, offset);
}
