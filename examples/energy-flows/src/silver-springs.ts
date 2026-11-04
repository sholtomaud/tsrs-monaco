import { ecosystem } from './dialect.ts';

/**
 * Silver Springs, Florida: the annual energy budget H.T. Odum (1957)
 * measured, rounded and balanced so that every compartment's inputs equal
 * its outputs. Flows are kcal/m²/yr; the storages (kcal/m²) are
 * illustrative standing crops.
 *
 * Each pathway is calibrated as k = flow / (donor's storage), so the steady
 * state reproduces the budget exactly. `grazing` scales the producers →
 * herbivores pathway, to ask what heavier or lighter grazing would do.
 */
export const silverSprings = ({ grazing = 1 } = {}) => ecosystem`
storage producers, herbivores, carnivores, topCarnivores, decomposers
source  sun
sink    respiration, export

param grazing = ${grazing}

# Standing crops at steady state, kcal/m²
param P = 3240
param H = 150
param C = 44
param T = 6
param D = 20

sun           -> producers     = 20810

producers     -> respiration   = 11977 / P * producers
producers     -> herbivores    = grazing * 3368 / P * producers
producers     -> decomposers   = 3000 / P * producers
producers     -> export        = 2465 / P * producers

herbivores    -> respiration   = 1890 / H * herbivores
herbivores    -> carnivores    = 383 / H * herbivores
herbivores    -> decomposers   = 1095 / H * herbivores

carnivores    -> respiration   = 316 / C * carnivores
carnivores    -> topCarnivores = 21 / C * carnivores
carnivores    -> decomposers   = 46 / C * carnivores

topCarnivores -> respiration   = 13 / T * topCarnivores
topCarnivores -> decomposers   = 8 / T * topCarnivores

decomposers   -> respiration   = 4149 / D * decomposers
`;

/** The budget the model is calibrated to: [from, to, kcal/m²/yr]. */
export const BUDGET: [string, string, number][] = [
  ['producers', 'herbivores', 3368],
  ['producers', 'decomposers', 3000],
  ['herbivores', 'carnivores', 383],
  ['herbivores', 'decomposers', 1095],
  ['carnivores', 'topCarnivores', 21],
  ['carnivores', 'decomposers', 46],
  ['topCarnivores', 'decomposers', 8],
];
