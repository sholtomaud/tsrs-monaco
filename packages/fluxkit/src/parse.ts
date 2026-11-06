/**
 * Reads a model function's own JavaScript source into a small syntax tree,
 * so it can be compiled to WGSL. Only the part of JavaScript a physics rate
 * law needs is accepted: `const`/`let` declarations, `return`, arithmetic,
 * comparisons, `&&`/`||`/`!`, the ternary, `Math.*`, calls to fluxkit's
 * helpers, `[x, y, z]` vectors and `v[0]` components, and an object literal
 * as the returned value. Anything else is refused with its line and column,
 * so the CPU (which simply calls the function) and the GPU never disagree
 * about what the code means.
 */

export type Node =
  | { kind: 'num'; value: number; at: number }
  | { kind: 'bool'; value: boolean; at: number }
  | { kind: 'name'; name: string; at: number }
  | { kind: 'member'; object: Node; property: string; at: number }
  | { kind: 'index'; object: Node; index: Node; at: number }
  | { kind: 'call'; callee: Node; args: Node[]; at: number }
  | { kind: 'array'; items: Node[]; at: number }
  | { kind: 'object'; entries: { key: string; value: Node; at: number }[]; at: number }
  | { kind: 'unary'; op: '-' | '+' | '!'; arg: Node; at: number }
  | { kind: 'binary'; op: string; left: Node; right: Node; at: number }
  | { kind: 'ternary'; test: Node; consequent: Node; alternate: Node; at: number };

/** A parameter: a name, or `{ a, b: c }` destructuring of the argument's fields. */
export type Param = { name: string } | { fields: { key: string; local: string }[] };

export interface ParsedFunction {
  params: Param[];
  /** `const x = …` in order, then the returned value. */
  locals: { name: string; value: Node; at: number }[];
  result: Node;
  /** The function's source, for error messages. */
  source: string;
}

export class CompileError extends Error {
  readonly line: number;
  readonly column: number;

  constructor(what: string, source: string, at: number, message: string) {
    const before = source.slice(0, at);
    const line = before.split('\n').length;
    const column = at - before.lastIndexOf('\n');
    const text = source.split('\n')[line - 1] ?? '';
    super(`${what}, line ${line}:${column}: ${message}\n  ${text.trim()}`);
    this.name = 'CompileError';
    this.line = line;
    this.column = column;
  }
}

interface Token {
  type: 'num' | 'name' | 'punct' | 'eof';
  text: string;
  at: number;
}

const PUNCT = [
  '===', '!==', '**', '=>', '==', '!=', '<=', '>=', '&&', '||', '...',
  '(', ')', '{', '}', '[', ']', ',', ';', ':', '?', '.', '=', '+', '-', '*', '/', '%', '<', '>', '!',
];

function tokenize(src: string, fail: (at: number, msg: string) => never): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
    } else if (src.startsWith('//', i)) {
      i = src.indexOf('\n', i) === -1 ? src.length : src.indexOf('\n', i);
    } else if (src.startsWith('/*', i)) {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
    } else if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^(?:0[xX][0-9a-fA-F_]+|(?:[0-9][0-9_]*\.?[0-9_]*|\.[0-9][0-9_]*)(?:[eE][+-]?[0-9]+)?)/.exec(src.slice(i))!;
      tokens.push({ type: 'num', text: m[0].replace(/_/g, ''), at: i });
      i += m[0].length;
    } else if (/[A-Za-z_$]/.test(c)) {
      const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i))!;
      tokens.push({ type: 'name', text: m[0], at: i });
      i += m[0].length;
    } else {
      const p = PUNCT.find((p) => src.startsWith(p, i));
      if (!p) fail(i, `unexpected '${c}'`);
      tokens.push({ type: 'punct', text: p, at: i });
      i += p.length;
    }
  }
  tokens.push({ type: 'eof', text: '', at: src.length });
  return tokens;
}

const BINARY: Record<string, number> = {
  '||': 1, '&&': 2,
  '===': 3, '!==': 3, '==': 3, '!=': 3,
  '<': 4, '<=': 4, '>': 4, '>=': 4,
  '+': 5, '-': 5,
  '*': 6, '/': 6, '%': 6,
  '**': 7,
};

/** Parses `fn.toString()` of an arrow function, function or method. */
export function parseFunction(fn: Function, what: string): ParsedFunction {
  const source = fn.toString();
  const fail = (at: number, message: string): never => {
    throw new CompileError(what, source, at, message);
  };
  if (source.includes('[native code]')) fail(0, 'this is a built-in or bound function; pass the function itself');
  const tokens = tokenize(source, fail);
  let pos = 0;
  const peek = (k = 0) => tokens[pos + k];
  const next = () => tokens[pos++];
  const is = (text: string, k = 0) => peek(k).type === 'punct' && peek(k).text === text;
  const isWord = (text: string, k = 0) => peek(k).type === 'name' && peek(k).text === text;
  const expect = (text: string) => {
    if (!is(text)) fail(peek().at, `expected '${text}'${peek().text ? `, found '${peek().text}'` : ''}`);
    return next();
  };

  // ---- the function's head ----
  if (isWord('async')) fail(peek().at, 'model functions cannot be async');
  let arrow = false;
  if (isWord('function')) {
    next();
    if (is('*')) fail(peek().at, 'model functions cannot be generators');
    if (peek().type === 'name') next();
  } else if (peek().type === 'name' && is('(', 1)) {
    next(); // method shorthand: rates(s, p) { … }
  } else {
    arrow = true;
  }

  const params: Param[] = [];
  const param = (): Param => {
    if (is('{')) {
      next();
      const fields: { key: string; local: string }[] = [];
      while (!is('}')) {
        const key = next();
        if (key.type !== 'name') fail(key.at, 'expected a field name');
        let local = key.text;
        if (is(':')) {
          next();
          const l = next();
          if (l.type !== 'name') fail(l.at, 'expected a name');
          local = l.text;
        }
        if (is('=')) fail(peek().at, 'default values are not supported here');
        fields.push({ key: key.text, local });
        if (!is('}')) expect(',');
      }
      next();
      return { fields };
    }
    const t = next();
    if (t.type !== 'name') fail(t.at, 'expected a parameter name');
    if (is('=')) fail(peek().at, 'default values are not supported here');
    return { name: t.text };
  };
  if (arrow && peek().type === 'name' && is('=>', 1)) {
    params.push(param());
  } else {
    expect('(');
    while (!is(')')) {
      if (is('...')) fail(peek().at, 'rest parameters are not supported');
      params.push(param());
      if (!is(')')) expect(',');
    }
    next();
  }
  if (arrow) expect('=>');

  // ---- expressions ----
  const expression = (): Node => ternary();
  const ternary = (): Node => {
    const test = binary(1);
    if (!is('?')) return test;
    const at = next().at;
    const consequent = expression();
    expect(':');
    return { kind: 'ternary', test, consequent, alternate: expression(), at };
  };
  const binary = (min: number): Node => {
    let left = unary();
    for (;;) {
      const t = peek();
      const prec = t.type === 'punct' ? BINARY[t.text] : undefined;
      if (prec === undefined || prec < min) return left;
      next();
      // ** is right-associative; the rest are left-associative.
      const right = t.text === '**' ? binary(prec) : binary(prec + 1);
      left = { kind: 'binary', op: t.text, left, right, at: t.at };
    }
  };
  const unary = (): Node => {
    if (is('-') || is('+') || is('!')) {
      const t = next();
      return { kind: 'unary', op: t.text as '-' | '+' | '!', arg: unary(), at: t.at };
    }
    if (isWord('typeof') || isWord('new') || isWord('await') || isWord('void') || isWord('delete')) {
      fail(peek().at, `'${peek().text}' is not supported in a model function`);
    }
    return postfix();
  };
  const postfix = (): Node => {
    let node = primary();
    for (;;) {
      if (is('.')) {
        next();
        const t = next();
        if (t.type !== 'name') fail(t.at, 'expected a property name');
        node = { kind: 'member', object: node, property: t.text, at: t.at };
      } else if (is('[')) {
        const at = next().at;
        const index = expression();
        expect(']');
        node = { kind: 'index', object: node, index, at };
      } else if (is('(')) {
        const at = next().at;
        const args: Node[] = [];
        while (!is(')')) {
          if (is('...')) fail(peek().at, 'spread arguments are not supported');
          args.push(expression());
          if (!is(')')) expect(',');
        }
        next();
        node = { kind: 'call', callee: node, args, at };
      } else {
        return node;
      }
    }
  };
  const primary = (): Node => {
    const t = next();
    if (t.type === 'num') return { kind: 'num', value: Number(t.text), at: t.at };
    if (t.type === 'name') {
      if (t.text === 'true' || t.text === 'false') return { kind: 'bool', value: t.text === 'true', at: t.at };
      if (t.text === 'function' || t.text === 'class') fail(t.at, `nested ${t.text}s are not supported`);
      if (is('=>')) fail(t.at, 'nested functions are not supported');
      return { kind: 'name', name: t.text, at: t.at };
    }
    if (t.text === '(') {
      const node = expression();
      expect(')');
      if (is('=>')) fail(peek().at, 'nested functions are not supported');
      return node;
    }
    if (t.text === '[') {
      const items: Node[] = [];
      while (!is(']')) {
        items.push(expression());
        if (!is(']')) expect(',');
      }
      next();
      return { kind: 'array', items, at: t.at };
    }
    if (t.text === '{') {
      const entries: { key: string; value: Node; at: number }[] = [];
      while (!is('}')) {
        const key = next();
        if (key.type !== 'name' && key.type !== 'num') fail(key.at, 'expected a property name');
        if (is(':')) {
          next();
          entries.push({ key: key.text, value: expression(), at: key.at });
        } else {
          entries.push({ key: key.text, value: { kind: 'name', name: key.text, at: key.at }, at: key.at });
        }
        if (!is('}')) expect(',');
      }
      next();
      return { kind: 'object', entries, at: t.at };
    }
    if (t.type === 'eof') fail(t.at, 'unexpected end of the function');
    return fail(t.at, `unexpected '${t.text}'`);
  };

  // ---- the body ----
  const locals: { name: string; value: Node; at: number }[] = [];
  let result: Node;
  if (arrow && !is('{')) {
    result = expression();
  } else {
    expect('{');
    for (;;) {
      if (is(';')) {
        next();
        continue;
      }
      if (isWord('const') || isWord('let') || isWord('var')) {
        next();
        for (;;) {
          const name = next();
          if (name.type !== 'name') fail(name.at, 'expected a name (destructuring is not supported here)');
          expect('=');
          locals.push({ name: name.text, value: expression(), at: name.at });
          if (!is(',')) break;
          next();
        }
        continue;
      }
      if (isWord('return')) {
        next();
        result = expression();
        while (is(';')) next();
        if (!is('}')) fail(peek().at, 'the return must be the last statement');
        break;
      }
      if (is('}')) fail(peek().at, 'the function must return a value');
      const t = peek();
      if (t.type === 'name' && ['if', 'for', 'while', 'do', 'switch', 'try', 'throw'].includes(t.text)) {
        fail(t.at, `'${t.text}' statements are not supported: use a ternary (a ? b : c) for choices`);
      }
      if (t.type === 'name' && is('=', 1)) fail(t.at, `reassigning '${t.text}' is not supported: declare a new const`);
      fail(t.at, `unexpected '${t.text}': a model function holds const declarations and a return`);
    }
  }
  return { params, locals, result: result!, source };
}
