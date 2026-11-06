import * as fx from 'fluxkit';

/**
 * The Atwood machine as Odum & Pinkerton's (1955) model of maximum power:
 * a falling mass M1 lifts a load M2 = R·M1 over a pulley, against friction
 * b·v. One run per load ratio R.
 */
export const atwood = new fx.Model('Atwood machine', {
  params: {
    m1: 1, // kg
    g: 9.81,
    inertia: 0.01, // pulley, kg·m²
    radius: 0.1, // m
    friction: 10, // N·s/m
    ratio: fx.sweep(0, 1, 101), // R = M2 / M1: 101 runs
  },
  state: { v: 0, pulley: fx.rotation() },
  rates(s, p) {
    const m2 = p.ratio * p.m1;
    const inertialMass = p.m1 + m2 + p.inertia / p.radius ** 2;
    return {
      v: ((p.m1 - m2) * p.g - p.friction * s.v) / inertialMass,
      pulley: fx.spin(0, 0, s.v / p.radius), // the rope turns the pulley
    };
  },
  outputs: (s, p) => ({
    power: p.ratio * p.m1 * p.g * s.v, // lifting the load
    heat: p.friction * s.v ** 2,
    efficiency: p.ratio,
  }),
  until: fx.steady('v', 1e-7),
  dt: 0.004,
});
