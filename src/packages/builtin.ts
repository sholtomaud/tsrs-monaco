// Packages the playground provides itself, instead of fetching them from npm:
// their types are handed to tsrs as node_modules/<name>/, and the run worker
// serves their code (see runtime/run.worker.ts).

import { FLUXKIT_TYPES } from './builtin-fluxkit.ts';

export const BUILTIN_TYPES: Record<string, Record<string, string>> = {
  fluxkit: FLUXKIT_TYPES,
};

export const isBuiltin = (name: string) => Object.hasOwn(BUILTIN_TYPES, name);

/**
 * A module that re-exports a built-in from the object the run worker keeps
 * it in, so user modules can `import * as fx from 'fluxkit'`.
 */
export function builtinShim(name: string, exportNames: string[]): string {
  const valid = exportNames.filter((n) => /^[A-Za-z_$][\w$]*$/.test(n) && n !== 'default');
  return [
    `const m = globalThis.__playgroundBuiltins[${JSON.stringify(name)}];`,
    ...valid.map((n) => `export const ${n} = m.${n};`),
    'export default m;',
  ].join('\n');
}
