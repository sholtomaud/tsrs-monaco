// A small bash for `run:` steps, over an in-memory file system. It covers
// what CI scripts usually do: commands joined by ; && || and |, variables
// ($X, ${X}, ${X:-default}), quoting, $(command substitution), redirections
// (> >> < 2>&1, here-documents), if/elif/else, for and while loops, and
// `set -e` (on by default, as for GitHub's `bash -e {0}`). Commands come from
// the builtins below plus a table supplied by the caller (npm, tsc, …).

export class VirtualFS {
  private files = new Map<string, string>();
  private dirs = new Set<string>(['/']);

  constructor(entries: Record<string, string> = {}) {
    for (const [path, text] of Object.entries(entries)) this.write(path, text);
  }

  static normalize(path: string, cwd = '/'): string {
    const parts: string[] = [];
    for (const part of (path.startsWith('/') ? path : `${cwd}/${path}`).split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') parts.pop();
      else parts.push(part);
    }
    return `/${parts.join('/')}`;
  }

  read(path: string): string | undefined {
    return this.files.get(path);
  }

  write(path: string, text: string) {
    this.files.set(path, text);
    const parts = path.split('/').slice(1, -1);
    for (let i = 0; i <= parts.length; i++) this.dirs.add(`/${parts.slice(0, i).join('/')}`);
  }

  append(path: string, text: string) {
    this.write(path, (this.files.get(path) ?? '') + text);
  }

  mkdir(path: string) {
    this.write(`${path}/\u0000`, '');
    this.files.delete(`${path}/\u0000`);
  }

  isFile(path: string) {
    return this.files.has(path);
  }

  isDir(path: string) {
    return this.dirs.has(path);
  }

  remove(path: string, recursive: boolean): boolean {
    if (this.files.delete(path)) return true;
    if (!this.dirs.has(path) || !recursive) return false;
    const prefix = path === '/' ? '/' : `${path}/`;
    for (const f of this.files.keys()) if (f.startsWith(prefix)) this.files.delete(f);
    for (const d of this.dirs) if (d === path || d.startsWith(prefix)) this.dirs.delete(d);
    return true;
  }

  /** Names directly inside a directory, sorted. */
  list(dir: string): string[] {
    const prefix = dir === '/' ? '/' : `${dir}/`;
    const names = new Set<string>();
    for (const p of [...this.files.keys(), ...this.dirs]) {
      if (p.startsWith(prefix) && p.length > prefix.length) names.add(p.slice(prefix.length).split('/')[0]);
    }
    return [...names].sort();
  }

  /** Every file under a directory, by path relative to it. */
  filesUnder(dir: string): Record<string, string> {
    const prefix = dir === '/' ? '/' : `${dir}/`;
    const out: Record<string, string> = {};
    for (const [p, text] of this.files) if (p.startsWith(prefix)) out[p.slice(prefix.length)] = text;
    return out;
  }
}

export interface ShellIO {
  stdin: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export interface CommandContext {
  env: Record<string, string>;
  cwd: string;
  fs: VirtualFS;
  io: ShellIO;
  /** Runs a command line in the same shell (npm scripts use this). */
  exec: (script: string, io?: Partial<ShellIO>) => Promise<number>;
  signal?: AbortSignal;
}

export type Command = (args: string[], ctx: CommandContext) => number | Promise<number>;

export class ShellExit extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`exit ${code}`);
    this.code = code;
  }
}

export class ShellSyntaxError extends Error {}

// ---- Parsing -------------------------------------------------------------------

type Token =
  | { kind: 'word'; raw: string; quoted: boolean }
  | { kind: 'op'; value: string }
  | { kind: 'heredoc'; body: string; expand: boolean; strip: boolean };

const OPS = ['&&', '||', ';;', '2>&1', '&>>', '&>', '2>>', '2>', '>>', '>|', '>', '<<-', '<<', '<', '|', ';', '&', '(', ')', '\n'];

function tokenize(script: string): Token[] {
  const tokens: Token[] = [];
  const pendingHeredocs: { delimiter: string; expand: boolean; strip: boolean; token: Token & { kind: 'heredoc' } }[] = [];
  let i = 0;
  const src = script.replace(/\\\r?\n/g, '');
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\r') {
      i++;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '\n' && pendingHeredocs.length) {
      tokens.push({ kind: 'op', value: '\n' });
      i++;
      for (const h of pendingHeredocs) {
        const lines: string[] = [];
        for (;;) {
          if (i >= src.length) break;
          const end = src.indexOf('\n', i);
          const line = src.slice(i, end < 0 ? src.length : end);
          i = end < 0 ? src.length : end + 1;
          if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delimiter) break;
          lines.push(h.strip ? line.replace(/^\t+/, '') : line);
        }
        h.token.body = lines.length ? `${lines.join('\n')}\n` : '';
      }
      pendingHeredocs.length = 0;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    // "2>" is only a redirection at the start of a word.
    if (op && !(op.startsWith('2') && i > 0 && !/\s/.test(src[i - 1]))) {
      i += op.length;
      if (op === '<<' || op === '<<-') {
        while (src[i] === ' ' || src[i] === '\t') i++;
        const m = /^(['"]?)([\w.-]+)\1/.exec(src.slice(i));
        if (!m) throw new ShellSyntaxError('A here-document needs a delimiter word');
        i += m[0].length;
        const token = { kind: 'heredoc' as const, body: '', expand: !m[1], strip: op === '<<-' };
        tokens.push(token);
        pendingHeredocs.push({ delimiter: m[2], expand: !m[1], strip: op === '<<-', token });
        continue;
      }
      tokens.push({ kind: 'op', value: op });
      continue;
    }
    // A word: runs until unquoted whitespace or an operator.
    let raw = '';
    let quoted = false;
    while (i < src.length) {
      const ch = src[i];
      if (/[\s;&|<>()]/.test(ch) && ch !== '\u00a0') {
        break;
      }
      if (ch === '\\') {
        raw += src.slice(i, i + 2);
        i += 2;
        quoted = true;
      } else if (ch === "'") {
        const end = src.indexOf("'", i + 1);
        if (end < 0) throw new ShellSyntaxError('Unterminated single quote');
        raw += src.slice(i, end + 1);
        i = end + 1;
        quoted = true;
      } else if (ch === '"') {
        let j = i + 1;
        while (j < src.length && src[j] !== '"') {
          if (src[j] === '\\') j++;
          else if (src.startsWith('$(', j)) j = matchParen(src, j + 1);
          j++;
        }
        if (j >= src.length) throw new ShellSyntaxError('Unterminated double quote');
        raw += src.slice(i, j + 1);
        i = j + 1;
        quoted = true;
      } else if (src.startsWith('$(', i)) {
        const end = matchParen(src, i + 1);
        raw += src.slice(i, end + 1);
        i = end + 1;
      } else if (src.startsWith('${', i)) {
        const end = src.indexOf('}', i);
        if (end < 0) throw new ShellSyntaxError('Unterminated ${');
        raw += src.slice(i, end + 1);
        i = end + 1;
      } else {
        raw += ch;
        i++;
      }
    }
    tokens.push({ kind: 'word', raw, quoted });
  }
  return tokens;
}

/** The index of the ')' that closes the '(' at `open`. */
function matchParen(src: string, open: number): number {
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    const ch = src[j];
    if (ch === '\\') j++;
    else if (ch === "'") j = src.indexOf("'", j + 1);
    else if (ch === '"') {
      j++;
      while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1;
    } else if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return j;
    if (j < 0) break;
  }
  throw new ShellSyntaxError('Unterminated $(');
}

interface Redirect {
  op: string;
  target?: string;
  heredoc?: { body: string; expand: boolean };
}

type Node =
  | { type: 'simple'; assignments: string[]; words: string[]; redirects: Redirect[] }
  | { type: 'pipeline'; commands: Node[]; negate: boolean }
  | { type: 'and_or'; first: Node; rest: { op: '&&' | '||'; node: Node }[] }
  | { type: 'list'; items: Node[] }
  | { type: 'if'; branches: { condition: Node; body: Node }[]; otherwise?: Node }
  | { type: 'for'; name: string; words: string[] | null; body: Node }
  | { type: 'while'; until: boolean; condition: Node; body: Node }
  | { type: 'group'; body: Node; subshell: boolean; redirects: Redirect[] }
  | { type: 'function'; name: string; body: Node };

/** Reserved words that end a command list. */
const TERMINATORS = new Set(['then', 'elif', 'else', 'fi', 'do', 'done', '}']);

function parseScript(script: string): Node {
  const tokens = tokenize(script);
  let pos = 0;
  const peek = () => tokens[pos];
  const isWord = (value: string) => {
    const t = peek();
    return t?.kind === 'word' && !t.quoted && t.raw === value;
  };
  const isOp = (value: string) => {
    const t = peek();
    return t?.kind === 'op' && t.value === value;
  };
  const skipNewlines = () => {
    while (isOp('\n') || isOp(';')) pos++;
  };
  const expectWord = (value: string) => {
    skipNewlines();
    if (!isWord(value)) throw new ShellSyntaxError(`Expected '${value}'`);
    pos++;
  };

  function list(terminators: string[]): Node {
    const items: Node[] = [];
    for (;;) {
      skipNewlines();
      const t = peek();
      if (!t || (t.kind === 'word' && !t.quoted && terminators.includes(t.raw)) || (t.kind === 'op' && t.value === ')' && terminators.includes(')'))) break;
      items.push(andOr());
      if (isOp('&')) pos++; // Background jobs run in the foreground here.
    }
    return { type: 'list', items };
  }

  function andOr(): Node {
    const first = pipeline();
    const rest: { op: '&&' | '||'; node: Node }[] = [];
    while (isOp('&&') || isOp('||')) {
      const op = (tokens[pos++] as { value: '&&' | '||' }).value;
      while (isOp('\n')) pos++;
      rest.push({ op, node: pipeline() });
    }
    return rest.length ? { type: 'and_or', first, rest } : first;
  }

  function pipeline(): Node {
    let negate = false;
    if (isWord('!')) {
      pos++;
      negate = true;
    }
    const commands = [command()];
    while (isOp('|')) {
      pos++;
      while (isOp('\n')) pos++;
      commands.push(command());
    }
    return commands.length === 1 && !negate ? commands[0] : { type: 'pipeline', commands, negate };
  }

  function redirects(): Redirect[] {
    const out: Redirect[] = [];
    for (;;) {
      const t = peek();
      if (t?.kind === 'heredoc') {
        pos++;
        out.push({ op: '<<', heredoc: t });
      } else if (t?.kind === 'op' && ['>', '>>', '>|', '<', '2>', '2>>', '&>', '&>>'].includes(t.value)) {
        pos++;
        const target = tokens[pos++];
        if (target?.kind !== 'word') throw new ShellSyntaxError(`Expected a file name after ${t.value}`);
        out.push({ op: t.value, target: target.raw });
      } else if (t?.kind === 'op' && t.value === '2>&1') {
        pos++;
        out.push({ op: '2>&1' });
      } else return out;
    }
  }

  function command(): Node {
    if (isWord('if')) {
      pos++;
      const branches: { condition: Node; body: Node }[] = [];
      let otherwise: Node | undefined;
      const condition = list(['then']);
      expectWord('then');
      branches.push({ condition, body: list(['elif', 'else', 'fi']) });
      for (;;) {
        if (isWord('elif')) {
          pos++;
          const c = list(['then']);
          expectWord('then');
          branches.push({ condition: c, body: list(['elif', 'else', 'fi']) });
        } else if (isWord('else')) {
          pos++;
          otherwise = list(['fi']);
        } else break;
      }
      expectWord('fi');
      return { type: 'if', branches, otherwise };
    }
    if (isWord('for')) {
      pos++;
      const name = tokens[pos++];
      if (name?.kind !== 'word') throw new ShellSyntaxError('Expected a variable name after for');
      let words: string[] | null = null;
      while (isOp('\n')) pos++;
      if (isWord('in')) {
        pos++;
        words = [];
        while (peek()?.kind === 'word' && !isWord('do')) words.push((tokens[pos++] as { raw: string }).raw);
      }
      expectWord('do');
      const body = list(['done']);
      expectWord('done');
      return { type: 'for', name: name.raw, words, body };
    }
    if (isWord('while') || isWord('until')) {
      const until = isWord('until');
      pos++;
      const condition = list(['do']);
      expectWord('do');
      const body = list(['done']);
      expectWord('done');
      return { type: 'while', until, condition, body };
    }
    if (isWord('{')) {
      pos++;
      const body = list(['}']);
      expectWord('}');
      return { type: 'group', body, subshell: false, redirects: redirects() };
    }
    if (isOp('(')) {
      pos++;
      const body = list([')']);
      skipNewlines();
      if (!isOp(')')) throw new ShellSyntaxError("Expected ')'");
      pos++;
      return { type: 'group', body, subshell: true, redirects: redirects() };
    }
    // name() { ...; }
    const t = peek();
    if (t?.kind === 'word' && tokens[pos + 1]?.kind === 'op' && (tokens[pos + 1] as { value: string }).value === '(' &&
      tokens[pos + 2]?.kind === 'op' && (tokens[pos + 2] as { value: string }).value === ')') {
      pos += 3;
      while (isOp('\n')) pos++;
      return { type: 'function', name: t.raw, body: command() };
    }

    const assignments: string[] = [];
    const words: string[] = [];
    const redirs: Redirect[] = [];
    for (;;) {
      redirs.push(...redirects());
      const w = peek();
      if (w?.kind !== 'word') break;
      if (!words.length && !w.quoted && TERMINATORS.has(w.raw)) break;
      pos++;
      if (!words.length && /^[A-Za-z_]\w*=/.test(w.raw)) assignments.push(w.raw);
      else words.push(w.raw);
    }
    if (!words.length && !assignments.length && !redirs.length) {
      const bad = peek();
      throw new ShellSyntaxError(`Unexpected ${bad?.kind === 'op' ? `'${bad.value.replace('\n', 'newline')}'` : bad?.kind === 'word' ? `'${bad.raw}'` : 'end of script'}`);
    }
    return { type: 'simple', assignments, words, redirects: redirs };
  }

  const root = list([]);
  if (pos < tokens.length) throw new ShellSyntaxError(`Unexpected '${(tokens[pos] as { raw?: string; value?: string }).raw ?? (tokens[pos] as { value: string }).value}'`);
  return root;
}

// ---- Running -------------------------------------------------------------------

export interface ShellOptions {
  fs: VirtualFS;
  env: Record<string, string>;
  cwd: string;
  commands?: Record<string, Command>;
  /** `set -e`: stop at the first failing command (GitHub's default for bash). */
  errexit?: boolean;
  signal?: AbortSignal;
}

class ErrExit extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`exit ${code}`);
    this.code = code;
  }
}

export class Shell {
  env: Record<string, string>;
  cwd: string;
  readonly fs: VirtualFS;
  private commands: Record<string, Command>;
  private functions = new Map<string, Node>();
  private errexit: boolean;
  private status = 0;
  private signal?: AbortSignal;
  private positional: string[] = [];
  /** The status of the last $(…) substitution: an assignment alone exits with it. */
  private substitutionStatus = 0;

  constructor(options: ShellOptions) {
    this.fs = options.fs;
    this.env = { ...options.env };
    this.cwd = options.cwd;
    this.commands = { ...BUILTINS, ...options.commands };
    this.errexit = options.errexit ?? true;
    this.signal = options.signal;
  }

  /** Runs a script; resolves to its exit status. */
  async run(script: string, io: ShellIO): Promise<number> {
    let tree: Node;
    try {
      tree = parseScript(script);
    } catch (error) {
      io.stderr(`bash: syntax error: ${(error as Error).message}\n`);
      return 2;
    }
    try {
      return await this.exec(tree, io, true);
    } catch (error) {
      if (error instanceof ShellExit || error instanceof ErrExit) return error.code;
      throw error;
    }
  }

  private async exec(node: Node, io: ShellIO, checked: boolean): Promise<number> {
    if (this.signal?.aborted) throw new ShellExit(130);
    switch (node.type) {
      case 'list': {
        let status = 0;
        for (const item of node.items) status = await this.exec(item, io, checked);
        return status;
      }
      case 'and_or': {
        // Only the last command of a && / || chain trips set -e.
        let status = await this.exec(node.first, io, false);
        let ranLast = false;
        for (let k = 0; k < node.rest.length; k++) {
          const { op, node: next } = node.rest[k];
          ranLast = false;
          if ((op === '&&') === (status === 0)) {
            status = await this.exec(next, io, false);
            ranLast = k === node.rest.length - 1;
          }
        }
        return this.check(status, checked && ranLast);
      }
      case 'pipeline': {
        let input = io.stdin;
        let status = 0;
        for (let i = 0; i < node.commands.length; i++) {
          const lastStage = i === node.commands.length - 1;
          let captured = '';
          const stageIO: ShellIO = {
            stdin: input,
            stdout: lastStage ? io.stdout : (t) => (captured += t),
            stderr: io.stderr,
          };
          status = await this.exec(node.commands[i], stageIO, false);
          input = captured;
        }
        if (node.negate) return (this.status = status === 0 ? 1 : 0);
        return this.check(status, checked);
      }
      case 'if': {
        for (const branch of node.branches) {
          if ((await this.exec(branch.condition, io, false)) === 0) return this.exec(branch.body, io, checked);
        }
        return node.otherwise ? this.exec(node.otherwise, io, checked) : (this.status = 0);
      }
      case 'for': {
        const values = node.words === null ? this.positional : (await Promise.all(node.words.map((w) => this.expand(w, io)))).flat();
        let status = 0;
        for (const value of values) {
          this.env[node.name] = value;
          status = await this.exec(node.body, io, checked);
        }
        return (this.status = status);
      }
      case 'while': {
        let status = 0;
        for (let guard = 0; ; guard++) {
          if (guard > 100_000) throw new ShellExit(124);
          const ok = (await this.exec(node.condition, io, false)) === 0;
          if (ok === node.until) break;
          status = await this.exec(node.body, io, checked);
        }
        return (this.status = status);
      }
      case 'group': {
        const target = await this.redirect(node.redirects, io);
        if (!target) return this.check(1, checked);
        if (node.subshell) {
          const env = { ...this.env };
          const cwd = this.cwd;
          try {
            return await this.exec(node.body, target.io, checked);
          } catch (error) {
            if (error instanceof ShellExit || error instanceof ErrExit) return this.check(error.code, checked);
            throw error;
          } finally {
            this.env = env;
            this.cwd = cwd;
            target.flush();
          }
        }
        try {
          return await this.exec(node.body, target.io, checked);
        } finally {
          target.flush();
        }
      }
      case 'function':
        this.functions.set(node.name, node.body);
        return (this.status = 0);
      case 'simple':
        return this.check(await this.simple(node, io), checked);
    }
  }

  private check(status: number, checked: boolean): number {
    this.status = status;
    if (status !== 0 && checked && this.errexit) throw new ErrExit(status);
    return status;
  }

  private async simple(node: Node & { type: 'simple' }, io: ShellIO): Promise<number> {
    this.substitutionStatus = 0;
    const words = (await Promise.all(node.words.map((w) => this.expand(w, io)))).flat();
    const assigned: Record<string, string> = {};
    for (const a of node.assignments) {
      const eq = a.indexOf('=');
      assigned[a.slice(0, eq)] = (await this.expand(a.slice(eq + 1), io, false)).join(' ');
    }
    if (!words.length) {
      Object.assign(this.env, assigned);
      const target = await this.redirect(node.redirects, io);
      target?.flush();
      return target ? this.substitutionStatus : 1;
    }
    const target = await this.redirect(node.redirects, io);
    if (!target) return 1;
    const [name, ...args] = words;
    // VAR=value cmd sets VAR for that command only.
    const saved = Object.keys(assigned).map((k) => [k, this.env[k]] as const);
    Object.assign(this.env, assigned);
    try {
      const fn = this.functions.get(name);
      if (fn) {
        const positional = this.positional;
        this.positional = args;
        try {
          return await this.exec(fn, target.io, true);
        } catch (error) {
          if (error instanceof ErrExit) return error.code;
          throw error;
        } finally {
          this.positional = positional;
        }
      }
      if (name === 'set') return this.set(args);
      const command = this.commands[name];
      if (!command) {
        target.io.stderr(`bash: ${name}: command not found\n`);
        return 127;
      }
      const ctx: CommandContext = {
        env: this.env,
        cwd: this.cwd,
        fs: this.fs,
        io: target.io,
        signal: this.signal,
        exec: (script, partial) => this.run(script, { ...target.io, ...partial }),
      };
      const status = await command(args, ctx);
      // cd and export change the shell itself.
      this.cwd = ctx.cwd;
      return status;
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete this.env[k];
        else this.env[k] = v;
      }
      target.flush();
    }
  }

  private set(args: string[]): number {
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-o' || a === '+o') {
        if (args[i + 1] === 'errexit') this.errexit = a === '-o';
        i++;
      } else if (/^-[a-z]*e/.test(a)) this.errexit = true;
      else if (/^\+[a-z]*e/.test(a)) this.errexit = false;
    }
    return 0;
  }

  /** Applies redirections; returns the IO to use and a flush for files written. */
  private async redirect(redirects: Redirect[], io: ShellIO): Promise<{ io: ShellIO; flush: () => void } | null> {
    if (!redirects.length) return { io, flush: () => {} };
    let stdin = io.stdin;
    let stdout = io.stdout;
    let stderr = io.stderr;
    const writes: { path: string; append: boolean; text: string }[] = [];
    let mergeErr = false;
    for (const r of redirects) {
      if (r.op === '2>&1') {
        mergeErr = true;
        continue;
      }
      if (r.op === '<<') {
        stdin = r.heredoc!.expand ? await this.expandString(r.heredoc!.body, io) : r.heredoc!.body;
        continue;
      }
      const target = (await this.expand(r.target!, io, false)).join(' ');
      if (target === '/dev/null') {
        if (r.op.startsWith('2')) stderr = () => {};
        else if (r.op.startsWith('&')) stdout = stderr = () => {};
        else if (r.op !== '<') stdout = () => {};
        continue;
      }
      const path = VirtualFS.normalize(target, this.cwd);
      if (r.op === '<') {
        const text = this.fs.read(path);
        if (text === undefined) {
          io.stderr(`bash: ${target}: No such file or directory\n`);
          return null;
        }
        stdin = text;
        continue;
      }
      const write = { path, append: r.op.endsWith('>>'), text: '' };
      writes.push(write);
      const sink = (t: string) => (write.text += t);
      if (r.op.startsWith('2')) stderr = sink;
      else if (r.op.startsWith('&')) stdout = stderr = sink;
      else stdout = sink;
    }
    if (mergeErr) stderr = stdout;
    // Truncate now, so `> file` makes an empty file even if nothing is written.
    for (const w of writes) if (!w.append) this.fs.write(w.path, '');
    return {
      io: { stdin, stdout, stderr },
      flush: () => {
        for (const w of writes) this.fs.append(w.path, w.text);
        for (const w of writes) w.text = '';
      },
    };
  }

  // ---- Expansion ---------------------------------------------------------------

  private variable(name: string): string {
    if (name === '?') return String(this.status);
    if (name === '#') return String(this.positional.length);
    if (name === '@' || name === '*') return this.positional.join(' ');
    if (/^\d+$/.test(name)) return name === '0' ? 'bash' : (this.positional[Number(name) - 1] ?? '');
    return this.env[name] ?? '';
  }

  private async parameter(expr: string): Promise<string> {
    const m = /^(#?)([A-Za-z_]\w*|\d+|[?#@*])(?:(:?[-=+?])(.*)|(%%?|##?)(.*)|\/(.*?)\/(.*))?$/s.exec(expr);
    if (!m) throw new ShellExit(1);
    const [, length, name, op, word, trim, pattern, from, to] = m;
    const value = this.variable(name);
    if (length) return String(value.length);
    if (op) {
      const unset = op.startsWith(':') ? value === '' : !(name in this.env);
      const kind = op.slice(-1);
      if (kind === '-') return unset ? word : value;
      if (kind === '=') {
        if (unset) this.env[name] = word;
        return unset ? word : value;
      }
      if (kind === '+') return unset ? '' : word;
      if (kind === '?' && unset) throw new ShellExit(1);
      return value;
    }
    if (trim) {
      const re = globPattern(pattern, trim.length === 2);
      if (trim.startsWith('#')) {
        const mm = new RegExp(`^(?:${re})`).exec(value);
        return mm ? value.slice(mm[0].length) : value;
      }
      const mm = new RegExp(`(?:${re})$`).exec(value);
      return mm ? value.slice(0, value.length - mm[0].length) : value;
    }
    if (from !== undefined) return value.replace(from, to);
    return value;
  }

  private async substitute(script: string, io: ShellIO): Promise<string> {
    let out = '';
    const shell = new Shell({ fs: this.fs, env: this.env, cwd: this.cwd, commands: this.commands, errexit: false, signal: this.signal });
    shell.functions = this.functions;
    this.substitutionStatus = await shell.run(script, { stdin: '', stdout: (t) => (out += t), stderr: io.stderr });
    return out.replace(/\n+$/, '');
  }

  /** Expands $ in a here-document or double-quoted string. */
  private async expandString(text: string, io: ShellIO): Promise<string> {
    let out = '';
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '\\' && /[$`"\\\n]/.test(text[i + 1] ?? '')) {
        out += text[++i];
      } else if (c === '$') {
        const [value, next] = await this.dollar(text, i, io);
        out += value;
        i = next - 1;
      } else out += c;
    }
    return out;
  }

  /** Expands the $… at `i`; returns the value and the index after it. */
  private async dollar(text: string, i: number, io: ShellIO): Promise<[string, number]> {
    if (text.startsWith('$((', i)) {
      const end = text.indexOf('))', i);
      const expr = await this.expandString(text.slice(i + 3, end), io);
      return [String(arithmetic(expr, this.env)), end + 2];
    }
    if (text.startsWith('$(', i)) {
      const end = matchParen(text, i + 1);
      return [await this.substitute(text.slice(i + 2, end), io), end + 1];
    }
    if (text.startsWith('${', i)) {
      const end = text.indexOf('}', i);
      return [await this.parameter(text.slice(i + 2, end)), end + 1];
    }
    const m = /^(?:[A-Za-z_]\w*|\d|[?#@*])/.exec(text.slice(i + 1));
    if (!m) return ['$', i + 1];
    return [this.variable(m[0]), i + 1 + m[0].length];
  }

  /** Expands a raw word into fields: quotes removed, $ expanded, unquoted results split on spaces. */
  async expand(raw: string, io: ShellIO, split = true): Promise<string[]> {
    const fields: string[] = [];
    let current = '';
    let hasField = false;
    const pushSplit = (text: string) => {
      if (!split) {
        current += text;
        return;
      }
      const parts = text.split(/[ \t\n]+/);
      parts.forEach((part, k) => {
        if (k > 0 && (current || hasField)) {
          fields.push(current);
          current = '';
          hasField = false;
        }
        current += part;
      });
    };
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      if (c === '\\') {
        current += raw[++i] ?? '';
        hasField = true;
      } else if (c === "'") {
        const end = raw.indexOf("'", i + 1);
        current += raw.slice(i + 1, end);
        hasField = true;
        i = end;
      } else if (c === '"') {
        let j = i + 1;
        while (j < raw.length && raw[j] !== '"') {
          if (raw[j] === '\\') j++;
          else if (raw.startsWith('$(', j)) j = matchParen(raw, j + 1);
          j++;
        }
        current += await this.expandString(raw.slice(i + 1, j), io);
        hasField = true;
        i = j;
      } else if (c === '$') {
        const [value, next] = await this.dollar(raw, i, io);
        pushSplit(value);
        i = next - 1;
      } else if (c === '~' && i === 0 && (raw[1] === undefined || raw[1] === '/')) {
        current += this.env.HOME ?? '/home/runner';
      } else {
        current += c;
      }
    }
    if (current || hasField) fields.push(current);
    // Globs: expand * in unquoted words against the file system.
    if (split && /[*?]/.test(raw) && !/['"\\]/.test(raw)) {
      return fields.flatMap((f) => this.glob(f));
    }
    return fields;
  }

  private glob(pattern: string): string[] {
    if (!/[*?]/.test(pattern)) return [pattern];
    const absolute = pattern.startsWith('/');
    const base = absolute ? '/' : this.cwd;
    const re = new RegExp(`^${globPattern(pattern, true).replace(/\.\*/g, '[^/]*')}$`);
    const all = Object.keys(this.fs.filesUnder(base));
    const dirs = new Set<string>();
    for (const f of all) {
      const parts = f.split('/');
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
    }
    const matches = [...all, ...dirs].filter((p) => re.test(absolute ? `/${p}` : p)).sort();
    return matches.length ? matches.map((p) => (absolute ? `/${p}` : p)) : [pattern];
  }
}

function globPattern(pattern: string, greedy: boolean): string {
  return pattern
    .split('')
    .map((c) => (c === '*' ? (greedy ? '.*' : '.*?') : c === '?' ? '.' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
    .join('');
}

/** $(( )) with integers: + - * / % and parentheses, and variables by name. */
export function arithmetic(expr: string, env: Record<string, string>): number {
  const tokens = expr.match(/\d+|[A-Za-z_]\w*|[-+*/%()]|==|!=|<=|>=|<|>/g) ?? [];
  let pos = 0;
  const atom = (): number => {
    const t = tokens[pos++];
    if (t === '(') {
      const v = sum();
      pos++;
      return v;
    }
    if (t === '-') return -atom();
    if (t === '+') return atom();
    if (t === undefined) return 0;
    if (/^\d+$/.test(t)) return Number(t);
    return Number(env[t] ?? 0) || 0;
  };
  const product = (): number => {
    let v = atom();
    while (['*', '/', '%'].includes(tokens[pos])) {
      const op = tokens[pos++];
      const r = atom();
      v = op === '*' ? v * r : op === '/' ? Math.trunc(v / r) : v % r;
    }
    return v;
  };
  const sum = (): number => {
    let v = product();
    while (tokens[pos] === '+' || tokens[pos] === '-') {
      const op = tokens[pos++];
      const r = product();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  };
  const comparison = (): number => {
    const v = sum();
    const op = tokens[pos];
    if (!['==', '!=', '<', '>', '<=', '>='].includes(op)) return v;
    pos++;
    const r = sum();
    return Number(op === '==' ? v === r : op === '!=' ? v !== r : op === '<' ? v < r : op === '>' ? v > r : op === '<=' ? v <= r : v >= r);
  };
  return comparison();
}

// ---- Builtins ------------------------------------------------------------------

const resolve = (ctx: CommandContext, path: string) => VirtualFS.normalize(path, ctx.cwd);

function unescape(text: string): string {
  return text.replace(/\\(n|t|r|\\|e|0)/g, (_, c) => ({ n: '\n', t: '\t', r: '\r', '\\': '\\', e: '\u001b', 0: '' })[c as 'n']);
}

function test(args: string[], ctx: CommandContext): boolean {
  if (!args.length) return false;
  if (args[0] === '!') return !test(args.slice(1), ctx);
  const and = args.indexOf('-a');
  if (and > 0) return test(args.slice(0, and), ctx) && test(args.slice(and + 1), ctx);
  const or = args.indexOf('-o');
  if (or > 0) return test(args.slice(0, or), ctx) || test(args.slice(or + 1), ctx);
  if (args.length === 1) return args[0] !== '';
  if (args.length === 2) {
    const [op, value] = args;
    const path = resolve(ctx, value);
    switch (op) {
      case '-z':
        return value === '';
      case '-n':
        return value !== '';
      case '-f':
        return ctx.fs.isFile(path);
      case '-d':
        return ctx.fs.isDir(path);
      case '-e':
        return ctx.fs.isFile(path) || ctx.fs.isDir(path);
      case '-s':
        return !!ctx.fs.read(path);
      case '-x':
      case '-r':
      case '-w':
        return ctx.fs.isFile(path);
    }
    return false;
  }
  const [a, op, b] = args;
  switch (op) {
    case '=':
    case '==':
      return a === b;
    case '!=':
      return a !== b;
    case '-eq':
      return Number(a) === Number(b);
    case '-ne':
      return Number(a) !== Number(b);
    case '-lt':
      return Number(a) < Number(b);
    case '-le':
      return Number(a) <= Number(b);
    case '-gt':
      return Number(a) > Number(b);
    case '-ge':
      return Number(a) >= Number(b);
  }
  return false;
}

function flags(args: string[]): { flags: Set<string>; rest: string[] } {
  const set = new Set<string>();
  const rest: string[] = [];
  let done = false;
  for (const a of args) {
    if (!done && a === '--') done = true;
    else if (!done && /^-[A-Za-z]+$/.test(a)) for (const f of a.slice(1)) set.add(f);
    else rest.push(a);
  }
  return { flags: set, rest };
}

function readInput(args: string[], ctx: CommandContext, name: string): string | null {
  if (!args.length) return ctx.io.stdin;
  let text = '';
  for (const a of args) {
    const content = a === '-' ? ctx.io.stdin : ctx.fs.read(resolve(ctx, a));
    if (content === undefined) {
      ctx.io.stderr(`${name}: ${a}: No such file or directory\n`);
      return null;
    }
    text += content;
  }
  return text;
}

const lines = (text: string) => (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');

export const BUILTINS: Record<string, Command> = {
  true: () => 0,
  false: () => 1,
  ':': () => 0,
  exit: (args) => {
    throw new ShellExit(args.length ? Number(args[0]) || 0 : 0);
  },
  echo: (args, ctx) => {
    let newline = true;
    let escapes = false;
    while (/^-[neE]+$/.test(args[0] ?? '')) {
      const f = args.shift()!;
      if (f.includes('n')) newline = false;
      if (f.includes('e')) escapes = true;
    }
    const text = args.join(' ');
    ctx.io.stdout((escapes ? unescape(text) : text) + (newline ? '\n' : ''));
    return 0;
  },
  printf: (args, ctx) => {
    const [format = '', ...values] = args;
    let out = '';
    let k = 0;
    // Like bash, the format repeats until every argument is used.
    do {
      out += unescape(format).replace(/%([-0-9.]*)([sdfx%])/g, (_, _width, conv: string) => {
        if (conv === '%') return '%';
        const v = values[k++] ?? '';
        if (conv === 'd') return String(Math.trunc(Number(v) || 0));
        if (conv === 'f') return (Number(v) || 0).toFixed(6);
        if (conv === 'x') return (Math.trunc(Number(v) || 0)).toString(16);
        return v;
      });
    } while (k < values.length && /%[sdfx]/.test(format));
    ctx.io.stdout(out);
    return 0;
  },
  cd: (args, ctx) => {
    const target = resolve(ctx, args[0] ?? ctx.env.HOME ?? '/');
    if (!ctx.fs.isDir(target)) {
      ctx.io.stderr(`cd: ${args[0]}: No such file or directory\n`);
      return 1;
    }
    ctx.cwd = target;
    ctx.env.PWD = target;
    return 0;
  },
  pwd: (_args, ctx) => {
    ctx.io.stdout(`${ctx.cwd}\n`);
    return 0;
  },
  export: (args, ctx) => {
    for (const a of args) {
      const eq = a.indexOf('=');
      if (eq > 0) ctx.env[a.slice(0, eq)] = a.slice(eq + 1);
      else if (!(a in ctx.env)) ctx.env[a] = '';
    }
    return 0;
  },
  unset: (args, ctx) => {
    for (const a of args) delete ctx.env[a];
    return 0;
  },
  env: (_args, ctx) => {
    ctx.io.stdout(Object.entries(ctx.env).map(([k, v]) => `${k}=${v}\n`).join(''));
    return 0;
  },
  test: (args, ctx) => (test(args, ctx) ? 0 : 1),
  '[': (args, ctx) => {
    if (args[args.length - 1] !== ']') {
      ctx.io.stderr("[: missing ']'\n");
      return 2;
    }
    return test(args.slice(0, -1), ctx) ? 0 : 1;
  },
  '[[': (args, ctx) => (test(args.slice(0, -1), ctx) ? 0 : 1),
  sleep: () => 0,
  wait: () => 0,
  shopt: () => 0,
  trap: () => 0,
  ulimit: () => 0,
  cat: (args, ctx) => {
    const text = readInput(flags(args).rest, ctx, 'cat');
    if (text === null) return 1;
    ctx.io.stdout(text);
    return 0;
  },
  tee: (args, ctx) => {
    const { flags: f, rest } = flags(args);
    for (const file of rest) {
      const path = resolve(ctx, file);
      if (f.has('a')) ctx.fs.append(path, ctx.io.stdin);
      else ctx.fs.write(path, ctx.io.stdin);
    }
    ctx.io.stdout(ctx.io.stdin);
    return 0;
  },
  ls: (args, ctx) => {
    const { flags: f, rest } = flags(args);
    const targets = rest.length ? rest : ['.'];
    let status = 0;
    for (const t of targets) {
      const path = resolve(ctx, t);
      if (ctx.fs.isFile(path)) ctx.io.stdout(`${t}\n`);
      else if (ctx.fs.isDir(path)) {
        const names = ctx.fs.list(path).filter((n) => f.has('a') || !n.startsWith('.'));
        if (targets.length > 1) ctx.io.stdout(`${t}:\n`);
        ctx.io.stdout(names.map((n) => `${n}\n`).join(''));
      } else {
        ctx.io.stderr(`ls: cannot access '${t}': No such file or directory\n`);
        status = 2;
      }
    }
    return status;
  },
  mkdir: (args, ctx) => {
    for (const d of flags(args).rest) ctx.fs.mkdir(resolve(ctx, d));
    return 0;
  },
  touch: (args, ctx) => {
    for (const f of flags(args).rest) {
      const path = resolve(ctx, f);
      if (!ctx.fs.isFile(path)) ctx.fs.write(path, '');
    }
    return 0;
  },
  rm: (args, ctx) => {
    const { flags: f, rest } = flags(args);
    let status = 0;
    for (const t of rest) {
      if (!ctx.fs.remove(resolve(ctx, t), f.has('r') || f.has('R')) && !f.has('f')) {
        ctx.io.stderr(`rm: cannot remove '${t}': No such file or directory\n`);
        status = 1;
      }
    }
    return status;
  },
  cp: (args, ctx) => {
    const { flags: f, rest } = flags(args);
    if (rest.length < 2) return 1;
    const dest = resolve(ctx, rest[rest.length - 1]);
    for (const s of rest.slice(0, -1)) {
      const src = resolve(ctx, s);
      const name = src.split('/').pop()!;
      if (ctx.fs.isFile(src)) {
        ctx.fs.write(ctx.fs.isDir(dest) ? `${dest}/${name}` : dest, ctx.fs.read(src)!);
      } else if (ctx.fs.isDir(src) && (f.has('r') || f.has('R'))) {
        const into = ctx.fs.isDir(dest) ? `${dest}/${name}` : dest;
        for (const [p, text] of Object.entries(ctx.fs.filesUnder(src))) ctx.fs.write(`${into}/${p}`, text);
      } else {
        ctx.io.stderr(`cp: cannot stat '${s}'\n`);
        return 1;
      }
    }
    return 0;
  },
  mv: async (args, ctx) => {
    const status = await BUILTINS.cp(['-r', ...args], ctx);
    if (status === 0) for (const s of flags(args).rest.slice(0, -1)) ctx.fs.remove(resolve(ctx, s), true);
    return status;
  },
  grep: (args, ctx) => {
    const { flags: f, rest } = flags(args);
    const [pattern, ...files] = rest;
    if (pattern === undefined) return 2;
    const text = readInput(files, ctx, 'grep');
    if (text === null) return 2;
    let re: RegExp;
    try {
      re = new RegExp(f.has('F') ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : pattern, f.has('i') ? 'i' : '');
    } catch {
      return 2;
    }
    const matched = lines(text).filter((l) => re.test(l) !== f.has('v'));
    if (f.has('c')) ctx.io.stdout(`${matched.length}\n`);
    else if (!f.has('q')) ctx.io.stdout(matched.map((l) => `${l}\n`).join(''));
    return matched.length ? 0 : 1;
  },
  head: (args, ctx) => {
    const n = args[0] === '-n' ? Number(args[1]) : /^-\d+$/.test(args[0] ?? '') ? Number(args[0].slice(1)) : 10;
    const files = args.filter((a, i) => !a.startsWith('-') && args[i - 1] !== '-n');
    const text = readInput(files, ctx, 'head');
    if (text === null) return 1;
    ctx.io.stdout(lines(text).slice(0, n).map((l) => `${l}\n`).join(''));
    return 0;
  },
  tail: (args, ctx) => {
    const n = args[0] === '-n' ? Number(args[1]) : /^-\d+$/.test(args[0] ?? '') ? Number(args[0].slice(1)) : 10;
    const files = args.filter((a, i) => !a.startsWith('-') && args[i - 1] !== '-n');
    const text = readInput(files, ctx, 'tail');
    if (text === null) return 1;
    ctx.io.stdout(lines(text).slice(-n).map((l) => `${l}\n`).join(''));
    return 0;
  },
  wc: (args, ctx) => {
    const { flags: f, rest } = flags(args);
    const text = readInput(rest, ctx, 'wc');
    if (text === null) return 1;
    const counts = { l: (text.match(/\n/g) ?? []).length, w: text.split(/\s+/).filter(Boolean).length, c: text.length };
    const pick = f.size ? (['l', 'w', 'c'] as const).filter((k) => f.has(k)) : (['l', 'w', 'c'] as const);
    ctx.io.stdout(`${pick.map((k) => counts[k]).join(' ')}\n`);
    return 0;
  },
  basename: (args, ctx) => {
    ctx.io.stdout(`${(args[0] ?? '').replace(/\/+$/, '').split('/').pop()!.replace(args[1] ?? '\u0000', '')}\n`);
    return 0;
  },
  dirname: (args, ctx) => {
    const parts = (args[0] ?? '').replace(/\/+$/, '').split('/');
    ctx.io.stdout(`${parts.length > 1 ? parts.slice(0, -1).join('/') || '/' : '.'}\n`);
    return 0;
  },
  date: (args, ctx) => {
    const now = new Date();
    ctx.io.stdout(`${args.includes('+%s') ? Math.floor(now.getTime() / 1000) : now.toUTCString()}\n`);
    return 0;
  },
  uname: (args, ctx) => {
    ctx.io.stdout(args.includes('-a') ? 'Linux tsrs-monaco 6.0.0 x86_64 GNU/Linux (emulated)\n' : 'Linux\n');
    return 0;
  },
  whoami: (_args, ctx) => {
    ctx.io.stdout('runner\n');
    return 0;
  },
};

/** Builtins that look a command up: `command -v`, `which`, `type`. */
export function lookupCommands(available: () => string[]): Record<string, Command> {
  const find: Command = (args, ctx) => {
    const names = args.filter((a) => !a.startsWith('-'));
    let status = 0;
    for (const n of names) {
      if (available().includes(n)) ctx.io.stdout(`/usr/bin/${n}\n`);
      else status = 1;
    }
    return status;
  };
  return {
    which: find,
    type: find,
    command: (args, ctx) => (args[0] === '-v' || args[0] === '-V' ? find(args.slice(1), ctx) : ctx.exec(args.map(quote).join(' '))),
  };
}

/** Quotes a word for the shell. */
export const quote = (word: string) => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`);
