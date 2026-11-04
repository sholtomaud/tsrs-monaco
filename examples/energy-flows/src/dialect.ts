/**
 * A small dialect for energy networks, written in the editor as a tagged
 * template and parsed into the linear system the GPU integrates,
 *
 *     dx/dt = C x + u,
 *
 * one line at a time (`#` starts a comment):
 *
 *     storage producers = 0, herbivores      compartments x, with x0 (default 0)
 *     source  sun                            external inputs
 *     sink    heat, export                   where energy leaves
 *     param   k = 3368 / 809                 named constants
 *
 *     sun        -> producers  = 20810       a constant input, into u
 *     producers  -> herbivores = k * producers
 *     herbivores -> heat       = 51 * herbivores
 *
 * A flow out of a storage is donor controlled, J = k · x_donor (Odum's linear
 * pathway), so it must be written as a non-negative constant times the
 * donor's storage; anything else (a product of two storages, a constant
 * leaving a storage, a flow that depends on the receiver) is reported with
 * its line and column. Each flow X → Y adds k to C[Y][X] and subtracts it
 * from C[X][X], so every column of C sums to minus that compartment's losses
 * to sinks: energy is conserved by construction.
 */

export interface Flow {
  from: string;
  to: string;
  /** input: source → storage (value is the flow); transfer and loss: value is k. */
  kind: 'input' | 'transfer' | 'loss';
  value: number;
  line: number;
}

export interface Network {
  /** Compartments: the order of the rows and columns of C. */
  storages: string[];
  x0: number[];
  /** n×n, row-major, C[i * n + j]: the rate of flow from j into i per unit of x_j. */
  C: number[];
  /** Constant inputs into each storage, all sources together. */
  u: number[];
  /** Each source's inputs into each storage (emergy needs them apart). */
  sources: { name: string; flows: number[] }[];
  /** Each sink's coefficient on each storage: flow = coefficient · x. */
  sinks: { name: string; coefficients: number[] }[];
  flows: Flow[];
  params: Record<string, number>;
}

export class DialectError extends Error {
  readonly line: number;
  readonly column: number;
  readonly sourceLine: string;

  constructor(message: string, line: number, column: number, sourceLine: string) {
    super(`line ${line}:${column}: ${message}\n  ${sourceLine.trim()}`);
    this.name = 'DialectError';
    this.line = line;
    this.column = column;
    this.sourceLine = sourceLine;
  }
}

type Kind = 'storage' | 'source' | 'sink' | 'param';

interface Token {
  type: 'name' | 'number' | 'op';
  text: string;
  column: number;
}

const TOKEN = /\s*(?:([A-Za-z_][\w]*)|((?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)|(->|[=,+\-*/()]))/y;

function tokenize(text: string, fail: (message: string, column: number) => DialectError): Token[] {
  const tokens: Token[] = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < text.length) {
    if (/^\s*$/.test(text.slice(TOKEN.lastIndex))) break;
    const start = TOKEN.lastIndex;
    const m = TOKEN.exec(text);
    if (!m) {
      const column = start + (text.slice(start).length - text.slice(start).trimStart().length);
      throw fail(`unexpected '${text[column]}'`, column + 1);
    }
    const column = m.index + m[0].length - (m[1] ?? m[2] ?? m[3]).length + 1;
    if (m[1]) tokens.push({ type: 'name', text: m[1], column });
    else if (m[2]) tokens.push({ type: 'number', text: m[2], column });
    else tokens.push({ type: 'op', text: m[3], column });
  }
  return tokens;
}

/** const + Σ coefficient · storage */
interface Linear {
  constant: number;
  terms: Map<string, number>;
}

const constant = (value: number): Linear => ({ constant: value, terms: new Map() });

function combine(a: Linear, b: Linear, sign: 1 | -1): Linear {
  const terms = new Map(a.terms);
  for (const [name, k] of b.terms) terms.set(name, (terms.get(name) ?? 0) + sign * k);
  return { constant: a.constant + sign * b.constant, terms };
}

function scale(a: Linear, factor: number): Linear {
  return {
    constant: a.constant * factor,
    terms: new Map([...a.terms].map(([name, k]) => [name, k * factor])),
  };
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length];
}

export function parseNetwork(text: string): Network {
  const lines = text.split('\n');
  const kinds = new Map<string, Kind>();
  const declaredAt = new Map<string, number>();
  const storages: string[] = [];
  const sources: string[] = [];
  const sinks: string[] = [];

  const tokenized = lines.map((raw, index) => {
    const lineNo = index + 1;
    const body = raw.replace(/#.*$/, '');
    const fail = (message: string, column: number) => new DialectError(message, lineNo, column, raw);
    return { tokens: tokenize(body, fail), fail, lineNo };
  });

  // Pass 1: declarations, so flows can name storages declared further down.
  for (const { tokens, fail, lineNo } of tokenized) {
    const head = tokens[0];
    if (!head || head.type !== 'name' || !['storage', 'source', 'sink'].includes(head.text)) continue;
    if (tokens[1]?.text === '->') continue;
    const kind = head.text as Kind;
    let i = 1;
    for (;;) {
      const name = tokens[i];
      if (!name || name.type !== 'name') throw fail(`expected a ${kind} name`, name?.column ?? head.column + head.text.length + 1);
      if (kinds.has(name.text)) {
        throw fail(`'${name.text}' is already declared (line ${declaredAt.get(name.text)})`, name.column);
      }
      kinds.set(name.text, kind);
      declaredAt.set(name.text, lineNo);
      ({ storage: storages, source: sources, sink: sinks } as Record<string, string[]>)[kind].push(name.text);
      i++;
      if (kind === 'storage' && tokens[i]?.text === '=') {
        // Skip the initial value; it is evaluated in pass 2.
        while (tokens[i] && tokens[i].text !== ',') i++;
      }
      if (!tokens[i]) break;
      if (tokens[i].text !== ',') throw fail(`expected ',' or the end of the line`, tokens[i].column);
      i++;
    }
  }
  if (storages.length === 0) {
    throw new DialectError('a network needs at least one storage', 1, 1, lines[0] ?? '');
  }

  const n = storages.length;
  const index = new Map(storages.map((name, i) => [name, i]));
  const x0 = Array.from({ length: n }, () => 0);
  const C = Array.from({ length: n * n }, () => 0);
  const u = Array.from({ length: n }, () => 0);
  const sourceFlows = sources.map((name) => ({ name, flows: Array.from({ length: n }, () => 0) }));
  const sinkCoefficients = sinks.map((name) => ({ name, coefficients: Array.from({ length: n }, () => 0) }));
  const flows: Flow[] = [];
  const params: Record<string, number> = {};

  // Pass 2: parameters, initial values and flows, in order.
  for (const { tokens, fail, lineNo } of tokenized) {
    if (tokens.length === 0) continue;
    let pos = 0;
    const peek = () => tokens[pos];
    const endColumn = () => {
      const last = tokens[tokens.length - 1];
      return last.column + last.text.length;
    };
    const expect = (text: string) => {
      const t = tokens[pos];
      if (t?.text !== text) throw fail(`expected '${text}'`, t?.column ?? endColumn());
      pos++;
    };
    const unknown = (t: Token): never => {
      const known = [...kinds.keys()];
      const close = known.filter((k) => distance(k, t.text) <= Math.max(1, Math.floor(k.length / 4)));
      throw fail(`unknown name '${t.text}'${close.length ? `; did you mean '${close[0]}'?` : ''}`, t.column);
    };

    // expr := term (('+' | '-') term)*
    const expr = (): Linear => {
      let value = term();
      while (peek()?.text === '+' || peek()?.text === '-') {
        const sign = tokens[pos++].text === '+' ? 1 : -1;
        value = combine(value, term(), sign);
      }
      return value;
    };
    // term := unary (('*' | '/') unary)*
    const term = (): Linear => {
      let value = unary();
      while (peek()?.text === '*' || peek()?.text === '/') {
        const op = tokens[pos++];
        const right = unary();
        if (op.text === '*') {
          if (value.terms.size && right.terms.size) {
            throw fail('a flow must be linear: this multiplies two storages', op.column);
          }
          value = right.terms.size ? scale(right, value.constant) : scale(value, right.constant);
        } else {
          if (right.terms.size) throw fail('can only divide by a constant', op.column);
          if (right.constant === 0) throw fail('division by zero', op.column);
          value = scale(value, 1 / right.constant);
        }
      }
      return value;
    };
    const unary = (): Linear => {
      if (peek()?.text === '-') {
        pos++;
        return scale(unary(), -1);
      }
      if (peek()?.text === '+') {
        pos++;
        return unary();
      }
      return primary();
    };
    const primary = (): Linear => {
      const t = tokens[pos++];
      if (!t) throw fail('expected a number or a name', endColumn());
      if (t.type === 'number') return constant(Number(t.text));
      if (t.text === '(') {
        const value = expr();
        expect(')');
        return value;
      }
      if (t.type === 'name') {
        if (Object.hasOwn(params, t.text)) return constant(params[t.text]);
        const kind = kinds.get(t.text);
        if (kind === 'storage') return { constant: 0, terms: new Map([[t.text, 1]]) };
        if (kind) throw fail(`'${t.text}' is a ${kind}; only storages and params can appear in a value`, t.column);
        return unknown(t);
      }
      throw fail(`unexpected '${t.text}'`, t.column);
    };
    const constantExpr = (what: string): number => {
      const start = peek();
      const value = expr();
      if (value.terms.size) throw fail(`${what} must be a constant`, start?.column ?? endColumn());
      if (!Number.isFinite(value.constant)) throw fail(`${what} is not finite`, start?.column ?? endColumn());
      return value.constant;
    };
    const end = () => {
      if (pos < tokens.length) throw fail(`unexpected '${tokens[pos].text}'`, tokens[pos].column);
    };
    const name = (): Token => {
      const t = tokens[pos++];
      if (!t || t.type !== 'name') throw fail('expected a name', t?.column ?? endColumn());
      return t;
    };

    const head = tokens[0];
    if (tokens[1]?.text === '->') {
      // from -> to = value
      const from = name();
      expect('->');
      const to = name();
      expect('=');
      const valueStart = peek();
      const value = expr();
      end();
      const fromKind = kinds.get(from.text) ?? unknown(from);
      const toKind = kinds.get(to.text) ?? unknown(to);
      const at = valueStart?.column ?? endColumn();
      if (fromKind === 'sink') throw fail(`'${from.text}' is a sink: nothing flows out of it`, from.column);
      if (fromKind === 'param') throw fail(`'${from.text}' is a param, not a source or storage`, from.column);
      if (toKind === 'source') throw fail(`'${to.text}' is a source: nothing flows into it`, to.column);
      if (toKind === 'param') throw fail(`'${to.text}' is a param, not a storage or sink`, to.column);
      if (from.text === to.text) throw fail('a flow must go to a different place', to.column);

      if (fromKind === 'source') {
        if (toKind !== 'storage') throw fail('an input from a source must go into a storage', to.column);
        if (value.terms.size) throw fail(`an input from a source is a constant flow, not a function of storage`, at);
        if (value.constant < 0) throw fail('flows must not be negative', at);
        const j = index.get(to.text)!;
        u[j] += value.constant;
        sourceFlows[sources.indexOf(from.text)].flows[j] += value.constant;
        flows.push({ from: from.text, to: to.text, kind: 'input', value: value.constant, line: lineNo });
        continue;
      }
      // Donor controlled: value = k * from.
      const others = [...value.terms.keys()].filter((s) => s !== from.text);
      if (others.length) {
        throw fail(`a flow out of '${from.text}' must be k * ${from.text} (donor controlled), not depend on '${others[0]}'`, at);
      }
      if (value.constant !== 0) {
        throw fail(`a flow out of '${from.text}' must be k * ${from.text}; a constant would drain it below zero`, at);
      }
      const k = value.terms.get(from.text) ?? 0;
      if (k < 0) throw fail('flows must not be negative', at);
      const i = index.get(from.text)!;
      C[i * n + i] -= k;
      if (toKind === 'storage') {
        const j = index.get(to.text)!;
        C[j * n + i] += k;
        flows.push({ from: from.text, to: to.text, kind: 'transfer', value: k, line: lineNo });
      } else {
        sinkCoefficients[sinks.indexOf(to.text)].coefficients[i] += k;
        flows.push({ from: from.text, to: to.text, kind: 'loss', value: k, line: lineNo });
      }
      continue;
    }

    if (head.type !== 'name') throw fail(`expected a declaration or a flow 'a -> b = …'`, head.column);
    pos = 1;
    switch (head.text) {
      case 'param': {
        const p = name();
        if (kinds.has(p.text)) throw fail(`'${p.text}' is already declared (line ${declaredAt.get(p.text)})`, p.column);
        expect('=');
        params[p.text] = constantExpr(`param '${p.text}'`);
        kinds.set(p.text, 'param');
        declaredAt.set(p.text, lineNo);
        end();
        break;
      }
      case 'storage':
        for (;;) {
          const s = name();
          if (peek()?.text === '=') {
            pos++;
            const valueStart = peek();
            const value = constantExpr(`the initial value of '${s.text}'`);
            if (value < 0) throw fail('storages must not start negative', valueStart?.column ?? endColumn());
            x0[index.get(s.text)!] = value;
          }
          if (pos >= tokens.length) break;
          expect(',');
        }
        break;
      case 'source':
      case 'sink':
        break; // handled in pass 1
      default:
        if (tokens.length === 1 || tokens[1].text !== '->') {
          throw fail(`expected 'storage', 'source', 'sink', 'param' or a flow 'a -> b = …'`, head.column);
        }
    }
  }

  return { storages, x0, C, u, sources: sourceFlows, sinks: sinkCoefficients, flows, params };
}

/**
 * Tagged template: ecosystem`storage x ...`. Interpolated numbers are
 * written into the text, so `param k = ${k}` works.
 */
export function ecosystem(strings: TemplateStringsArray, ...values: (number | string)[]): Network {
  return parseNetwork(strings.reduce((text, part, i) => text + String(values[i - 1]) + part));
}
