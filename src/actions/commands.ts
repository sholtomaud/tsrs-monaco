// The commands a workflow's `run:` steps call, as thin shims over the
// playground's toolchain: there is no real npm, node or tsc. `tsc` is a tsrs
// type check, `npm test` / `node --test` run *.test.ts in the run worker,
// `npm run` runs package.json scripts (which usually end in those), `npm ci`
// is a no-op (packages load from CDNs), and `npx x` runs x. A little of git
// (status, diff) checks for stale generated files. Tools that can't run in a browser (eslint, docker, apt-get,
// playwright, …) pass with a warning, so the rest of a workflow still runs;
// the run is then marked as only partly emulated.

import { formatProblem, toProblem } from '../compiler/diagnostics.ts';
import { TEST_FILE, outputPathFor, type ProjectFiles } from '../compiler/project.ts';
import { globToRegExp } from './expressions.ts';
import { VirtualFS, quote, type Command, type CommandContext } from './shell.ts';
import type { CompileOutput, Toolchain } from './toolchain.ts';

export interface JobHost {
  toolchain: Toolchain;
  /** GITHUB_WORKSPACE. */
  workspace: string;
  /** The files actions/checkout wrote, for `git diff`/`git status`. */
  checkedOut: () => ProjectFiles | null;
  /** Records a tool the emulator stood in for or skipped. */
  notEmulated: (tool: string, detail: string) => void;
}

const NODE_VERSION = 'v25.0.0';
const NPM_VERSION = '11.6.0';

/** Tools that can't run in the browser: they pass with a warning. */
const UNAVAILABLE: Record<string, string> = {
  eslint: 'linting', oxlint: 'linting', biome: 'linting and formatting', prettier: 'formatting', stylelint: 'linting',
  playwright: 'browser tests', cypress: 'browser tests', puppeteer: 'browser automation',
  docker: 'containers', 'docker-compose': 'containers', apt: 'system packages', 'apt-get': 'system packages',
  brew: 'system packages', pip: 'Python packages', pip3: 'Python packages', python: 'Python', python3: 'Python',
  curl: 'network requests', wget: 'network requests', gh: 'the GitHub CLI', make: 'make', cargo: 'Rust', go: 'Go',
  deno: 'Deno', bun: 'Bun', husky: 'git hooks', 'lint-staged': 'git hooks', changeset: 'changesets', 'semantic-release': 'releases',
};

/** The project a command works on: the files under its working directory. */
function projectAt(ctx: CommandContext, dir = ctx.cwd): ProjectFiles {
  return ctx.fs.filesUnder(dir);
}

function readPackageJson(ctx: CommandContext, dir = ctx.cwd): { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> } | null | 'invalid' {
  const text = ctx.fs.read(`${dir}/package.json`);
  if (text === undefined) return null;
  try {
    return JSON.parse(text);
  } catch {
    return 'invalid';
  }
}

const say = (ctx: CommandContext, text: string) => ctx.io.stdout(`${text}\n`);
const fail = (ctx: CommandContext, text: string, code = 1) => {
  ctx.io.stderr(`${text}\n`);
  return code;
};

function printDiagnostics(ctx: CommandContext, compiled: CompileOutput, dir: string, workspace: string): { errors: number; warnings: number } {
  const prefix = dir === workspace ? '' : `${dir.slice(workspace.length + 1)}/`;
  let errors = 0;
  let warnings = 0;
  const files = new Set<string>();
  for (const d of compiled.diagnostics) {
    const p = toProblem(d);
    if (p.severity === 'error') errors++;
    else if (p.severity === 'warning') warnings++;
    else continue;
    if (p.file) files.add(p.file);
    say(ctx, formatProblem(p));
    // A workflow command, so the run lists it as an annotation.
    const where = p.file ? ` file=${prefix}${p.file},line=${p.startLineNumber},col=${p.startColumn}` : '';
    say(ctx, `::${p.severity === 'error' ? 'error' : 'warning'}${where},title=TS${p.code}::${p.message.split('\n')[0]}`);
  }
  for (const w of compiled.warnings ?? []) say(ctx, `::warning::${w}`);
  if (errors) say(ctx, `\nFound ${errors} error${errors === 1 ? '' : 's'}${files.size ? ` in ${files.size} file${files.size === 1 ? '' : 's'}` : ''}.`);
  return { errors, warnings };
}

function writeOutputs(ctx: CommandContext, dir: string, outputs: Record<string, string>) {
  for (const [path, text] of Object.entries(outputs)) ctx.fs.write(`${dir}/${path}`, text);
}

/** `tsc`: type checks with tsrs, writing the emitted files unless --noEmit. */
async function tsc(args: string[], ctx: CommandContext, host: JobHost): Promise<number> {
  if (args.includes('--version') || args.includes('-v')) {
    say(ctx, `Version ${host.toolchain.typescriptVersion} (${host.toolchain.description})`);
    return 0;
  }
  let config = 'tsconfig.json';
  let noEmit = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-p' || a === '--project') config = args[++i] ?? config;
    else if (a === '-b' || a === '--build') {
      if (args[i + 1] && !args[i + 1].startsWith('-')) config = args[++i];
    } else if (a === '--noEmit') noEmit = true;
    else if (a === '--noEmit=false' || a === '--watch' || a === '-w') {
      if (a !== '--noEmit=false') host.notEmulated('tsc --watch', 'watch mode runs once');
    } else if (a.startsWith('-')) {
      // Other flags (--pretty, --incremental, …) don't change the result here.
      if (!/^--?(pretty|incremental|listFiles|extendedDiagnostics|skipLibCheck|strict|verbose|force)/.test(a)) {
        host.notEmulated(`tsc ${a}`, 'set compiler options in tsconfig.json instead');
      }
      if (args[i + 1] === 'false' || args[i + 1] === 'true') i++;
    } else {
      host.notEmulated('tsc <files>', 'compiling single files ignores tsconfig.json; the project is checked instead');
    }
  }
  let path = VirtualFS.normalize(config, ctx.cwd);
  if (ctx.fs.isDir(path)) path = `${path}/tsconfig.json`;
  const text = ctx.fs.read(path);
  if (text === undefined) return fail(ctx, `error TS5058: The specified path does not exist: '${config}'.`);
  const dir = path.slice(0, path.lastIndexOf('/')) || '/';
  const files = { ...projectAt(ctx, dir), 'tsconfig.json': text };
  const compiled = await host.toolchain.compile(files, ctx.signal);
  const { errors } = printDiagnostics(ctx, compiled, dir, host.workspace);
  let emits = !noEmit;
  if (emits) {
    try {
      emits = !/"noEmit"\s*:\s*true/.test(text);
    } catch {
      // Keep emitting.
    }
  }
  if (emits) writeOutputs(ctx, dir, compiled.outputs);
  return errors ? (emits ? 2 : 1) : 0;
}

/** Test source files (src/**\/*.test.ts) a runner's arguments select. */
function selectTests(files: ProjectFiles, compiled: CompileOutput, patterns: string[]): string[] {
  const all = Object.keys(compiled.outputs).filter((p) => TEST_FILE.test(p)).sort();
  const filters = patterns.filter((p) => !p.startsWith('-')).map((p) => p.replace(/^\.\//, ''));
  if (!filters.length) return all;
  const sources = Object.keys(files).filter((f) => /\.test\.(m|c)?tsx?$/.test(f) || /\.test\.(m|c)?js$/.test(f));
  const chosen = new Set<string>();
  for (const f of filters) {
    const re = /[*?]/.test(f) ? globToRegExp(f) : null;
    for (const s of sources) {
      if (re ? re.test(s) : s === f || s.startsWith(`${f.replace(/\/$/, '')}/`) || s.includes(f)) chosen.add(outputPathFor(s));
    }
    // Patterns can name the emitted files too.
    for (const o of all) if (re ? re.test(o) : o === f) chosen.add(o);
  }
  return all.filter((o) => chosen.has(o));
}

/** Runs the project's tests (test() and expect() from *.test.ts) in the run worker. */
async function runTests(args: string[], ctx: CommandContext, host: JobHost, runner: string): Promise<number> {
  const files = projectAt(ctx);
  if (!Object.keys(files).some((f) => f.endsWith('tsconfig.json'))) {
    return fail(ctx, `${runner}: no tsconfig.json in ${ctx.cwd} (did the workflow check out the repository?)`);
  }
  const compiled = await host.toolchain.compile(files, ctx.signal);
  const errors = compiled.diagnostics.filter((d) => d.category === 1).length;
  if (errors) say(ctx, `(${errors} type error${errors === 1 ? '' : 's'}; tests run anyway, as with a transpile-only runner)`);
  const entries = selectTests(files, compiled, args);
  if (!entries.length) return fail(ctx, `${runner}: no test files found (src/**/*.test.ts)`);
  say(ctx, `Running ${entries.length} test file${entries.length === 1 ? '' : 's'} with ${runner} (emulated in a Web Worker)`);
  const outcome = await host.toolchain.test(files, compiled, entries, (level, text) => {
    (level === 'error' || level === 'warn' ? ctx.io.stderr : ctx.io.stdout)(`${text}\n`);
  }, ctx.signal);
  for (const r of outcome.results) {
    const file = r.file.replace(/^dist\//, 'src/').replace(/\.js$/, '.ts');
    say(ctx, `${r.status === 'pass' ? '✔' : '✖'} ${r.name} (${Math.round(r.durationMs)} ms) — ${file}`);
    if (r.error) {
      ctx.io.stderr(`${r.error.replace(/^/gm, '    ')}\n`);
      say(ctx, `::error file=${file},title=Test failed: ${r.name.replace(/[,:]/g, ' ')}::${r.error.split('\n')[0]}`);
    }
  }
  if (outcome.error) return fail(ctx, `Tests could not run: ${outcome.error}`);
  say(ctx, `ℹ tests ${outcome.passed + outcome.failed}\nℹ pass ${outcome.passed}\nℹ fail ${outcome.failed}`);
  return outcome.failed ? 1 : 0;
}

/** `node file`: runs an emitted module, or a source file through tsrs. */
async function runScript(file: string, ctx: CommandContext, host: JobHost): Promise<number> {
  const files = projectAt(ctx);
  const rel = VirtualFS.normalize(file, ctx.cwd).slice(ctx.cwd.length + 1);
  if (!ctx.fs.isFile(`${ctx.cwd}/${rel}`)) return fail(ctx, `Error: Cannot find module '${file}'`);
  const compiled = await host.toolchain.compile(files, ctx.signal);
  const entry = /\.(m|c)?tsx?$/.test(rel) ? outputPathFor(rel) : rel;
  // A file written by an earlier step (e.g. dist/ from tsc) runs as it is.
  const outputs = { ...compiled.outputs };
  if (!(entry in outputs) && files[entry] !== undefined) outputs[entry] = files[entry];
  if (!(entry in outputs)) return fail(ctx, `Error: ${file} was not emitted by tsrs (is it included by tsconfig.json?)`);
  const outcome = await host.toolchain.run(files, { ...compiled, outputs }, entry, (level, text) => {
    (level === 'error' || level === 'warn' ? ctx.io.stderr : ctx.io.stdout)(`${text}\n`);
  }, ctx.signal);
  if (!outcome.ok) return fail(ctx, outcome.error ?? 'The script failed.');
  return 0;
}


const EVAL_MODULE = 'dist/__node_eval__.js';

/**
 * `node -e` / `node -p`: runs the snippet in the run worker (never on the
 * page), with a require() that reads the workspace's JSON files, so CI
 * one-liners like node -p "require('./package.json').version" work.
 */
async function evaluateInline(code: string, print: boolean, ctx: CommandContext, host: JobHost): Promise<number> {
  const json: Record<string, string> = {};
  for (const [path, text] of Object.entries(ctx.fs.filesUnder(host.workspace))) {
    if (path.endsWith('.json') && !path.includes('node_modules/')) json[`${host.workspace}/${path}`] = text;
  }
  const module = `const __json = ${JSON.stringify(json)};
const __cwd = ${JSON.stringify(ctx.cwd)};
const __resolve = (p) => {
  const parts = [];
  for (const part of (p.startsWith('/') ? p : __cwd + '/' + p).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop(); else parts.push(part);
  }
  return '/' + parts.join('/');
};
const require = (p) => {
  const path = __resolve(p);
  const text = __json[path] ?? __json[path + '.json'];
  if (text === undefined) throw new Error("require('" + p + "') is not emulated: only the workspace's JSON files can be required");
  return JSON.parse(text);
};
const process = { env: ${JSON.stringify(ctx.env)}, argv: ['node'], cwd: () => __cwd, platform: 'linux', version: '${NODE_VERSION}', exitCode: 0,
  exit(code = 0) { throw Object.assign(new Error('process.exit(' + code + ')'), { exitCode: code }); } };
const __dirname = __cwd;
${print ? `console.log((\n${code}\n));` : code}
`;
  const files = projectAt(ctx);
  const outcome = await host.toolchain.run(files, { exitCode: 0, diagnostics: [], outputs: { [EVAL_MODULE]: module } }, EVAL_MODULE, (level, text) => {
    (level === 'error' || level === 'warn' ? ctx.io.stderr : ctx.io.stdout)(`${text}\n`);
  }, ctx.signal);
  if (!outcome.ok) {
    const exit = /process\.exit\((\d+)\)/.exec(outcome.error ?? '');
    if (exit) return Number(exit[1]);
    return fail(ctx, outcome.error ?? 'The script failed.');
  }
  return 0;
}

function node(host: JobHost): Command {
  return async (args, ctx) => {
    if (args[0] === '--version' || args[0] === '-v') {
      say(ctx, NODE_VERSION);
      return 0;
    }
    const rest = [...args];
    while (rest[0]?.startsWith('-') && rest[0] !== '--test' && rest[0] !== '-e' && rest[0] !== '-p' && rest[0] !== '--eval' && rest[0] !== '--print') {
      const flag = rest.shift()!;
      if (['--import', '--require', '-r', '--loader', '--experimental-loader'].includes(flag)) rest.shift();
    }
    if (rest[0] === '--test') return runTests(rest.slice(1), ctx, host, 'node --test');
    if (rest[0] === '-e' || rest[0] === '-p' || rest[0] === '--eval' || rest[0] === '--print') {
      return evaluateInline(rest[1] ?? '', rest[0] === '-p' || rest[0] === '--print', ctx, host);
    }
    if (!rest.length) return fail(ctx, 'node: the REPL is not available.');
    return runScript(rest[0], ctx, host);
  };
}

/** Runs a package.json script (with its pre/post scripts), like npm run. */
async function runScriptNamed(name: string, extra: string[], ctx: CommandContext, tool: string): Promise<number> {
  const pkg = readPackageJson(ctx);
  if (pkg === 'invalid') return fail(ctx, `${tool} error: package.json is not valid JSON`);
  const scripts = pkg?.scripts ?? {};
  if (scripts[name] === undefined) return -1;
  for (const stage of [`pre${name}`, name, `post${name}`]) {
    const script = scripts[stage];
    if (script === undefined) continue;
    const line = stage === name && extra.length ? `${script} ${extra.map(quote).join(' ')}` : script;
    say(ctx, `\n> ${stage}\n> ${line}\n`);
    const env = ctx.env;
    const saved = env.npm_lifecycle_event;
    env.npm_lifecycle_event = stage;
    try {
      const status = await ctx.exec(line);
      if (status !== 0) return status;
    } finally {
      if (saved === undefined) delete env.npm_lifecycle_event;
      else env.npm_lifecycle_event = saved;
    }
  }
  return 0;
}

function install(ctx: CommandContext, tool: string): number {
  const pkg = readPackageJson(ctx);
  if (pkg === 'invalid') return fail(ctx, `${tool} error: package.json is not valid JSON`);
  const deps = pkg ? { ...pkg.dependencies, ...pkg.devDependencies } : {};
  const names = Object.keys(deps);
  say(ctx, names.length
    ? `Emulated: ${names.length} package${names.length === 1 ? '' : 's'} (${names.slice(0, 6).join(', ')}${names.length > 6 ? ', …' : ''}) load from npm CDNs when the code imports them; nothing is installed.`
    : 'Emulated: nothing to install (npm imports load from CDNs when the code runs).');
  return 0;
}

function packageManager(host: JobHost): Command {
  const tool = 'npm';
  return async (args, ctx) => {
    const [sub, ...rest] = args;
    if (sub === '--version' || sub === '-v') {
      say(ctx, NPM_VERSION);
      return 0;
    }
    if (['ci', 'install', 'i', 'add', 'clean-install', 'rebuild', 'prune', 'dedupe'].includes(sub ?? '')) return install(ctx, tool);
    if (sub === 'config' || sub === 'cache' || sub === 'audit' || sub === 'set' || sub === 'fund') {
      say(ctx, `Emulated: ${tool} ${sub} does nothing here.`);
      return 0;
    }
    if (sub === 'exec' || sub === 'dlx' || sub === 'x') return ctx.exec(rest.filter((a) => a !== '--').map(quote).join(' '));
    const scriptArgs = (list: string[]) => (list[0] === '--' ? list.slice(1) : list);
    if (sub === 'test' || sub === 't' || sub === 'tst') {
      const status = await runScriptNamed('test', scriptArgs(rest), ctx, tool);
      // Without a test script, the playground's own test runner stands in.
      if (status === -1) return runTests(scriptArgs(rest), ctx, host, `${tool} test`);
      return status;
    }
    if (sub === 'run' || sub === 'run-script') {
      const [name, ...more] = rest;
      if (!name) {
        const pkg = readPackageJson(ctx);
        const scripts = pkg && pkg !== 'invalid' ? Object.keys(pkg.scripts ?? {}) : [];
        say(ctx, scripts.length ? `Scripts available:\n${scripts.map((s) => `  ${s}`).join('\n')}` : 'No scripts.');
        return 0;
      }
      const status = await runScriptNamed(name, scriptArgs(more), ctx, tool);
      if (status === -1) {
        if (args.includes('--if-present')) return 0;
        return fail(ctx, `${tool} error: Missing script: "${name}"`);
      }
      return status;
    }
    if (sub === 'start') {
      const status = await runScriptNamed('start', scriptArgs(rest), ctx, tool);
      if (status !== -1) return status;
      const pkg = readPackageJson(ctx);
      return fail(ctx, `${tool} error: Missing script: "start"${pkg ? '' : ' (no package.json)'}`);
    }
    host.notEmulated(`${tool} ${sub ?? ''}`.trim(), 'this subcommand is not emulated');
    say(ctx, `::warning title=Not emulated::${tool} ${sub ?? ''} is not emulated in the browser; skipped.`);
    return 0;
  };
}

function npx(): Command {
  return (args, ctx) => {
    const rest = [...args];
    while (rest[0]?.startsWith('-')) {
      const flag = rest.shift()!;
      if (flag === '-p' || flag === '--package') rest.shift();
    }
    if (!rest.length) return fail(ctx, 'npx: a command is required');
    // npx tsc, npx vitest run, npx playwright test, …
    rest[0] = rest[0].replace(/@[^/]*$/, '');
    return ctx.exec(rest.map(quote).join(' '));
  };
}


function git(host: JobHost): Command {
  return (args, ctx) => {
    const [sub, ...rest] = args;
    const original = host.checkedOut();
    const current = () => ctx.fs.filesUnder(host.workspace);
    const changes = () => {
      if (!original) return [];
      const now = current();
      const out: { status: string; path: string }[] = [];
      for (const p of Object.keys({ ...original, ...now }).sort()) {
        if (!(p in now)) out.push({ status: 'D', path: p });
        else if (!(p in original)) out.push({ status: '??', path: p });
        else if (now[p] !== original[p]) out.push({ status: 'M', path: p });
      }
      // Build output is usually ignored.
      const ignored = (ctx.fs.read(`${host.workspace}/.gitignore`) ?? 'node_modules\ndist\n')
        .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
      return out.filter((c) => !ignored.some((g) => {
        const p = g.replace(/^\//, '').replace(/\/$/, '');
        return c.path === p || c.path.startsWith(`${p}/`) || (/[*?]/.test(p) && globToRegExp(p).test(c.path));
      }));
    };
    switch (sub) {
      case 'status': {
        const list = changes();
        if (rest.includes('--porcelain') || rest.includes('-s') || rest.includes('--short')) {
          ctx.io.stdout(list.map((c) => `${c.status.padStart(2)} ${c.path}\n`).join(''));
        } else {
          say(ctx, list.length ? `Changes:\n${list.map((c) => `  ${c.status} ${c.path}`).join('\n')}` : 'nothing to commit, working tree clean');
        }
        return 0;
      }
      case 'diff': {
        const list = changes().filter((c) => c.status !== '??');
        const names = rest.filter((a) => !a.startsWith('-'));
        const shown = names.length ? list.filter((c) => names.some((n) => c.path === n || c.path.startsWith(`${n.replace(/\/$/, '')}/`))) : list;
        if (rest.includes('--name-only') || rest.includes('--stat')) ctx.io.stdout(shown.map((c) => `${c.path}\n`).join(''));
        else for (const c of shown) say(ctx, `diff --git a/${c.path} b/${c.path}\n${c.status === 'D' ? 'deleted file' : 'modified'}`);
        return (rest.includes('--exit-code') || rest.includes('--quiet')) && shown.length ? 1 : 0;
      }
      case 'rev-parse':
        say(ctx, rest.includes('--abbrev-ref') ? (ctx.env.GITHUB_HEAD_REF || ctx.env.GITHUB_REF_NAME || 'main') : ctx.env.GITHUB_SHA ?? '');
        return 0;
      case 'config':
      case 'fetch':
      case 'checkout':
      case 'add':
      case 'reset':
        say(ctx, `Emulated: git ${sub} does nothing here.`);
        return 0;
      case '--version':
        say(ctx, 'git version 2.50.0 (emulated)');
        return 0;
      default:
        host.notEmulated(`git ${sub ?? ''}`.trim(), 'only status, diff and rev-parse are emulated');
        say(ctx, `::warning title=Not emulated::git ${sub ?? ''} is not emulated in the browser; skipped.`);
        return 0;
    }
  };
}

function unavailable(name: string, what: string, host: JobHost): Command {
  return (args, ctx) => {
    if (args[0] === '--version' || args[0] === '-v') {
      say(ctx, `${name} (not available in the browser)`);
      return 0;
    }
    host.notEmulated(name, `${what} can't run in the browser`);
    say(ctx, `::warning title=Not emulated::${[name, ...args].join(' ')}: ${what} can't run in the browser; skipped.`);
    return 0;
  };
}

/** Every tool command, for a job on `host`: thin shims over tsrs and the run worker. */
export function toolCommands(host: JobHost): Record<string, Command> {
  const commands: Record<string, Command> = {
    node: node(host),
    npm: packageManager(host),
    npx: npx(),
    tsc: (args, ctx) => tsc(args, ctx, host),
    git: git(host),
  };
  for (const [name, what] of Object.entries(UNAVAILABLE)) commands[name] = unavailable(name, what, host);
  return commands;
}
