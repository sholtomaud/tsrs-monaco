import { DEFAULT_TSCONFIG, ENTRY, TSCONFIG, type ProjectFiles } from '../compiler/project.ts';
import { PLAYGROUND_DTS } from './playground-dts.ts';

export const files: ProjectFiles = {
  [TSCONFIG]: DEFAULT_TSCONFIG,
  [ENTRY]: `import { defaults, points, simulate, steadyState } from './cash.ts';

// The run in the BASIC listing: $4 a week coming in, 5% of the savings spent
// each week, starting with nothing.
const fromZero = simulate(defaults);
// The same tank starting above its steady state drains down to it.
const fromRich = simulate({ ...defaults, M0: 160 });

for (const { t, M } of fromZero.filter((s) => s.t % 40 === 0)) {
  console.log(\`week \${String(t).padStart(3)}   M = \${M.toFixed(2)}\`);
}
console.info(\`Steady state J/K = \${steadyState(defaults)}\`);

// Lines 40 and 80 of the BASIC program, PSET(T, 180 - M) inside a box.
plot(
  [
    { name: 'M (from 0)', points: points(fromZero) },
    { name: 'M (from 160)', points: points(fromRich) },
    { name: 'J/K', points: [[0, 80], [defaults.tEnd, 80]] },
  ],
  { title: 'CASH: a simple money storage', xLabel: 'Time, T (weeks)', yLabel: 'Money stored, M' }
);

// Try: double the income J, or change dt to 10 and watch Euler's method go wrong.
`,
  'src/cash.ts': `/**
 * CASH, H.T. Odum's simplest energy-systems minimodel: one storage (a tank,
 * here a bank account) with a constant inflow J and an outflow
 * proportional to what is stored, K*M.
 *
 *     J ──►  ( M )  ──►  K*M
 *
 *     dM/dt = J - K*M
 *
 * Ported from Table I-5, "Simple money storage program CASH in BASIC":
 *
 *     50 J=4         income per week
 *     55 dt=1        time step (weeks)
 *     70 K=.05       fraction of savings spent per week
 *     80 PSET(T,180-Q)
 *     90 DM=J-K*M
 *    100 M=M+DM*dt
 *    110 T=T+dt
 *    120 IF T<240 GOTO 80
 *
 * The listing sets Q=1 on line 60 and plots Q, but the state it integrates is
 * M (which BASIC starts at 0), so this port records and plots M.
 */

export interface CashParams {
  /** Inflow, dollars per week (J). */
  J: number;
  /** Outflow coefficient, fraction of M per week (K). */
  K: number;
  /** Starting storage (M at T = 0). */
  M0: number;
  /** Time step in weeks (dt). */
  dt: number;
  /** Length of the run in weeks. */
  tEnd: number;
}

export const defaults: CashParams = { J: 4, K: 0.05, M0: 0, dt: 1, tEnd: 240 };

export interface Step {
  t: number;
  M: number;
}

/** Euler integration, as in the BASIC loop. Includes both t = 0 and t = tEnd. */
export function simulate(p: CashParams = defaults): Step[] {
  if (!(p.dt > 0)) throw new RangeError('dt must be positive');
  const steps = Math.round(p.tEnd / p.dt);
  const out: Step[] = [];
  let M = p.M0;
  for (let i = 0; i <= steps; i++) {
    out.push({ t: i * p.dt, M });
    const DM = p.J - p.K * M;
    M = M + DM * p.dt;
  }
  return out;
}

/** Where inflow equals outflow: J = K*M. */
export function steadyState(p: CashParams = defaults): number {
  return p.J / p.K;
}

/** The exact solution of dM/dt = J - K*M, for checking the simulation. */
export function analytic(p: CashParams, t: number): number {
  const Mss = steadyState(p);
  return Mss + (p.M0 - Mss) * Math.exp(-p.K * t);
}

export function points(run: Step[]): [number, number][] {
  return run.map((s) => [s.t, s.M]);
}
`,
  'src/cash.test.ts': `import { analytic, defaults, simulate, steadyState } from './cash.ts';

const last = <T>(xs: T[]) => xs[xs.length - 1];

test('first week stores the whole income', () => {
  // M starts at 0, so nothing is spent yet: M = 0 + (4 - 0.05 * 0) * 1.
  expect(simulate(defaults)[1].M).toBe(4);
});

test('steady state is J/K = 80', () => {
  expect(steadyState(defaults)).toBeCloseTo(80, 10);
});

test('storage fills towards the steady state without overshooting', () => {
  const run = simulate(defaults);
  for (let i = 1; i < run.length; i++) {
    expect(run[i].M).toBeGreaterThan(run[i - 1].M);
    expect(run[i].M).toBeLessThan(80);
  }
  expect(last(run).M).toBeCloseTo(80, 2);
});

test('a storage above the steady state drains down to it', () => {
  const run = simulate({ ...defaults, M0: 160 });
  expect(run[1].M).toBeLessThan(160);
  expect(last(run).M).toBeCloseTo(80, 2);
});

test('matches the closed form of the discrete (Euler) model', () => {
  // M_n = J/K * (1 - (1 - K*dt)^n) when M starts at 0.
  const run = simulate(defaults);
  for (const n of [1, 10, 100, 240]) {
    expect(run[n].M).toBeCloseTo(80 * (1 - 0.95 ** n), 9);
  }
});

test('smaller time steps converge on the exact solution', () => {
  const error = (dt: number) => {
    const p = { ...defaults, dt, tEnd: 20 };
    return Math.abs(last(simulate(p)).M - analytic(p, 20));
  };
  expect(error(0.1)).toBeLessThan(error(1) / 5);
});

test('rejects a non-positive time step', () => {
  expect(() => simulate({ ...defaults, dt: 0 })).toThrow('dt must be positive');
});
`,
  'src/playground.d.ts': PLAYGROUND_DTS,
};
