import { DEFAULT_TSCONFIG, ENTRY, TSCONFIG, type ProjectFiles } from '../compiler/project.ts';
import { PLAYGROUND_DTS } from './playground-dts.ts';

export const files: ProjectFiles = {
  [TSCONFIG]: DEFAULT_TSCONFIG,
  [ENTRY]: `import * as tf from '@tensorflow/tfjs-core';
import '@tensorflow/tfjs-backend-cpu';
import '@tensorflow/tfjs-backend-webgpu';
import { fitLine } from './regression.ts';

// TensorFlow.js packages come from npm: types are fetched for tsrs, and the
// code loads through esm.sh on Run (so every package shares one tfjs-core).

// WebGPU when this browser has it, otherwise the CPU backend.
const webgpu = await tf.setBackend('webgpu').catch(() => false);
if (!webgpu) await tf.setBackend('cpu');
await tf.ready();
console.info(\`tfjs \${tf.version_core} on the \${tf.getBackend()} backend\`);

// Noisy samples of y = 2x + 1, fitted by gradient descent.
const xs = Array.from({ length: 20 }, (_, i) => i / 19);
const ys = xs.map((x, i) => 2 * x + 1 + 0.1 * Math.sin(i * 7));
const fit = await fitLine(xs, ys, { epochs: 300, learningRate: 0.5 });

console.log(\`y ≈ \${fit.slope.toFixed(3)}x + \${fit.intercept.toFixed(3)}\`);

plot(
  { name: 'mean squared error', points: fit.losses },
  { title: 'Fitting y = ax + b with SGD', xLabel: 'epoch', yLabel: 'loss' }
);
plot(
  [
    { name: 'samples', points: xs.map((x, i): [number, number] => [x, ys[i]]) },
    { name: 'fit', points: [[0, fit.intercept], [1, fit.slope + fit.intercept]] },
  ],
  { title: 'Data and fitted line', xLabel: 'x', yLabel: 'y' }
);
`,
  'src/regression.ts': `import * as tf from '@tensorflow/tfjs-core';
// tfjs-core alone doesn't register gradients (the @tensorflow/tfjs bundle does).
import '@tensorflow/tfjs-core/dist/register_all_gradients';

export interface Fit {
  slope: number;
  intercept: number;
  /** Loss after each epoch. */
  losses: number[];
}

/** Fits y = slope * x + intercept by minimising mean squared error with SGD. */
export async function fitLine(
  xs: number[],
  ys: number[],
  { epochs = 200, learningRate = 0.1 } = {}
): Promise<Fit> {
  if (xs.length !== ys.length || xs.length === 0) {
    throw new Error('xs and ys must be non-empty and the same length');
  }
  const x = tf.tensor1d(xs);
  const y = tf.tensor1d(ys);
  // tidy() disposes the initial scalars; the variables live on.
  const slope = tf.tidy(() => tf.variable(tf.scalar(0)));
  const intercept = tf.tidy(() => tf.variable(tf.scalar(0)));
  const optimizer = tf.train.sgd(learningRate);

  const losses: number[] = [];
  for (let epoch = 0; epoch < epochs; epoch++) {
    const loss = optimizer.minimize(
      () => tf.losses.meanSquaredError(y, tf.add(tf.mul(slope, x), intercept)) as tf.Scalar,
      true
    )!;
    // Asynchronous reads work on every backend, including WebGPU.
    losses.push((await loss.data())[0]);
    loss.dispose();
  }

  const result = {
    slope: (await slope.data())[0],
    intercept: (await intercept.data())[0],
    losses,
  };
  tf.dispose([x, y, slope, intercept]);
  optimizer.dispose();
  return result;
}
`,
  'src/regression.test.ts': `import * as tf from '@tensorflow/tfjs-core';
import '@tensorflow/tfjs-backend-cpu';
import { fitLine } from './regression.ts';

const xs = [0, 0.25, 0.5, 0.75, 1];
const ys = xs.map((x) => 2 * x + 1);

test('recovers the slope and intercept of an exact line', async () => {
  await tf.setBackend('cpu');
  const fit = await fitLine(xs, ys, { epochs: 500, learningRate: 0.5 });
  expect(fit.slope).toBeCloseTo(2, 2);
  expect(fit.intercept).toBeCloseTo(1, 2);
});

test('the loss goes down', async () => {
  await tf.setBackend('cpu');
  const { losses } = await fitLine(xs, ys, { epochs: 50, learningRate: 0.5 });
  expect(losses.length).toBe(50);
  expect(losses[49]).toBeLessThan(losses[0] / 100);
});

test('does not leak tensors', async () => {
  await tf.setBackend('cpu');
  const before = tf.memory().numTensors;
  await fitLine(xs, ys, { epochs: 5 });
  expect(tf.memory().numTensors).toBe(before);
});

test('rejects mismatched data', async () => {
  let message = '';
  await fitLine([1, 2], [1]).catch((e: Error) => (message = e.message));
  expect(message).toBe('xs and ys must be non-empty and the same length');
});
`,
  'src/playground.d.ts': PLAYGROUND_DTS,
};
