import * as fx from 'fluxkit';

/**
 * A ball thrown at 30 m/s, as in a game: gravity and quadratic air drag on a
 * position and a velocity vector. One run per launch angle, all at once.
 * Without drag the best angle is 45°; with drag it is lower.
 */
export const projectile = (drag: number) =>
  new fx.Model(`Projectile, drag ${drag}`, {
    params: {
      speed: 30, // m/s
      drag, // per metre: the drag acceleration is drag · |v| · v
      g: 9.81,
      angle: fx.sweep(5, 85, 81), // degrees: 81 runs
    },
    state: { position: fx.vec(0, 0, 0), velocity: fx.vec(0, 0, 0) },
    // Each run's launch velocity, from its angle (plain TypeScript).
    init: (p) => {
      const a = (p.angle * Math.PI) / 180;
      return { velocity: fx.vec(p.speed * Math.cos(a), p.speed * Math.sin(a), 0) };
    },
    rates: (s, p) => ({
      position: s.velocity,
      velocity: fx.add(fx.vec(0, -p.g, 0), fx.scale(s.velocity, -p.drag * fx.length(s.velocity))),
    }),
    outputs: (s) => ({ range: s.position[0], landing: s.position }),
    until: (s) => s.position[1] < 0, // it has landed
    dt: 0.001,
    maxSteps: 20_000,
  });
