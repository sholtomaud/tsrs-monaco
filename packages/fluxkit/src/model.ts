/**
 * A model: parameters (some swept), a state, and the rates it changes at,
 * written as plain TypeScript. fluxkit integrates one copy of the state per
 * combination of swept values, as one GPU thread each, or on the CPU.
 */

import { compileFunction, wgslType, type Field, type Type } from './compile.ts';
import { createEngine, type Backend, type Engine, type Kernel } from './engine.ts';
import { parseFunction, CompileError } from './parse.ts';
import { HELPERS_WGSL, quatRate, type Quat, type Vec3 } from './vec.ts';

// ---- Declaring parameters and state -------------------------------------------

/** A parameter that takes several values: one run (GPU thread) per value. */
export class Sweep {
  readonly values: readonly number[];
  constructor(values: readonly number[]) {
    if (!values.length) throw new RangeError('A sweep needs at least one value');
    if (values.some((v) => !Number.isFinite(v))) throw new RangeError('Sweep values must be finite numbers');
    this.values = values;
  }
}

/** `count` evenly spaced values from `from` to `to`, both included. */
export function sweep(from: number, to: number, count: number): Sweep {
  if (!(Number.isInteger(count) && count >= 1)) throw new RangeError('count must be a whole number ≥ 1');
  return new Sweep(Array.from({ length: count }, (_, i) => (count === 1 ? from : from + ((to - from) * i) / (count - 1))));
}

/** A parameter that takes each of these values. */
export const values = (list: readonly number[]) => new Sweep([...list]);

/** A rotation state: a unit quaternion, integrated from the angular velocity its rate gives. */
export class Rotation {
  readonly initial: Quat;
  constructor(initial: Quat = [1, 0, 0, 0]) {
    const n = Math.hypot(...initial);
    if (!(n > 0)) throw new RangeError('A rotation needs a non-zero quaternion');
    this.initial = initial.map((c) => c / n) as unknown as Quat;
  }
}

/** A rotation state, starting at `initial` (no rotation by default). */
export const rotation = (initial?: Quat) => new Rotation(initial);

/** Stop when the named fields (all but rotations, by default) change by less than `tol` relative per step. */
export class Steady {
  readonly fields: readonly string[] | null;
  readonly tol: number;
  constructor(fields: readonly string[] | null, tol: number) {
    if (!(tol > 0)) throw new RangeError('tol must be positive');
    this.fields = fields;
    this.tol = tol;
  }
}

/**
 * Stop at steady state: when every component of the named state fields
 * changes by at most `tol` × its size in a step (or not at all, which is as
 * close as f32 can get). With no fields, every scalar and vector field.
 */
export function steady(fields?: string | readonly string[], tol = 1e-6): Steady {
  return new Steady(fields === undefined ? null : typeof fields === 'string' ? [fields] : fields, tol);
}

export type ParamDefs = Record<string, number | Sweep>;
export type StateDefs = Record<string, number | Vec3 | Rotation>;

/** What a model function sees: every parameter as a number. */
export type ParamValues<P extends ParamDefs> = { readonly [K in keyof P]: number };
/** What a model function sees: numbers, vectors, and rotations as quaternions. */
export type StateValues<S extends StateDefs> = {
  readonly [K in keyof S]: S[K] extends Rotation ? Quat : S[K] extends number ? number : Vec3;
};
/** What `rates` returns: dx/dt for each field it changes; a rotation's angular velocity. */
export type Rates<S extends StateDefs> = {
  [K in keyof S]?: S[K] extends number ? number : Vec3;
};
export type Outputs = Record<string, number | Vec3>;

export interface ModelDefinition<P extends ParamDefs, S extends StateDefs, O extends Outputs> {
  /** Constants, and sweeps (one run per value; several sweeps run every combination). */
  params?: P;
  /** The state and its starting values. */
  state: S;
  /**
   * Starting values that depend on the parameters, e.g. a launch velocity
   * from a swept angle. Plain TypeScript, run on the CPU once per run (it is
   * not compiled to WGSL, so anything goes). Fields it leaves out start at
   * their `state` values.
   */
  init?: (p: ParamValues<P>) => Partial<StateValues<S>>;
  /** How fast each field changes: dx/dt. Fields it leaves out stay constant. */
  rates: (s: StateValues<S>, p: ParamValues<P>, t: number) => Rates<S>;
  /** Values to report from the final state of each run. */
  outputs?: (s: StateValues<S>, p: ParamValues<P>, t: number) => O;
  /** When to stop: `steady(…)`, or a condition on the state. Otherwise at tEnd. */
  until?: Steady | ((s: StateValues<S>, p: ParamValues<P>, t: number) => boolean);
  /** Time step. */
  dt: number;
  tStart?: number;
  /** Stop at this time (if `until` hasn't stopped the run first). */
  tEnd?: number;
  /** A cap on steps per run. Defaults to (tEnd − tStart) / dt, or 1,000,000. */
  maxSteps?: number;
  /** Forward Euler, or classical fourth-order Runge–Kutta (the default). */
  method?: 'euler' | 'rk4';
}

export interface Row<P extends ParamDefs, S extends StateDefs, O extends Outputs> {
  params: ParamValues<P>;
  /** The final state. */
  state: StateValues<S>;
  outputs: O;
  t: number;
  steps: number;
  /** `until` was met (or tEnd reached, when there is no `until`). */
  done: boolean;
}

export interface RunOptions {
  /** 'auto' (WebGPU when available), 'webgpu' or 'cpu'. */
  backend?: Backend | 'auto';
  /** Use this engine instead of creating one. */
  engine?: Engine;
}

export class Run<P extends ParamDefs, S extends StateDefs, O extends Outputs> {
  readonly rows: Row<P, S, O>[];
  readonly backend: Backend;
  /** e.g. "WebGPU (google swiftshader)". */
  readonly description: string;
  readonly ms: number;

  constructor(rows: Row<P, S, O>[], engine: Engine, ms: number) {
    this.rows = rows;
    this.backend = engine.backend;
    this.description = engine.description;
    this.ms = ms;
  }

  /**
   * One number per run, from a parameter, an output or a state field (in that
   * order). For a vector, pick a component.
   */
  column(name: string, component?: number): number[] {
    return this.rows.map((row) => {
      for (const source of [row.params, row.outputs, row.state] as Record<string, unknown>[]) {
        if (!(name in source)) continue;
        const v = source[name];
        if (typeof v === 'number') return v;
        if (Array.isArray(v)) {
          if (component === undefined) throw new TypeError(`'${name}' is a vector: pass a component`);
          return v[component] as number;
        }
      }
      throw new TypeError(`No parameter, output or state field named '${name}'`);
    });
  }

  /** [x, y] points across the runs, ready for plot(). */
  series(x: string, y: string): [number, number][] {
    const xs = this.column(x);
    const ys = this.column(y);
    return xs.map((v, i) => [v, ys[i]]);
  }

  /** The run where `name` is largest. */
  best(name: string): Row<P, S, O> {
    const ys = this.column(name);
    let at = 0;
    ys.forEach((v, i) => {
      if (v > ys[at]) at = i;
    });
    return this.rows[at];
  }
}

// ---- Layout --------------------------------------------------------------------

const SIZE: Record<Type, number> = { f32: 1, bool: 1, vec3: 3, quat: 4 };

interface Layout {
  params: string[];
  state: (Field & { offset: number })[];
  stateFloats: number;
  /** State floats plus t, steps and done. */
  stride: number;
  outputs: (Field & { offset: number })[];
  outputFloats: number;
}

function stateType(value: unknown, name: string): Type {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new RangeError(`state.${name} must be finite`);
    return 'f32';
  }
  if (value instanceof Rotation) return 'quat';
  if (Array.isArray(value) && value.length === 3 && value.every((v) => typeof v === 'number' && Number.isFinite(v))) {
    return 'vec3';
  }
  throw new TypeError(`state.${name} must be a number, a vector vec(x, y, z), or rotation()`);
}

// ---- The model --------------------------------------------------------------------

const KERNEL_PARAMS = [
  ['count', 'u32'],
  ['max_steps', 'u32'],
  ['dt', 'f32'],
  ['tol', 'f32'],
  ['t_start', 'f32'],
] as const;
type KernelParam = (typeof KERNEL_PARAMS)[number][0];

export class Model<P extends ParamDefs, S extends StateDefs, O extends Outputs = Record<string, never>> {
  readonly name: string;
  readonly definition: ModelDefinition<P, S, O>;
  private compiled: { kernel: Kernel<KernelParam>; layout: Layout } | null = null;

  constructor(name: string, definition: ModelDefinition<P, S, O>) {
    this.name = name;
    this.definition = definition;
    const d = definition;
    if (!(d.dt > 0)) throw new RangeError('dt must be positive');
    if (d.tEnd !== undefined && !(d.tEnd > (d.tStart ?? 0))) throw new RangeError('tEnd must be after tStart');
    if (!d.state || !Object.keys(d.state).length) throw new RangeError('The state needs at least one field');
    if (d.until === undefined && d.tEnd === undefined && d.maxSteps === undefined) {
      throw new RangeError('Say when to stop: until (e.g. steady()), tEnd or maxSteps');
    }
  }

  /** The runs: every combination of the swept parameters, in order (the first sweep varies slowest). */
  get runs(): ParamValues<P>[] {
    const entries = Object.entries(this.definition.params ?? {});
    let combos: Record<string, number>[] = [{}];
    for (const [name, value] of entries) {
      const list = value instanceof Sweep ? value.values : [value];
      if (!(value instanceof Sweep) && (typeof value !== 'number' || !Number.isFinite(value))) {
        throw new TypeError(`params.${name} must be a finite number or a sweep`);
      }
      combos = combos.flatMap((c) => list.map((v) => ({ ...c, [name]: v })));
    }
    return combos as ParamValues<P>[];
  }

  /** The WGSL fluxkit generates for this model (compiling it if needed). */
  get wgsl(): string {
    return this.compile().kernel.wgsl;
  }

  /** Compiles the model functions, or throws a CompileError naming the line. */
  compile() {
    if (this.compiled) return this.compiled;
    const d = this.definition;
    const params = Object.keys(d.params ?? {});
    let offset = 0;
    const state = Object.entries(d.state).map(([name, value]) => {
      const type = stateType(value, name);
      const field = { name, type, offset };
      offset += SIZE[type];
      return field;
    });
    const stateFloats = offset;

    const scope = (args: { state: string; params: string; time: string }) => ({ state, params, args });

    // rates(): one entry per state field it changes.
    const rates = compileFunction(parseFunction(d.rates, 'rates()'), 'rates()', scope({ state: 'fk_s', params: 'fk_p', time: 'fk_t' }));
    if (!('entries' in rates.result)) {
      throw new CompileError('rates()', d.rates.toString(), 0, 'rates must return an object: { field: dx/dt, … }');
    }
    const rateOf = new Map<string, string>();
    for (const { key, value, at } of rates.result.entries) {
      const field = state.find((f) => f.name === key);
      if (!field) {
        throw new CompileError('rates()', d.rates.toString(), at, `'${key}' is not in the state (${state.map((f) => f.name).join(', ')})`);
      }
      const want = field.type === 'quat' ? 'vec3' : field.type;
      if (value.type !== want) {
        throw new CompileError(
          'rates()',
          d.rates.toString(),
          at,
          field.type === 'quat'
            ? `the rate of rotation '${key}' is its angular velocity: spin(x, y, z)`
            : `the rate of '${key}' must be a ${want === 'f32' ? 'number' : 'vector'}, like the field`
        );
      }
      rateOf.set(key, field.type === 'quat' ? `fk_quat_rate(fk_s.s_${key}, ${value.code})` : value.code);
    }

    // outputs(): scalars and vectors, reported per run.
    let outputs: Layout['outputs'] = [];
    let outputsBody: string[] = [];
    let outputsCode: string[] = [];
    if (d.outputs) {
      const compiled = compileFunction(parseFunction(d.outputs, 'outputs()'), 'outputs()', scope({ state: 'fk_s', params: 'fk_p', time: 'fk_t' }));
      if (!('entries' in compiled.result)) {
        throw new CompileError('outputs()', d.outputs.toString(), 0, 'outputs must return an object: { name: value, … }');
      }
      let o = 0;
      outputs = compiled.result.entries.map(({ key, value, at }) => {
        if (value.type !== 'f32' && value.type !== 'vec3') {
          throw new CompileError('outputs()', d.outputs!.toString(), at, `output '${key}' must be a number or a vector`);
        }
        const field = { name: key, type: value.type, offset: o };
        o += SIZE[value.type];
        return field;
      });
      outputsBody = compiled.body;
      outputsCode = compiled.result.entries.map(({ value }) => value.code);
    }
    const outputFloats = outputs.reduce((n, f) => n + SIZE[f.type], 0);

    // until: a condition, or steady state.
    let done: string;
    let doneBody: string[] = [];
    if (typeof d.until === 'function') {
      const compiled = compileFunction(parseFunction(d.until, 'until()'), 'until()', scope({ state: 'fk_next', params: 'fk_p', time: 'fk_t' }));
      if (!('value' in compiled.result) || compiled.result.value.type !== 'bool') {
        throw new CompileError('until()', d.until.toString(), 0, 'until must return a boolean, e.g. s.x > 10');
      }
      doneBody = compiled.body;
      done = compiled.result.value.code;
    } else if (d.until instanceof Steady) {
      const names = d.until.fields ?? state.filter((f) => f.type !== 'quat').map((f) => f.name);
      const checks = names.map((name) => {
        const field = state.find((f) => f.name === name);
        if (!field) throw new RangeError(`steady(): there is no state field '${name}'`);
        if (field.type === 'quat') throw new RangeError(`steady(): '${name}' is a rotation, which keeps turning`);
        const a = `fk_next.s_${name}`;
        const b = `fk_prev.s_${name}`;
        return field.type === 'f32' ? `abs(${a} - ${b}) <= params.tol * abs(${a})` : `all(abs(${a} - ${b}) <= params.tol * abs(${a}))`;
      });
      done = checks.length ? checks.map((c) => `(${c})`).join(' && ') : 'false';
    } else {
      done = 'false';
    }

    const S = state;
    const ctor = (fn: (f: (typeof S)[number]) => string) => `FkState(${S.map(fn).join(', ')})`;
    const zero = (t: Type) => (t === 'f32' ? '0.0' : t === 'vec3' ? 'vec3<f32>(0.0)' : 'vec4<f32>(0.0)');
    const load = (f: (typeof S)[number], base: string) => {
      const at = (k: number) => `state[${base} + ${f.offset + k}u]`;
      if (f.type === 'f32') return at(0);
      if (f.type === 'vec3') return `vec3<f32>(${at(0)}, ${at(1)}, ${at(2)})`;
      return `vec4<f32>(${at(0)}, ${at(1)}, ${at(2)}, ${at(3)})`;
    };
    const storeState = S.flatMap((f) =>
      Array.from({ length: SIZE[f.type] }, (_, k) => `  state[b + ${f.offset + k}u] = s.s_${f.name}${SIZE[f.type] > 1 ? `.${'xyzw'[k]}` : ''};`)
    );
    const storeOutputs = outputs.flatMap((f, i) =>
      f.type === 'f32'
        ? [`  output[b + ${f.offset}u] = ${outputsCode[i]};`]
        : [`  let o_${i} = ${outputsCode[i]};`, ...[0, 1, 2].map((k) => `  output[b + ${f.offset + k}u] = o_${i}.${'xyz'[k]};`)]
    );
    const method = d.method ?? 'rk4';
    const stride = stateFloats + 3;
    const np = Math.max(params.length, 1);

    const wgsl = `${HELPERS_WGSL}
// ---- ${this.name}: generated by fluxkit ----

struct FkParams {
${params.length ? params.map((p) => `  p_${p}: f32,`).join('\n') : '  fk_unused: f32,'}
}

struct FkState {
${S.map((f) => `  s_${f.name}: ${wgslType(f.type)},`).join('\n')}
}

const NP: u32 = ${np}u;
const STRIDE: u32 = ${stride}u;
const OUT: u32 = ${Math.max(outputFloats, 1)}u;

fn fk_load_params(i: u32) -> FkParams {
  let b = i * NP;
  return FkParams(${params.length ? params.map((_, k) => `input[b + ${k}u]`).join(', ') : 'input[b]'});
}

fn fk_load_state(i: u32) -> FkState {
  let b = i * STRIDE;
  return ${ctor((f) => load(f, 'b'))};
}

fn fk_store_state(i: u32, s: FkState) {
  let b = i * STRIDE;
${storeState.join('\n')}
}

// rates(): dx/dt
fn fk_rates(fk_s: FkState, fk_p: FkParams, fk_t: f32) -> FkState {
${rates.body.join('\n')}
  return ${ctor((f) => rateOf.get(f.name) ?? zero(f.type))};
}

fn fk_axpy(a: FkState, k: FkState, h: f32) -> FkState {
  return ${ctor((f) => `a.s_${f.name} + h * k.s_${f.name}`)};
}

fn fk_renormalize(a: FkState) -> FkState {
  return ${ctor((f) => (f.type === 'quat' ? `normalize(a.s_${f.name})` : `a.s_${f.name}`))};
}

fn fk_scale(a: FkState, h: f32) -> FkState {
  return ${ctor((f) => `h * a.s_${f.name}`)};
}

// The change over one step, formed in full before it is added to the state:
// added term by term, increments smaller than the state's f32 precision
// would each round away.
fn fk_delta(s: FkState, p: FkParams, t: f32, dt: f32) -> FkState {
${
  method === 'euler'
    ? '  return fk_scale(fk_rates(s, p, t), dt);'
    : `  let k1 = fk_rates(s, p, t);
  let k2 = fk_rates(fk_axpy(s, k1, 0.5 * dt), p, t + 0.5 * dt);
  let k3 = fk_rates(fk_axpy(s, k2, 0.5 * dt), p, t + 0.5 * dt);
  let k4 = fk_rates(fk_axpy(s, k3, dt), p, t + dt);
  return fk_scale(fk_axpy(fk_axpy(fk_axpy(k1, k2, 2.0), k3, 2.0), k4, 1.0), dt / 6.0);`
}
}

// Kahan summation: c carries what f32 dropped from earlier steps, so a long
// run of small increments still adds up (h = ±1 multiplies exactly).
struct FkSum {
  s: FkState,
  c: FkState,
}

fn fk_kahan(s: FkState, c: FkState, d: FkState) -> FkSum {
  let y = fk_axpy(d, c, -1.0);
  let n = fk_axpy(s, y, 1.0);
  return FkSum(n, fk_axpy(fk_axpy(n, s, -1.0), y, -1.0));
}

// until: whether the run is done after a step.
fn fk_done(fk_prev: FkState, fk_next: FkState, fk_p: FkParams, fk_t: f32) -> bool {
${doneBody.join('\n')}
  return ${done};
}

// outputs()
fn fk_outputs(i: u32, fk_s: FkState, fk_p: FkParams, fk_t: f32) {
  let b = i * OUT;
${outputsBody.join('\n')}
${storeOutputs.join('\n')}
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= params.count) {
    return;
  }
  let p = fk_load_params(i);
  var s = fk_load_state(i);
  let b = i * STRIDE;
  let t0 = state[b + ${stateFloats}u];
  var t = t0;
  var steps = u32(state[b + ${stateFloats + 1}u]);
  var done = false;
  var c = ${ctor((f) => zero(f.type))};
  for (var k = 0u; k < params.max_steps; k++) {
    let sum = fk_kahan(s, c, fk_delta(s, p, t, params.dt));
    let next = fk_renormalize(sum.s);
    c = sum.c;
    t = t0 + f32(k + 1u) * params.dt; // not t += dt, which drifts in f32
    steps = steps + 1u;
    done = fk_done(s, next, p, t);
    s = next;
    if (done) {
      break;
    }
  }
  fk_store_state(i, s);
  state[b + ${stateFloats}u] = t;
  state[b + ${stateFloats + 1}u] = f32(steps);
  state[b + ${stateFloats + 2}u] = select(0.0, 1.0, done);
  fk_outputs(i, s, p, t);
}
`;

    const layout: Layout = { params, state, stateFloats, stride, outputs, outputFloats };
    const kernel: Kernel<KernelParam> = {
      label: this.name.replace(/[^\w-]+/g, '-').toLowerCase() || 'model',
      params: KERNEL_PARAMS,
      wgsl,
      cpu: (job) => this.cpu(job, layout),
    };
    this.compiled = { kernel, layout };
    return this.compiled;
  }

  /** Runs every combination of the swept parameters. */
  async run(options: RunOptions = {}): Promise<Run<P, S, O>> {
    const { kernel, layout } = this.compile();
    const d = this.definition;
    const engine = options.engine ?? (await createEngine({ backend: options.backend ?? 'auto' }));
    const runs = this.runs;
    const count = runs.length;
    const np = Math.max(layout.params.length, 1);

    const input = new Float32Array(count * np);
    runs.forEach((values, i) => layout.params.forEach((name, k) => (input[i * np + k] = values[name])));
    const state = new Float32Array(count * layout.stride);
    const tStart = d.tStart ?? 0;
    for (let i = 0; i < count; i++) {
      const start = (d.init?.(runs[i]) ?? {}) as Record<string, unknown>;
      for (const name of Object.keys(start)) {
        if (!layout.state.some((f) => f.name === name)) throw new TypeError(`init() returned '${name}', which is not in the state`);
      }
      for (const f of layout.state) {
        const v = start[f.name] ?? d.state[f.name];
        const flat =
          f.type === 'f32' ? [v as number] : v instanceof Rotation ? v.initial : (v as readonly number[]);
        if (flat.length !== SIZE[f.type] || flat.some((x) => typeof x !== 'number' || !Number.isFinite(x))) {
          throw new TypeError(`init(): '${f.name}' must be a finite ${f.type === 'f32' ? 'number' : f.type === 'vec3' ? 'vector' : 'quaternion'}`);
        }
        state.set(f.type === 'quat' ? new Rotation(flat as unknown as Quat).initial : flat, i * layout.stride + f.offset);
      }
      state[i * layout.stride + layout.stateFloats] = tStart;
    }
    const maxSteps =
      d.maxSteps ?? (d.tEnd !== undefined ? Math.round((d.tEnd - tStart) / d.dt) : 1_000_000);

    const result = await engine.run(kernel, {
      params: {
        count,
        max_steps: maxSteps,
        dt: d.dt,
        tol: d.until instanceof Steady ? d.until.tol : 0,
        t_start: tStart,
      },
      input,
      state,
      outputLength: count * Math.max(layout.outputFloats, 1),
      workgroups: Math.ceil(count / 64),
    });

    const read = (flat: ArrayLike<number>, base: number, f: { type: Type; offset: number }) =>
      f.type === 'f32' ? flat[base + f.offset] : Array.from({ length: SIZE[f.type] }, (_, k) => flat[base + f.offset + k]);
    const rows = runs.map((values, i): Row<P, S, O> => {
      const sb = i * layout.stride;
      const ob = i * Math.max(layout.outputFloats, 1);
      const steps = result.state[sb + layout.stateFloats + 1];
      return {
        params: values,
        state: Object.fromEntries(layout.state.map((f) => [f.name, read(result.state, sb, f)])) as StateValues<S>,
        outputs: Object.fromEntries(layout.outputs.map((f) => [f.name, read(result.output, ob, f)])) as O,
        t: result.state[sb + layout.stateFloats],
        steps,
        done: result.state[sb + layout.stateFloats + 2] === 1 || (d.until === undefined && steps >= maxSteps),
      };
    });
    return new Run(rows, engine, result.ms);
  }

  /** The CPU twin of the kernel: the same buffers, the model's own functions. */
  private cpu(
    job: { params: Record<KernelParam, number>; input: Float32Array; state: Float32Array; output: Float32Array },
    layout: Layout
  ) {
    const d = this.definition;
    const { count, max_steps: maxSteps, dt, tol } = job.params;
    const np = Math.max(layout.params.length, 1);
    const n = layout.stateFloats;
    const fields = layout.state;
    const toObject = (x: Float64Array) => {
      const o: Record<string, unknown> = {};
      for (const f of fields) {
        const j = f.offset;
        o[f.name] = f.type === 'f32' ? x[j] : f.type === 'vec3' ? [x[j], x[j + 1], x[j + 2]] : [x[j], x[j + 1], x[j + 2], x[j + 3]];
      }
      return o as StateValues<S>;
    };

    const rates = (x: Float64Array, p: ParamValues<P>, t: number) => {
      const r = d.rates(toObject(x), p, t) as Record<string, unknown>;
      const k = new Float64Array(n);
      for (const f of layout.state) {
        const v = r[f.name];
        if (v === undefined) continue;
        if (f.type === 'f32') {
          if (typeof v !== 'number') throw new TypeError(`rates() returned a non-number for '${f.name}'`);
          k[f.offset] = v;
        } else if (f.type === 'vec3') {
          k.set(v as Vec3, f.offset);
        } else {
          const j = f.offset;
          k.set(quatRate([x[j], x[j + 1], x[j + 2], x[j + 3]], v as Vec3), j);
        }
      }
      return k;
    };
    const axpy = (a: Float64Array, k: Float64Array, h: number): Float64Array => {
      const out = new Float64Array(n);
      for (let j = 0; j < n; j++) out[j] = a[j] + h * k[j];
      return out;
    };
    const renormalize = (x: Float64Array) => {
      for (const f of layout.state) {
        if (f.type !== 'quat') continue;
        const q = x.subarray(f.offset, f.offset + 4);
        const len = Math.hypot(...q);
        for (let j = 0; j < 4; j++) q[j] /= len;
      }
      return x;
    };
    const step = (x: Float64Array, p: ParamValues<P>, t: number) => {
      if ((d.method ?? 'rk4') === 'euler') return renormalize(axpy(x, rates(x, p, t), dt));
      const k1 = rates(x, p, t);
      const k2 = rates(axpy(x, k1, dt / 2), p, t + dt / 2);
      const k3 = rates(axpy(x, k2, dt / 2), p, t + dt / 2);
      const k4 = rates(axpy(x, k3, dt), p, t + dt);
      return renormalize(axpy(axpy(axpy(axpy(x, k1, dt / 6), k2, dt / 3), k3, dt / 3), k4, dt / 6));
    };
    const steadyNames = d.until instanceof Steady ? (d.until.fields ?? layout.state.filter((f) => f.type !== 'quat').map((f) => f.name)) : [];
    const isDone = (prev: Float64Array, next: Float64Array, p: ParamValues<P>, t: number) => {
      if (typeof d.until === 'function') return !!d.until(toObject(next), p, t);
      if (!(d.until instanceof Steady)) return false;
      if (!steadyNames.length) return false;
      return steadyNames.every((name) => {
        const f = layout.state.find((s) => s.name === name)!;
        for (let j = f.offset; j < f.offset + SIZE[f.type]; j++) {
          if (!(Math.abs(next[j] - prev[j]) <= tol * Math.abs(next[j]))) return false;
        }
        return true;
      });
    };

    for (let i = 0; i < count; i++) {
      const p = Object.fromEntries(layout.params.map((name, k) => [name, job.input[i * np + k]])) as ParamValues<P>;
      const sb = i * layout.stride;
      let x: Float64Array = Float64Array.from(job.state.subarray(sb, sb + n));
      const t0 = job.state[sb + n];
      let t = t0;
      let steps = job.state[sb + n + 1];
      let done = false;
      for (let k = 0; k < maxSteps; k++) {
        const next = step(x, p, t);
        t = t0 + (k + 1) * dt;
        steps++;
        done = isDone(x, next, p, t);
        x = next;
        if (done) break;
      }
      job.state.set(x, sb);
      job.state[sb + n] = t;
      job.state[sb + n + 1] = steps;
      job.state[sb + n + 2] = done ? 1 : 0;
      if (d.outputs) {
        const out = d.outputs(toObject(x), p, t) as Record<string, number | Vec3>;
        const ob = i * Math.max(layout.outputFloats, 1);
        for (const f of layout.outputs) {
          const v = out[f.name];
          if (f.type === 'f32') job.output[ob + f.offset] = v as number;
          else job.output.set(v as Vec3, ob + f.offset);
        }
      }
    }
  }
}
