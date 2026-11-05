/**
 * Compiles parsed model functions to WGSL. Types are inferred: every value is
 * a scalar (f32), a vector (vec3<f32>), a rotation (a quaternion, vec4<f32>)
 * or a boolean, from where it came from — a state field, a parameter, a
 * literal, a helper's result. Names are mangled (s_, p_, l_) so that a field
 * called `target` or `select` cannot collide with a WGSL keyword or builtin.
 */

import { CompileError, type Node, type ParsedFunction } from './parse.ts';

export type Type = 'f32' | 'bool' | 'vec3' | 'quat';

const WGSL_TYPE: Record<Type, string> = {
  f32: 'f32',
  bool: 'bool',
  vec3: 'vec3<f32>',
  quat: 'vec4<f32>',
};
export const wgslType = (t: Type) => WGSL_TYPE[t];

export interface Field {
  name: string;
  type: Type;
}

export interface Scope {
  state: Field[];
  params: string[];
  /** The WGSL expressions the function's arguments compile to, in order. */
  args: { state?: string; params?: string; time?: string };
}

interface Value {
  code: string;
  type: Type;
}

const fmt = (n: number) => {
  if (!Number.isFinite(n)) throw new Error(`${n} cannot be written in WGSL`);
  const s = String(n);
  return /[.eE]/.test(s) ? s : `${s}.0`;
};

const MATH_CONST: Record<string, number> = {
  PI: Math.PI, E: Math.E, LN2: Math.LN2, LN10: Math.LN10, LOG2E: Math.LOG2E,
  LOG10E: Math.LOG10E, SQRT2: Math.SQRT2, SQRT1_2: Math.SQRT1_2,
};

/** Math.* functions of scalars, and the WGSL builtin each maps to. */
const MATH_1: Record<string, string> = {
  abs: 'abs', sqrt: 'sqrt', sin: 'sin', cos: 'cos', tan: 'tan', asin: 'asin', acos: 'acos',
  atan: 'atan', sinh: 'sinh', cosh: 'cosh', tanh: 'tanh', exp: 'exp', log: 'log', log2: 'log2',
  floor: 'floor', ceil: 'ceil', trunc: 'trunc', sign: 'sign', round: 'fk_round', cbrt: 'fk_cbrt',
};

/** fluxkit helpers: argument types → result type, and the WGSL to emit. */
const HELPERS: Record<string, { args: Type[]; result: Type; emit: (a: string[]) => string }[]> = {
  vec: [{ args: ['f32', 'f32', 'f32'], result: 'vec3', emit: (a) => `vec3<f32>(${a.join(', ')})` }],
  add: [{ args: ['vec3', 'vec3'], result: 'vec3', emit: ([a, b]) => `(${a} + ${b})` }],
  sub: [{ args: ['vec3', 'vec3'], result: 'vec3', emit: ([a, b]) => `(${a} - ${b})` }],
  scale: [{ args: ['vec3', 'f32'], result: 'vec3', emit: ([a, k]) => `(${a} * ${k})` }],
  dot: [{ args: ['vec3', 'vec3'], result: 'f32', emit: ([a, b]) => `dot(${a}, ${b})` }],
  cross: [{ args: ['vec3', 'vec3'], result: 'vec3', emit: ([a, b]) => `cross(${a}, ${b})` }],
  length: [{ args: ['vec3'], result: 'f32', emit: ([a]) => `length(${a})` }],
  normalize: [{ args: ['vec3'], result: 'vec3', emit: ([a]) => `normalize(${a})` }],
  rotate: [{ args: ['quat', 'vec3'], result: 'vec3', emit: ([q, v]) => `fk_rotate(${q}, ${v})` }],
  angle: [{ args: ['quat'], result: 'f32', emit: ([q]) => `fk_angle(${q})` }],
  spin: [
    { args: ['f32', 'f32', 'f32'], result: 'vec3', emit: (a) => `vec3<f32>(${a.join(', ')})` },
    { args: ['vec3'], result: 'vec3', emit: ([v]) => v },
  ],
};

const ARITH = new Set(['+', '-', '*', '/', '%', '**']);
const COMPARE: Record<string, string> = { '<': '<', '<=': '<=', '>': '>', '>=': '>=', '===': '==', '==': '==', '!==': '!=', '!=': '!=' };

export interface CompiledFunction {
  /** WGSL statements declaring the function's locals. */
  body: string[];
  /** The returned value: an object's entries, or a single value. */
  result: { entries: { key: string; value: Value; at: number }[] } | { value: Value };
}

/**
 * Compiles one model function. `what` names it in errors, e.g. "rates()".
 * The first argument is the state, the second the parameters and the third
 * the time, as the model calls it.
 */
export function compileFunction(parsed: ParsedFunction, what: string, scope: Scope): CompiledFunction {
  const fail = (at: number, message: string): never => {
    throw new CompileError(what, parsed.source, at, message);
  };
  const stateField = new Map(scope.state.map((f) => [f.name, f]));
  const paramSet = new Set(scope.params);
  const locals = new Map<string, Value>();

  // What each argument name means.
  const roles = ['state', 'params', 'time'] as const;
  const argNames = new Map<string, (typeof roles)[number]>();
  parsed.params.forEach((param, i) => {
    const role = roles[i];
    if (!role) fail(0, `${what} takes at most (state, params, t)`);
    if ('name' in param) {
      argNames.set(param.name, role);
    } else {
      if (role === 'time') fail(0, 'the time argument is a number, not an object');
      for (const { key, local } of param.fields) {
        locals.set(local, member(role, key, 0));
      }
    }
  });

  function member(role: 'state' | 'params' | 'time', key: string, at: number): Value {
    if (role === 'state') {
      const field = stateField.get(key);
      if (!field) fail(at, `the state has no field '${key}' (it has ${[...stateField.keys()].join(', ') || 'none'})`);
      return { code: `${scope.args.state}.s_${key}`, type: field!.type };
    }
    if (role === 'params') {
      if (!paramSet.has(key)) fail(at, `there is no parameter '${key}' (there are ${scope.params.join(', ') || 'none'})`);
      return { code: `${scope.args.params}.p_${key}`, type: 'f32' };
    }
    return fail(at, 'the time argument has no fields');
  }

  const expect = (v: Value, type: Type, at: number, context: string): Value => {
    if (v.type !== type) {
      const hint =
        v.type === 'vec3' && type === 'f32'
          ? ' (vectors need helpers: add, sub, scale, dot, length, …)'
          : v.type === 'quat'
            ? ' (a rotation: use rotate(q, v) or angle(q))'
            : '';
      fail(at, `${context} needs a ${describe(type)}, not a ${describe(v.type)}${hint}`);
    }
    return v;
  };

  const helperName = (callee: Node): string | null => {
    if (callee.kind === 'name' && !locals.has(callee.name) && !argNames.has(callee.name) && callee.name in HELPERS) {
      return callee.name;
    }
    if (callee.kind === 'member' && callee.object.kind === 'name' && callee.property in HELPERS) {
      const ns = callee.object.name;
      if (ns !== 'Math' && !locals.has(ns) && !argNames.has(ns)) return callee.property;
    }
    return null;
  };

  const power = (base: Value, exponent: Node, at: number): Value => {
    expect(base, 'f32', at, '**');
    // Small whole powers expand to products, which (unlike WGSL's pow) are
    // right for a negative base, as JavaScript's ** is.
    if (exponent.kind === 'num' && Number.isInteger(exponent.value) && exponent.value >= 0 && exponent.value <= 4) {
      if (exponent.value === 0) return { code: '1.0', type: 'f32' };
      return { code: `(${Array(exponent.value).fill(base.code).join(' * ')})`, type: 'f32' };
    }
    const e = expect(emit(exponent), 'f32', exponent.at, '**');
    return { code: `pow(${base.code}, ${e.code})`, type: 'f32' };
  };

  function emit(node: Node): Value {
    switch (node.kind) {
      case 'num':
        return { code: fmt(node.value), type: 'f32' };
      case 'bool':
        return { code: String(node.value), type: 'bool' };
      case 'name': {
        const local = locals.get(node.name);
        if (local) return local;
        const role = argNames.get(node.name);
        if (role === 'time') return { code: scope.args.time!, type: 'f32' };
        if (role) fail(node.at, `use a field of '${node.name}', like ${node.name}.${role === 'state' ? scope.state[0]?.name ?? 'x' : scope.params[0] ?? 'k'}`);
        if (node.name === 'Infinity' || node.name === 'NaN' || node.name === 'undefined') {
          fail(node.at, `'${node.name}' has no meaning on the GPU`);
        }
        return fail(
          node.at,
          `unknown name '${node.name}': a model function can use its arguments, its own consts, Math and fluxkit's helpers. Put other constants in params.`
        );
      }
      case 'member': {
        if (node.object.kind === 'name') {
          const name = node.object.name;
          const role = argNames.get(name);
          if (role) return member(role, node.property, node.at);
          if (name === 'Math' && !locals.has('Math')) {
            if (node.property in MATH_CONST) return { code: fmt(MATH_CONST[node.property]), type: 'f32' };
            fail(node.at, `Math.${node.property} is not available here`);
          }
        }
        const object = emit(node.object);
        if (object.type === 'vec3' || object.type === 'quat') {
          fail(node.at, `use an index for a component, like v[0], not .${node.property}`);
        }
        return fail(node.at, `'.${node.property}' is not available here`);
      }
      case 'index': {
        const object = emit(node.object);
        if (object.type !== 'vec3' && object.type !== 'quat') fail(node.at, 'only vectors and rotations can be indexed');
        const max = object.type === 'vec3' ? 2 : 3;
        if (node.index.kind !== 'num' || !Number.isInteger(node.index.value) || node.index.value < 0 || node.index.value > max) {
          fail(node.index.at, `the index must be a number from 0 to ${max}`);
        }
        return { code: `${object.code}.${'xyzw'[(node.index as { value: number }).value]}`, type: 'f32' };
      }
      case 'call': {
        const { callee } = node;
        if (callee.kind === 'member' && callee.object.kind === 'name' && callee.object.name === 'Math' && !locals.has('Math')) {
          return math(callee.property, node.args, node.at);
        }
        const helper = helperName(callee);
        if (!helper) {
          return fail(node.at, `only Math functions and fluxkit's helpers can be called (${Object.keys(HELPERS).join(', ')})`);
        }
        const args = node.args.map(emit);
        const overload = HELPERS[helper].find(
          (o) => o.args.length === args.length && o.args.every((t, i) => args[i].type === t)
        );
        if (!overload) {
          const wanted = HELPERS[helper].map((o) => `${helper}(${o.args.map(describe).join(', ')})`).join(' or ');
          return fail(node.at, `${helper}() takes ${wanted}, not (${args.map((a) => describe(a.type)).join(', ')})`);
        }
        return { code: overload.emit(args.map((a) => a.code)), type: overload.result };
      }
      case 'array': {
        if (node.items.length !== 3) fail(node.at, 'a vector has 3 components: [x, y, z]');
        const items = node.items.map((item) => expect(emit(item), 'f32', item.at, 'a vector component'));
        return { code: `vec3<f32>(${items.map((i) => i.code).join(', ')})`, type: 'vec3' };
      }
      case 'object':
        return fail(node.at, 'an object can only be the returned value');
      case 'unary': {
        const arg = emit(node.arg);
        if (node.op === '!') return { code: `!(${expect(arg, 'bool', node.at, '!').code})`, type: 'bool' };
        expect(arg, 'f32', node.at, `unary ${node.op}`);
        return { code: node.op === '-' ? `(-${arg.code})` : arg.code, type: 'f32' };
      }
      case 'binary': {
        if (node.op === '**') return power(emit(node.left), node.right, node.at);
        const left = emit(node.left);
        const right = emit(node.right);
        if (ARITH.has(node.op)) {
          if (left.type === 'vec3' || right.type === 'vec3') {
            const fix = { '+': 'add(a, b)', '-': 'sub(a, b)', '*': 'scale(v, k) or dot(a, b)', '/': 'scale(v, 1 / k)' }[node.op as '+'];
            fail(node.at, `'${node.op}' on a vector is not vector arithmetic in JavaScript: use ${fix ?? 'the vector helpers'}`);
          }
          expect(left, 'f32', node.left.at, `'${node.op}'`);
          expect(right, 'f32', node.right.at, `'${node.op}'`);
          return { code: `(${left.code} ${node.op} ${right.code})`, type: 'f32' };
        }
        if (node.op in COMPARE) {
          if (left.type !== right.type || (left.type !== 'f32' && left.type !== 'bool')) {
            fail(node.at, `'${node.op}' compares two numbers (or two booleans)`);
          }
          return { code: `(${left.code} ${COMPARE[node.op]} ${right.code})`, type: 'bool' };
        }
        if (node.op === '&&' || node.op === '||') {
          expect(left, 'bool', node.left.at, `'${node.op}'`);
          expect(right, 'bool', node.right.at, `'${node.op}'`);
          return { code: `(${left.code} ${node.op} ${right.code})`, type: 'bool' };
        }
        return fail(node.at, `'${node.op}' is not supported`);
      }
      case 'ternary': {
        const test = expect(emit(node.test), 'bool', node.test.at, 'the condition of ? :');
        const yes = emit(node.consequent);
        const no = emit(node.alternate);
        if (yes.type !== no.type) {
          fail(node.at, `both branches of ? : must have the same type (${describe(yes.type)} and ${describe(no.type)})`);
        }
        // Both branches are evaluated, which is safe: they have no side effects.
        return { code: `select(${no.code}, ${yes.code}, ${test.code})`, type: yes.type };
      }
    }
  }

  function math(name: string, argNodes: Node[], at: number): Value {
    const args = argNodes.map((a) => expect(emit(a), 'f32', a.at, `Math.${name}`));
    const codes = args.map((a) => a.code);
    const count = (n: number) => {
      if (args.length !== n) fail(at, `Math.${name} takes ${n} argument${n === 1 ? '' : 's'}`);
    };
    if (name in MATH_1) {
      count(1);
      return { code: `${MATH_1[name]}(${codes[0]})`, type: 'f32' };
    }
    switch (name) {
      case 'atan2':
        count(2);
        return { code: `atan2(${codes[0]}, ${codes[1]})`, type: 'f32' };
      case 'pow':
        count(2);
        return power(args[0], argNodes[1], at);
      case 'min':
      case 'max':
        if (args.length < 2) fail(at, `Math.${name} takes at least 2 arguments here`);
        return { code: codes.reduce((a, b) => `${name}(${a}, ${b})`), type: 'f32' };
      case 'hypot':
        if (args.length === 2) return { code: `length(vec2<f32>(${codes.join(', ')}))`, type: 'f32' };
        if (args.length === 3) return { code: `length(vec3<f32>(${codes.join(', ')}))`, type: 'f32' };
        return fail(at, 'Math.hypot takes 2 or 3 arguments here');
      case 'log10':
        count(1);
        return { code: `(log(${codes[0]}) / ${fmt(Math.LN10)})`, type: 'f32' };
      case 'exp2':
        count(1);
        return { code: `exp2(${codes[0]})`, type: 'f32' };
      default:
        return fail(at, `Math.${name} is not available on the GPU`);
    }
  }

  const body: string[] = [];
  for (const local of parsed.locals) {
    if (locals.has(local.name) || argNames.has(local.name)) fail(local.at, `'${local.name}' is already declared`);
    const value = emit(local.value);
    const code = `l_${local.name}`;
    body.push(`  let ${code} = ${value.code};`);
    locals.set(local.name, { code, type: value.type });
  }
  if (parsed.result.kind === 'object') {
    const seen = new Set<string>();
    const entries = parsed.result.entries.map((e) => {
      if (seen.has(e.key)) fail(e.at, `'${e.key}' is returned twice`);
      seen.add(e.key);
      return { key: e.key, value: emit(e.value), at: e.at };
    });
    return { body, result: { entries } };
  }
  return { body, result: { value: emit(parsed.result) } };
}

export function describe(t: Type): string {
  return { f32: 'number', bool: 'boolean', vec3: 'vector', quat: 'rotation' }[t];
}
