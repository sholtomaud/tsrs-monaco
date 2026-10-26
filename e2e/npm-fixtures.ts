import type { Registry } from './cdn-mock.ts';

// Fake packages standing in for jsDelivr and esm.sh, so these tests don't
// depend on the network. 'tiny-ml' ships a self-contained ES module bundle
// (loaded from jsDelivr, like onnxruntime-web); 'split-lib' has an unbundled
// entry that imports a dependency (loaded through esm.sh, like tfjs).
export const registry: Registry = {
  'tiny-ml': {
    '2.1.0': {
      'package.json': JSON.stringify({
        name: 'tiny-ml',
        version: '2.1.0',
        exports: { '.': { types: './types.d.ts', import: './dist/tiny-ml.bundle.mjs' } },
        dependencies: { 'tiny-ml-common': '^2.0.0' },
      }),
      'types.d.ts': "export * from 'tiny-ml-common';\nexport declare function dot(a: number[], b: number[]): number;",
      'dist/tiny-ml.bundle.mjs':
        'const dot=(a,b)=>a.reduce((s,x,i)=>s+x*b[i],0);class Tensor{constructor(d){this.data=d}}export{dot,Tensor};',
    },
  },
  'tiny-ml-common': {
    '2.0.0': {
      'package.json': JSON.stringify({ name: 'tiny-ml-common', exports: { import: './esm/index.js' } }),
      'esm/index.js': "export * from './tensor.js';",
      'esm/index.d.ts': "export * from './tensor.js';",
      'esm/tensor.d.ts': 'export declare class Tensor { constructor(data: number[]); readonly data: number[]; }',
    },
  },
  'split-lib': {
    '0.3.0': {
      'package.json': JSON.stringify({ name: 'split-lib', types: 'dist/index.d.ts', module: 'dist/index.js' }),
      'dist/index.d.ts': 'export declare function shout(s: string): string;',
      'dist/index.js': "export { shout } from './shout.js';",
    },
  },
};

export const esm = {
  'split-lib@0.3.0': 'export const shout = (s) => s.toUpperCase() + "!";',
};
