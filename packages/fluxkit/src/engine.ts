/**
 * A tiny compute engine: WebGPU when the browser has it, otherwise a CPU
 * reference implementation of the same kernel.
 *
 * Every kernel here shares one binding layout (spec §4):
 *
 *   @binding(0) params  uniform              scalar parameters (a Params struct)
 *   @binding(1) input   storage, read        initial parameters (mass ratios,
 *                                            cadences, interaction matrices, …)
 *   @binding(2) state   storage, read_write  transient state: q(t), ω(t), x(t), …
 *                                            (initialised on the CPU, advanced on
 *                                            the GPU, so a run can be resumed)
 *   @binding(3) output  storage, read_write  results, e.g. the steady-state energy
 *                                            flow matrix A handed to Phase 2
 *
 * The CPU fallback gets the very same packed Float32Arrays and writes the same
 * output layout, so packing, unpacking and the physics are all tested even
 * where there is no GPU (Node, CI).
 */

export type Scalar = 'u32' | 'f32';
export type ParamLayout<P extends string> = readonly (readonly [P, Scalar])[];
export type Params<P extends string> = Record<P, number>;

export interface CpuJob<P extends string> {
  /** Parameter values as the GPU sees them (f32 fields rounded to f32). */
  params: Params<P>;
  input: Float32Array;
  /** A copy of the job's state: the kernel advances it in place. */
  state: Float32Array;
  /** Zero-filled, `outputLength` long. */
  output: Float32Array;
  workgroups: number;
}

export interface Kernel<P extends string> {
  label: string;
  params: ParamLayout<P>;
  /** WGSL after the Params struct and the bindings; must define `main`. */
  wgsl: string;
  /** The same computation on the CPU. */
  cpu(job: CpuJob<P>): void;
}

export interface Job<P extends string> {
  params: Params<P>;
  input: Float32Array;
  state: Float32Array;
  outputLength: number;
  /** dispatchWorkgroups(workgroups) */
  workgroups: number;
}

export interface JobResult {
  state: Float32Array;
  output: Float32Array;
  /** Wall-clock time for the dispatch, including upload and read-back. */
  ms: number;
}

export type Backend = 'webgpu' | 'cpu';

export interface Engine {
  backend: Backend;
  /** e.g. "WebGPU (google swiftshader)" or "CPU reference". */
  description: string;
  run<P extends string>(kernel: Kernel<P>, job: Job<P>): Promise<JobResult>;
}

/** The uniform struct, generated from the same layout the TypeScript packs. */
export function paramsStruct(layout: ParamLayout<string>): string {
  return `struct Params {\n${layout.map(([name, type]) => `  ${name}: ${type},`).join('\n')}\n}`;
}

export const BINDINGS_WGSL = `@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> input: array<f32>;
@group(0) @binding(2) var<storage, read_write> state: array<f32>;
@group(0) @binding(3) var<storage, read_write> output: array<f32>;`;

/** The complete WGSL module for a kernel. */
export function shaderSource(kernel: Kernel<string>): string {
  return `${paramsStruct(kernel.params)}\n\n${BINDINGS_WGSL}\n\n${kernel.wgsl}`;
}

function checkParams<P extends string>(layout: ParamLayout<P>, values: Params<P>) {
  for (const [name, type] of layout) {
    const value = values[name];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new TypeError(`Parameter ${name} must be a finite number, got ${value}`);
    }
    if (type === 'u32' && (!Number.isInteger(value) || value < 0 || value > 0xffffffff)) {
      throw new RangeError(`Parameter ${name} must be a u32, got ${value}`);
    }
  }
}

/** Packs parameters as the Params struct: 4-byte scalars, padded to 16 bytes. */
export function packParams<P extends string>(layout: ParamLayout<P>, values: Params<P>): ArrayBuffer {
  checkParams(layout, values);
  const buffer = new ArrayBuffer(Math.max(16, Math.ceil(layout.length / 4) * 16));
  const view = new DataView(buffer);
  layout.forEach(([name, type], i) => {
    if (type === 'u32') view.setUint32(i * 4, values[name], true);
    else view.setFloat32(i * 4, values[name], true);
  });
  return buffer;
}

/** What the kernel reads back out of the uniform buffer. */
export function unpackParams<P extends string>(layout: ParamLayout<P>, buffer: ArrayBuffer): Params<P> {
  const view = new DataView(buffer);
  const out = {} as Params<P>;
  layout.forEach(([name, type], i) => {
    out[name] = type === 'u32' ? view.getUint32(i * 4, true) : view.getFloat32(i * 4, true);
  });
  return out;
}

export const cpuEngine: Engine = {
  backend: 'cpu',
  description: 'CPU reference',
  async run(kernel, job) {
    const started = performance.now();
    const params = unpackParams(kernel.params, packParams(kernel.params, job.params));
    const state = job.state.slice();
    const output = new Float32Array(job.outputLength);
    kernel.cpu({ params, input: job.input, state, output, workgroups: job.workgroups });
    return { state, output, ms: performance.now() - started };
  },
};

/** A WGSL compile error, with line:column positions in the kernel's source. */
export class WgslError extends Error {
  readonly label: string;
  readonly messages: { line: number; column: number; message: string }[];
  /** The complete module, as compiled: line numbers refer to it. */
  readonly source: string;

  constructor(label: string, messages: WgslError['messages'], source: string) {
    super(
      `WGSL errors in ${label}:\n` +
        messages.map((m) => `  ${label}.wgsl:${m.line}:${m.column}: ${m.message}`).join('\n')
    );
    this.name = 'WgslError';
    this.label = label;
    this.messages = messages;
    this.source = source;
  }
}

// Flag values from the WebGPU spec. (TypeScript's lib.webworker declares the
// GPU interfaces but not the GPUBufferUsage / GPUMapMode / GPUShaderStage
// namespaces.)
const BufferUsage = { MAP_READ: 0x1, COPY_SRC: 0x4, COPY_DST: 0x8, UNIFORM: 0x40, STORAGE: 0x80 } as const;
const MAP_READ = 0x1;
const COMPUTE_STAGE = 0x4;

export function webgpuEngine(device: GPUDevice, description = 'WebGPU'): Engine {
  const S = COMPUTE_STAGE;
  const layout = device.createBindGroupLayout({
    label: 'energy-flows',
    entries: [
      { binding: 0, visibility: S, buffer: { type: 'uniform' } },
      { binding: 1, visibility: S, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: S, buffer: { type: 'storage' } },
      { binding: 3, visibility: S, buffer: { type: 'storage' } },
    ],
  });
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
  const pipelines = new Map<string, Promise<GPUComputePipeline>>();

  async function compile(kernel: Kernel<string>) {
    const code = shaderSource(kernel);
    const module = device.createShaderModule({ label: kernel.label, code });
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter((m) => m.type === 'error');
    if (errors.length) {
      throw new WgslError(
        kernel.label,
        errors.map((m) => ({ line: m.lineNum, column: m.linePos, message: m.message })),
        code
      );
    }
    device.pushErrorScope('validation');
    const pipeline = await device.createComputePipelineAsync({
      label: kernel.label,
      layout: pipelineLayout,
      compute: { module, entryPoint: 'main' },
    });
    const error = await device.popErrorScope();
    if (error) throw new Error(`${kernel.label}: ${error.message}`);
    return pipeline;
  }

  function pipelineFor(kernel: Kernel<string>) {
    // Keyed by source, so an edited kernel is recompiled.
    const key = shaderSource(kernel);
    let pipeline = pipelines.get(key);
    if (!pipeline) {
      pipeline = compile(kernel);
      pipelines.set(key, pipeline);
      pipeline.catch(() => pipelines.delete(key));
    }
    return pipeline;
  }

  // Storage bindings must be at least 4 bytes, and sizes multiples of 4.
  const bytes = (floats: number) => Math.max(4, floats * 4);

  return {
    backend: 'webgpu',
    description,
    async run(kernel, job) {
      const started = performance.now();
      const limit = device.limits.maxComputeWorkgroupsPerDimension;
      if (job.workgroups < 1 || job.workgroups > limit) {
        throw new RangeError(`${kernel.label}: ${job.workgroups} workgroups (1 to ${limit} allowed)`);
      }
      const pipeline = await pipelineFor(kernel);
      const uniform = packParams(kernel.params, job.params);

      const created: GPUBuffer[] = [];
      const buffer = (size: number, usage: number, label: string) => {
        const b = device.createBuffer({ size, usage, label: `${kernel.label}.${label}` });
        created.push(b);
        return b;
      };
      const U = BufferUsage;
      const params = buffer(uniform.byteLength, U.UNIFORM | U.COPY_DST, 'params');
      const input = buffer(bytes(job.input.length), U.STORAGE | U.COPY_DST, 'input');
      const state = buffer(bytes(job.state.length), U.STORAGE | U.COPY_DST | U.COPY_SRC, 'state');
      const output = buffer(bytes(job.outputLength), U.STORAGE | U.COPY_SRC, 'output');
      const stateRead = buffer(bytes(job.state.length), U.MAP_READ | U.COPY_DST, 'state.read');
      const outputRead = buffer(bytes(job.outputLength), U.MAP_READ | U.COPY_DST, 'output.read');

      try {
        device.queue.writeBuffer(params, 0, uniform);
        if (job.input.length) device.queue.writeBuffer(input, 0, job.input);
        if (job.state.length) device.queue.writeBuffer(state, 0, job.state);

        device.pushErrorScope('validation');
        const bindGroup = device.createBindGroup({
          layout,
          entries: [params, input, state, output].map((b, binding) => ({
            binding,
            resource: { buffer: b },
          })),
        });
        const encoder = device.createCommandEncoder({ label: kernel.label });
        const pass = encoder.beginComputePass({ label: kernel.label });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(job.workgroups);
        pass.end();
        encoder.copyBufferToBuffer(state, 0, stateRead, 0, bytes(job.state.length));
        encoder.copyBufferToBuffer(output, 0, outputRead, 0, bytes(job.outputLength));
        device.queue.submit([encoder.finish()]);
        const error = await device.popErrorScope();
        if (error) throw new Error(`${kernel.label}: ${error.message}`);

        // Map the output buffers back to the CPU.
        const read = async (staging: GPUBuffer, floats: number) => {
          await staging.mapAsync(MAP_READ);
          const data = new Float32Array(staging.getMappedRange().slice(0, floats * 4));
          staging.unmap();
          return data;
        };
        const [stateOut, out] = await Promise.all([
          read(stateRead, job.state.length),
          read(outputRead, job.outputLength),
        ]);
        return { state: stateOut, output: out, ms: performance.now() - started };
      } finally {
        for (const b of created) b.destroy();
      }
    },
  };
}

let shared: Promise<Engine> | undefined;

/**
 * The WebGPU engine when this browser (or worker) has an adapter, otherwise
 * the CPU reference. `backend: 'webgpu'` fails instead of falling back.
 */
export function createEngine(options: { backend?: Backend | 'auto' } = {}): Promise<Engine> {
  const backend = options.backend ?? 'auto';
  if (backend === 'cpu') return Promise.resolve(cpuEngine);
  if (backend === 'auto' && shared) return shared;
  const engine = (async () => {
    const gpu: GPU | undefined = typeof navigator === 'undefined' ? undefined : navigator.gpu;
    const adapter = gpu ? await gpu.requestAdapter().catch(() => null) : null;
    if (!adapter) {
      if (backend === 'webgpu') throw new Error('WebGPU is not available here');
      return cpuEngine;
    }
    const device = await adapter.requestDevice();
    const { vendor, architecture } = adapter.info;
    const name = [vendor, architecture].filter(Boolean).join(' ');
    return webgpuEngine(device, name ? `WebGPU (${name})` : 'WebGPU');
  })();
  if (backend === 'auto') shared = engine;
  return engine;
}
