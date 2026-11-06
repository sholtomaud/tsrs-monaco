/**
 * A planetary (epicyclic) bicycle hub: sun S, carrier C (with the planets)
 * and ring R. These are constant for a gear, so they are plain TypeScript,
 * solved once: nothing here runs on the GPU.
 *
 * Speeds come from the fundamental circuit equation (Willis; Wu & Cheng,
 * 2014), Z_S (ω_S − ω_C) + Z_R (ω_R − ω_C) = 0, with one member held (or the
 * hub locked) and one driven at unit speed. Torques balance,
 * T_S + T_C + T_R = 0, and only the power seen from the carrier ("latent"
 * power, T·(ω − ω_C)) passes through the gear teeth, so only it pays the mesh
 * losses: the member driving in the carrier's frame passes on η = η_mesh² of it.
 */

export type Member = 'sun' | 'carrier' | 'ring';
export interface Gear {
  input: Member;
  output: Member;
  /** 'none' locks the hub: direct drive. */
  fixed: Member | 'none';
}

export const GEARS = {
  low: { input: 'ring', output: 'carrier', fixed: 'sun' },
  direct: { input: 'carrier', output: 'ring', fixed: 'none' },
  high: { input: 'carrier', output: 'ring', fixed: 'sun' },
} satisfies Record<string, Gear>;

export interface Teeth {
  sun: number;
  ring: number;
  /** Efficiency of one gear mesh. */
  mesh: number;
}

export const TEETH: Teeth = { sun: 18, ring: 54, mesh: 0.98 };

const MEMBERS: Member[] = ['sun', 'carrier', 'ring'];
const unit = (m: Member) => MEMBERS.map((x) => (x === m ? 1 : 0));

/** Solves a 3×3 system given by its rows (Cramer's rule). */
function solve3(rows: number[][], b: number[]): number[] {
  const det = (m: number[][]) =>
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const d = det(rows);
  return [0, 1, 2].map((k) => det(rows.map((row, i) => row.map((v, j) => (j === k ? b[i] : v)))) / d);
}

/** Speeds (per unit input speed) and torques (per unit input torque) of each member. */
export function transmission(gear: Gear, teeth: Teeth = TEETH) {
  const willis = [teeth.sun, -(teeth.sun + teeth.ring), teeth.ring];
  const held = gear.fixed === 'none' ? [1, -1, 0] : unit(gear.fixed);
  const speeds = solve3([willis, held, unit(gear.input)], [0, 0, 1]);
  const rel = [speeds[0] - speeds[1], 0, speeds[2] - speeds[1]];
  const torquesWith = (row: number[]) => solve3([[1, 1, 1], row, unit(gear.input)], [0, 0, 1]);
  let torques: number[];
  if (gear.fixed === 'none') {
    torques = torquesWith([1, 0, 0]); // a locked hub carries no torque through the gears
  } else {
    const lossless = torquesWith(rel);
    const eta = teeth.mesh ** 2;
    const sunDrives = lossless[0] * rel[0] > 0;
    torques = torquesWith(rel.map((r, k) => r * (sunDrives ? [eta, 0, 1] : [1, 0, eta])[k]));
  }
  const out = MEMBERS.indexOf(gear.output);
  return {
    speeds: { sun: speeds[0], carrier: speeds[1], ring: speeds[2] },
    /** ω_out / ω_in */
    ratio: speeds[out],
    /** T_out / T_in */
    torqueFactor: -torques[out],
    efficiency: -torques[out] * speeds[out],
    /** A planet's spin relative to the carrier, per unit of (ω_S − ω_C). */
    planetFactor: teeth.sun / ((teeth.ring - teeth.sun) / 2),
  };
}
