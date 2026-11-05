import * as fx from 'fluxkit';
import { transmission, type Gear } from './hub.ts';

/**
 * A sprint on an isokinetic ergometer, through a planetary hub. The rider's
 * maximal torque falls linearly with pedalling rate (Gardner et al., 2007),
 * T = T_max − a·PR, so crank power peaks at PR = T_max / 2a. The rider spins
 * a flywheel up to each target cadence, which is then held. One run per
 * cadence; the hub's four members turn as rotations.
 */
export function ride(gear: Gear) {
  const hub = transmission(gear);
  return new fx.Model('Bicycle sprint', {
    params: {
      maxTorque: 266, // N·m
      slope: 266 / 258, // N·m per rpm
      chainRatio: 44 / 16,
      inertia: 2, // flywheel at the hub, kg·m²
      ratio: hub.ratio,
      torqueFactor: hub.torqueFactor,
      planetFactor: hub.planetFactor,
      sunSpeed: hub.speeds.sun,
      carrierSpeed: hub.speeds.carrier,
      ringSpeed: hub.speeds.ring,
      cadence: fx.sweep(0, 258, 51), // target rpm: 51 runs
    },
    state: {
      omega: 0, // hub output speed, rad/s
      sun: fx.rotation(),
      carrier: fx.rotation(),
      ring: fx.rotation(),
      planet: fx.rotation(),
    },
    rates(s, p) {
      const rpm = Math.PI / 30; // rad/s per rpm
      const gearing = p.chainRatio * p.ratio; // ω_out / ω_crank
      const target = p.cadence * rpm * gearing;
      const torque = Math.max(p.maxTorque - (p.slope * s.omega) / (gearing * rpm), 0);
      const outputTorque = (torque / p.chainRatio) * p.torqueFactor;
      const hubInput = s.omega / p.ratio;
      const sun = p.sunSpeed * hubInput;
      const carrier = p.carrierSpeed * hubInput;
      return {
        omega: s.omega < target ? outputTorque / p.inertia : 0,
        sun: fx.spin(sun, 0, 0),
        carrier: fx.spin(carrier, 0, 0),
        ring: fx.spin(p.ringSpeed * hubInput, 0, 0),
        planet: fx.spin(carrier - p.planetFactor * (sun - carrier), 0, 0),
      };
    },
    outputs(s, p) {
      const rpm = Math.PI / 30;
      const gearing = p.chainRatio * p.ratio;
      const omega = Math.min(s.omega, p.cadence * rpm * gearing);
      const cadence = omega / (gearing * rpm);
      const torque = Math.max(p.maxTorque - p.slope * cadence, 0);
      return {
        cadence,
        powerIn: torque * cadence * rpm,
        powerOut: (torque / p.chainRatio) * p.torqueFactor * omega,
      };
    },
    until: (s, p) => s.omega >= p.cadence * (Math.PI / 30) * p.chainRatio * p.ratio,
    dt: 0.001,
    method: 'euler',
    maxSteps: 30_000,
  });
}
