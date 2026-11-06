// Where this browser has WebGPU: every model's generated kernel against the
// same functions run on the CPU.
import { createEngine } from 'fluxkit';
import { atwood } from './atwood.ts';
import { ride } from './bicycle.ts';
import { capacitor } from './capacitor.ts';
import { GEARS } from './hub.ts';
import { projectile } from './projectile.ts';

const gpu = await createEngine();

/** Agreement relative to the largest value: f32 and f64 differ most near zero. */
function agree(gpuValues: number[], cpuValues: number[], tolerance: number) {
  expect(gpuValues.length).toBe(cpuValues.length);
  const scale = Math.max(...cpuValues.map(Math.abs));
  gpuValues.forEach((v, i) => {
    if (Math.abs(v - cpuValues[i]) > tolerance * scale) {
      throw new Error(`run ${i}: GPU ${v}, CPU ${cpuValues[i]}`);
    }
  });
}

if (gpu.backend === 'webgpu') {
  const models = [
    ['Atwood machine', atwood, 'power'],
    ['bicycle', ride(GEARS.high), 'powerOut'],
    ['capacitor', capacitor, 'stored'],
    ['projectile', projectile(0.01), 'range'],
  ] as const;
  for (const [name, model, output] of models) {
    test(`${name}: the GPU kernel matches the CPU`, async () => {
      const [onGpu, onCpu] = await Promise.all([model.run({ engine: gpu }), model.run({ backend: 'cpu' })]);
      expect(onGpu.backend).toBe('webgpu');
      agree(onGpu.column(output), onCpu.column(output), 2e-3);
    });
  }
} else {
  console.info(`No WebGPU here (${gpu.description}): the models ran on the CPU.`);
}
