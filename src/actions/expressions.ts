// GitHub Actions expressions: the language inside ${{ }} and `if:`.
// https://docs.github.com/actions/reference/workflows-and-actions/expressions
//
// Literals (null, booleans, numbers, 'strings'), property access (a.b, a['b'],
// the a.*.b object filter), the operators ! < <= > >= == != && || and the
// built-in functions. Comparisons follow GitHub's loose rules: values of
// different types are compared as numbers, and strings ignore case.

export type Value = null | boolean | number | string | Value[] | { [key: string]: Value };

/** The job's status, for success(), failure(), always() and cancelled(). */
export type JobStatus = 'success' | 'failure' | 'cancelled';

export interface EvalContext {
  /** github, env, vars, secrets, inputs, matrix, strategy, needs, steps, job, runner. */
  contexts: Record<string, Value>;
  status?: JobStatus;
  /** For hashFiles(): the paths and contents of the workspace. */
  files?: Record<string, string>;
}

export class ExpressionError extends Error {}

// ---- Tokens ------------------------------------------------------------------

type Token =
  | { kind: 'number'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'ident'; value: string }
  | { kind: 'op'; value: string }
  | { kind: 'end' };

const OPERATORS = ['<=', '>=', '==', '!=', '&&', '||', '!', '<', '>', '(', ')', '[', ']', '.', ',', '*'];

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "'") {
      let value = '';
      i++;
      for (;;) {
        if (i >= source.length) throw new ExpressionError(`Unterminated string in: ${source}`);
        if (source[i] === "'") {
          if (source[i + 1] === "'") {
            value += "'";
            i += 2;
            continue;
          }
          i++;
          break;
        }
        value += source[i++];
      }
      tokens.push({ kind: 'string', value });
      continue;
    }
    const number = /^(0x[0-9a-f]+|-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?)/i.exec(source.slice(i));
    // A '-' only starts a number where an operand is expected.
    const prev = tokens[tokens.length - 1];
    const operandExpected = !prev || (prev.kind === 'op' && ![')', ']'].includes(prev.value));
    if (number && (c !== '-' || operandExpected)) {
      tokens.push({ kind: 'number', value: Number(number[0]) });
      i += number[0].length;
      continue;
    }
    const ident = /^[A-Za-z_][\w-]*/.exec(source.slice(i));
    if (ident) {
      tokens.push({ kind: 'ident', value: ident[0] });
      i += ident[0].length;
      continue;
    }
    const op = OPERATORS.find((o) => source.startsWith(o, i));
    if (op) {
      tokens.push({ kind: 'op', value: op });
      i += op.length;
      continue;
    }
    throw new ExpressionError(`Unexpected '${c}' in: ${source}`);
  }
  tokens.push({ kind: 'end' });
  return tokens;
}

// ---- Syntax tree ---------------------------------------------------------------

type Node =
  | { type: 'literal'; value: Value }
  | { type: 'context'; name: string }
  | { type: 'member'; object: Node; property: Node | '*' }
  | { type: 'call'; name: string; args: Node[] }
  | { type: 'not'; operand: Node }
  | { type: 'binary'; op: string; left: Node; right: Node };

const PRECEDENCE: Record<string, number> = { '||': 1, '&&': 2, '==': 3, '!=': 3, '<': 4, '<=': 4, '>': 4, '>=': 4 };

function parse(source: string): Node {
  const tokens = tokenize(source);
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = (value: string) => {
    const t = peek();
    return t.kind === 'op' && t.value === value;
  };
  const expectOp = (value: string) => {
    if (!isOp(value)) throw new ExpressionError(`Expected '${value}' in: ${source}`);
    pos++;
  };

  function primary(): Node {
    const t = tokens[pos++];
    if (t.kind === 'number' || t.kind === 'string') return { type: 'literal', value: t.value };
    if (t.kind === 'op' && t.value === '(') {
      const inner = expression(0);
      expectOp(')');
      return inner;
    }
    if (t.kind === 'op' && t.value === '!') return { type: 'not', operand: postfix(primary()) };
    if (t.kind === 'ident') {
      if (t.value === 'true' || t.value === 'false') return { type: 'literal', value: t.value === 'true' };
      if (t.value === 'null') return { type: 'literal', value: null };
      if (isOp('(')) {
        pos++;
        const args: Node[] = [];
        if (!isOp(')')) {
          do args.push(expression(0));
          while (isOp(',') && ++pos);
        }
        expectOp(')');
        return { type: 'call', name: t.value.toLowerCase(), args };
      }
      return { type: 'context', name: t.value };
    }
    throw new ExpressionError(`Unexpected ${t.kind === 'end' ? 'end' : `'${'value' in t ? t.value : ''}'`} in: ${source}`);
  }

  function postfix(node: Node): Node {
    for (;;) {
      if (isOp('.')) {
        pos++;
        const t = tokens[pos++];
        if (t.kind === 'op' && t.value === '*') node = { type: 'member', object: node, property: '*' };
        else if (t.kind === 'ident') node = { type: 'member', object: node, property: { type: 'literal', value: t.value } };
        else throw new ExpressionError(`Expected a property name in: ${source}`);
      } else if (isOp('[')) {
        pos++;
        if (isOp('*')) {
          pos++;
          node = { type: 'member', object: node, property: '*' };
        } else {
          node = { type: 'member', object: node, property: expression(0) };
        }
        expectOp(']');
      } else {
        return node;
      }
    }
  }

  function expression(minPrecedence: number): Node {
    let left = postfix(primary());
    for (;;) {
      const t = peek();
      const precedence = t.kind === 'op' ? PRECEDENCE[t.value] : undefined;
      if (precedence === undefined || precedence < minPrecedence) return left;
      pos++;
      const right = expression(precedence + 1);
      left = { type: 'binary', op: (t as { value: string }).value, left, right };
    }
  }

  const node = expression(0);
  if (peek().kind !== 'end') throw new ExpressionError(`Unexpected input after the expression in: ${source}`);
  return node;
}

// ---- Values --------------------------------------------------------------------

const isObject = (v: Value): v is { [key: string]: Value } => !!v && typeof v === 'object' && !Array.isArray(v);

export function truthy(v: Value): boolean {
  if (v === null || v === false || v === '') return false;
  if (typeof v === 'number') return v !== 0 && !Number.isNaN(v);
  return true;
}

function toNumber(v: Value): number {
  if (v === null) return 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return v.trim() === '' ? 0 : Number(v.trim());
  return NaN;
}

/** A value as it is written into a string: ${{ }} interpolation. */
export function toText(v: Value): string {
  if (v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  return JSON.stringify(v, null, 2);
}

function compare(a: Value, b: Value): number {
  if (typeof a === 'string' && typeof b === 'string') {
    const x = a.toUpperCase();
    const y = b.toUpperCase();
    return x < y ? -1 : x > y ? 1 : 0;
  }
  const x = toNumber(a);
  const y = toNumber(b);
  if (Number.isNaN(x) || Number.isNaN(y)) return NaN;
  return x < y ? -1 : x > y ? 1 : 0;
}

function equals(a: Value, b: Value): boolean {
  if (typeof a === 'string' && typeof b === 'string') return a.toUpperCase() === b.toUpperCase();
  if (a !== null && typeof a === 'object') return a === b;
  if (b !== null && typeof b === 'object') return false;
  if (typeof a === typeof b && a !== null) return a === b;
  if (a === null && b === null) return true;
  return toNumber(a) === toNumber(b);
}

function member(object: Value, key: Value): Value {
  if (Array.isArray(object)) {
    const index = toNumber(key);
    return Number.isInteger(index) ? (object[index] ?? null) : null;
  }
  if (isObject(object) && key !== null) {
    // Property names ignore case, as on GitHub.
    const name = toText(key);
    if (name in object) return object[name];
    const match = Object.keys(object).find((k) => k.toLowerCase() === name.toLowerCase());
    return match === undefined ? null : object[match];
  }
  return null;
}

function format(template: string, args: Value[]): string {
  return template.replace(/\{\{|\}\}|\{(\d+)\}/g, (m, index) => {
    if (m === '{{') return '{';
    if (m === '}}') return '}';
    const i = Number(index);
    if (i >= args.length) throw new ExpressionError(`format(): no argument {${i}}`);
    return toText(args[i]);
  });
}

/** A minimal glob for hashFiles(): **, * and ?. */
export function globToRegExp(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      re += pattern[i + 2] === '/' ? '(?:.*/)?' : '.*';
      i += pattern[i + 2] === '/' ? 2 : 1;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** A stable hash of the matched files; GitHub's is a SHA-256, this is FNV-1a (enough to key caches). */
function hashFiles(files: Record<string, string>, patterns: string[]): string {
  const include = patterns.filter((p) => !p.startsWith('!')).map((p) => globToRegExp(p.replace(/^\.\//, '')));
  const exclude = patterns.filter((p) => p.startsWith('!')).map((p) => globToRegExp(p.slice(1).replace(/^\.\//, '')));
  const matched = Object.keys(files)
    .filter((f) => include.some((r) => r.test(f)) && !exclude.some((r) => r.test(f)))
    .sort();
  if (!matched.length) return '';
  let h = 0x811c9dc5;
  for (const f of matched) {
    for (const ch of `${f}\0${files[f]}\0`) {
      h ^= ch.codePointAt(0)!;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  return h.toString(16).padStart(8, '0').repeat(8);
}

function call(name: string, args: Value[], ctx: EvalContext): Value {
  const status = ctx.status ?? 'success';
  const arity = (min: number, max = min) => {
    if (args.length < min || args.length > max) throw new ExpressionError(`${name}() takes ${min === max ? min : `${min}–${max}`} argument${max === 1 ? '' : 's'}`);
  };
  switch (name) {
    case 'success':
      arity(0);
      return status === 'success';
    case 'failure':
      arity(0);
      return status === 'failure';
    case 'cancelled':
      arity(0);
      return status === 'cancelled';
    case 'always':
      arity(0);
      return true;
    case 'contains': {
      arity(2);
      const [haystack, needle] = args;
      if (Array.isArray(haystack)) return haystack.some((item) => equals(item, needle));
      return toText(haystack).toLowerCase().includes(toText(needle).toLowerCase());
    }
    case 'startswith':
      arity(2);
      return toText(args[0]).toLowerCase().startsWith(toText(args[1]).toLowerCase());
    case 'endswith':
      arity(2);
      return toText(args[0]).toLowerCase().endsWith(toText(args[1]).toLowerCase());
    case 'format':
      if (!args.length) throw new ExpressionError('format() needs a format string');
      return format(toText(args[0]), args.slice(1));
    case 'join': {
      arity(1, 2);
      const separator = args.length > 1 ? toText(args[1]) : ',';
      return Array.isArray(args[0]) ? args[0].map(toText).join(separator) : toText(args[0]);
    }
    case 'tojson':
      arity(1);
      return JSON.stringify(args[0], null, 2);
    case 'fromjson':
      arity(1);
      try {
        return JSON.parse(toText(args[0])) as Value;
      } catch {
        throw new ExpressionError(`fromJSON(): not valid JSON: ${toText(args[0])}`);
      }
    case 'hashfiles':
      return hashFiles(ctx.files ?? {}, args.map(toText));
    default:
      throw new ExpressionError(`Unknown function ${name}()`);
  }
}

function evaluateNode(node: Node, ctx: EvalContext): Value {
  switch (node.type) {
    case 'literal':
      return node.value;
    case 'context': {
      const name = node.name.toLowerCase();
      const key = Object.keys(ctx.contexts).find((k) => k.toLowerCase() === name);
      if (key === undefined) throw new ExpressionError(`Unrecognized named-value: '${node.name}'`);
      return ctx.contexts[key];
    }
    case 'member': {
      const object = evaluateNode(node.object, ctx);
      if (node.property === '*') {
        if (Array.isArray(object)) return object;
        return isObject(object) ? Object.values(object) : [];
      }
      const key = evaluateNode(node.property, ctx);
      // After a filter, look the property up in every element.
      if (node.object.type === 'member' && node.object.property === '*' && Array.isArray(object)) {
        return object.map((item) => member(item, key)).filter((v) => v !== null);
      }
      return member(object, key);
    }
    case 'call':
      return call(node.name, node.args.map((a) => evaluateNode(a, ctx)), ctx);
    case 'not':
      return !truthy(evaluateNode(node.operand, ctx));
    case 'binary': {
      if (node.op === '&&') {
        const left = evaluateNode(node.left, ctx);
        return truthy(left) ? evaluateNode(node.right, ctx) : left;
      }
      if (node.op === '||') {
        const left = evaluateNode(node.left, ctx);
        return truthy(left) ? left : evaluateNode(node.right, ctx);
      }
      const left = evaluateNode(node.left, ctx);
      const right = evaluateNode(node.right, ctx);
      switch (node.op) {
        case '==':
          return equals(left, right);
        case '!=':
          return !equals(left, right);
        case '<':
          return compare(left, right) < 0;
        case '<=':
          return compare(left, right) <= 0;
        case '>':
          return compare(left, right) > 0;
        case '>=':
          return compare(left, right) >= 0;
      }
    }
  }
  throw new ExpressionError('Unsupported expression');
}

export function evaluate(source: string, ctx: EvalContext): Value {
  return evaluateNode(parse(source), ctx);
}

const STATUS_FUNCTION = /\b(success|failure|always|cancelled)\s*\(/i;

/** Strips the ${{ }} that an `if:` may be wrapped in. */
const unwrap = (condition: string) => {
  const m = /^\s*\$\{\{([\s\S]*)\}\}\s*$/.exec(condition);
  return m && !m[1].includes('}}') ? m[1] : condition;
};

/**
 * An `if:` condition. Without a status function it is implicitly
 * `success() && (condition)`, so a step after a failure is skipped.
 */
export function evaluateCondition(condition: string | boolean | number | null | undefined, ctx: EvalContext): boolean {
  if (condition === undefined || condition === null || condition === '') return (ctx.status ?? 'success') === 'success';
  if (typeof condition !== 'string') return truthy(condition) && (ctx.status ?? 'success') === 'success';
  const source = unwrap(condition);
  if (!STATUS_FUNCTION.test(source) && (ctx.status ?? 'success') !== 'success') return false;
  return truthy(evaluate(source, ctx));
}

/**
 * Replaces each ${{ expression }} in a string. A string that is a single
 * expression keeps the expression's value (so `${{ matrix.node }}` stays a number).
 */
export function interpolate(text: string, ctx: EvalContext): Value {
  const single = /^\$\{\{([\s\S]*?)\}\}$/.exec(text.trim());
  if (single && text.trim() === text && !single[1].includes('${{')) return evaluate(single[1], ctx);
  return interpolateText(text, ctx);
}

export function interpolateText(text: string, ctx: EvalContext): string {
  return text.replace(/\$\{\{([\s\S]*?)\}\}/g, (_, expr: string) => toText(evaluate(expr, ctx)));
}

/** Interpolates every string inside a value (a `with:`, `env:` or matrix). */
export function interpolateDeep(value: unknown, ctx: EvalContext): Value {
  if (typeof value === 'string') return interpolate(value, ctx);
  if (Array.isArray(value)) return value.map((v) => interpolateDeep(v, ctx));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolateDeep(v, ctx)]));
  }
  return (value ?? null) as Value;
}
