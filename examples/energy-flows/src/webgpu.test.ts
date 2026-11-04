// Runs each WGSL kernel on the GPU and checks it against its CPU twin.
// These tests are only registered where WebGPU is available (in Chrome or
// Edge, press Test); elsewhere the CPU reference is all there is.

import * as atwood from './atwood.ts';
import * as bicycle from './bicycle.ts';
import { solveEcosystems } from './ecosystem.ts';
import { WgslError, cpuEngine, createEngine } from './engine.ts';
import { silverSprings } from './silver-springs.ts';

const gpu = await createEngine();

// Agreement relative to the largest value: f32 on the GPU and f64 on the
// CPU differ most where a curve approaches zero.
const close = (a: ArrayLike<number>, b: ArrayLike<number>, tolerance: number) => {
  expect(a.length).toBe(b.length);
  const scale = Math.max(...Array.from(b, Math.abs));
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i] - b[i]) > tolerance * scale) {
      throw new Error(`element ${i}: GPU ${a[i]}, CPU ${b[i]}`);
    }
  }
};

if (gpu.backend === 'webgpu') {
  test('Atwood kernel: GPU matches CPU', async () => {
    const [onGpu, onCpu] = await Promise.all([atwood.simulate(gpu), atwood.simulate(cpuEngine)]);
    close(onGpu.points.map((p) => p.powerOut), onCpu.points.map((p) => p.powerOut), 1e-4);
    close(onGpu.points.map((p) => p.velocity), onCpu.points.map((p) => p.velocity), 1e-4);
  });

  test('bicycle kernel: GPU matches CPU', async () => {
    for (const gear of Object.values(bicycle.GEARS)) {
      const [onGpu, onCpu] = await Promise.all([bicycle.ride(gpu, { gear }), bicycle.ride(cpuEngine, { gear })]);
      close(onGpu.points.map((p) => p.powerOut), onCpu.points.map((p) => p.powerOut), 1e-3);
      close(onGpu.points.map((p) => p.hubEfficiency), onCpu.points.map((p) => p.hubEfficiency), 1e-5);
    }
  });

  test('ecosystem kernel: GPU matches CPU, A and all', async () => {
    const networks = [silverSprings(), silverSprings({ grazing: 2 })];
    const [onGpu, onCpu] = await Promise.all([solveEcosystems(gpu, networks), solveEcosystems(cpuEngine, networks)]);
    onGpu.results.forEach((r, k) => {
      expect(r.converged).toBe(true);
      close(r.storage, onCpu.results[k].storage, 1e-3);
      close(r.A, onCpu.results[k].A, 1e-3);
      close(r.outflow, onCpu.results[k].outflow, 1e-3);
    });
  });

  test('WGSL errors come back with line and column', async () => {
    const broken = { ...atwood.kernel, label: 'broken', wgsl: atwood.kernel.wgsl.replace('let m2 =', 'let m2 = oops +') };
    let error: unknown;
    await gpu
      .run(broken, { params: { count: 0, max_steps: 0, m1: 1, g: 1, inertia: 0, radius: 1, friction: 1, dt: 1, tol: 1 }, input: new Float32Array(1), state: new Float32Array(8), outputLength: 6, workgroups: 1 })
      .catch((e: unknown) => (error = e));
    expect(error instanceof WgslError).toBe(true);
    expect(/oops/.test((error as WgslError).messages[0].message)).toBe(true);
    expect((error as WgslError).messages[0].line).toBeGreaterThan(1);
  });
} else {
  console.info(`No WebGPU here (${gpu.description}): only the CPU reference is tested.`);
}
