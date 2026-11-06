import * as fx from 'fluxkit';

/**
 * A capacitor C charged from a battery Vs through a resistor R:
 *
 *     dV/dt = (Vs − V) / (R C)          the current I = (Vs − V) / R
 *
 * The battery delivers Q·Vs = C·Vs², the capacitor ends up holding ½C·Vs², and
 * the resistor turns the other half into heat — whatever R is. A smaller R
 * only charges it faster. The stored-energy books balance exactly, which the
 * tests check: an energy-flow model is only as good as its accounting.
 */
export const capacitor = new fx.Model('Charging a capacitor', {
  params: {
    Vs: 12, // V
    C: 0.001, // F
    R: fx.values([1, 2, 5, 10, 20, 50]), // Ω: one run each
  },
  state: { V: 0, heat: 0, delivered: 0 },
  rates(s, p) {
    const I = (p.Vs - s.V) / p.R;
    return {
      V: I / p.C,
      heat: I * I * p.R, // power lost in the resistor
      delivered: p.Vs * I, // power from the battery
    };
  },
  outputs: (s, p) => ({
    stored: 0.5 * p.C * s.V ** 2,
    heat: s.heat,
    delivered: s.delivered,
    efficiency: (0.5 * p.C * s.V ** 2) / s.delivered,
    timeConstant: p.R * p.C,
  }),
  // Charged to 99.99 %: about 9.2 time constants.
  until: (s, p) => s.V >= 0.9999 * p.Vs,
  dt: 2e-5,
  maxSteps: 1_000_000,
});
