import { test, describe } from 'node:test';
import assert from 'node:assert';
import { evaluate, evaluateCondition, interpolate, type EvalContext } from './expressions.ts';
import { Shell, VirtualFS } from './shell.ts';
import { STARTER_WORKFLOW, expandMatrix, parseWorkflow, triggeredBy } from './workflow.ts';
import { parseFileCommand, runWorkflow, type WorkflowRun } from './runner.ts';
import { nodeToolchain } from './node-toolchain.ts';
import { files as hello } from '../examples/hello.ts';

describe('expressions', () => {
  const ctx: EvalContext = {
    contexts: {
      github: { event_name: 'pull_request', ref: 'refs/heads/main' },
      matrix: { node: 20, os: 'ubuntu-latest' },
      steps: { build: { outputs: { size: '42' } } },
      needs: { a: { result: 'success' }, b: { result: 'failure' } },
    },
  };

  test('operators, literals and loose comparison', () => {
    assert.strictEqual(evaluate("github.event_name == 'PULL_REQUEST'", ctx), true);
    assert.strictEqual(evaluate('matrix.node >= 18 && matrix.node < 22', ctx), true);
    assert.strictEqual(evaluate("'42' == 42", ctx), true);
    assert.strictEqual(evaluate('null == 0', ctx), true);
    assert.strictEqual(evaluate("matrix.missing || 'fallback'", ctx), 'fallback');
    assert.strictEqual(evaluate("!startsWith(github.ref, 'refs/tags/')", ctx), true);
    assert.strictEqual(evaluate("steps['build'].outputs.size", ctx), '42');
  });

  test('functions and object filters', () => {
    assert.strictEqual(evaluate("format('{0} on {1}', matrix.node, matrix.os)", ctx), '20 on ubuntu-latest');
    assert.strictEqual(evaluate("contains(fromJSON('[\"a\",\"b\"]'), 'B')", ctx), true);
    assert.strictEqual(evaluate("join(fromJSON('[1,2]'), '-')", ctx), '1-2');
    assert.deepStrictEqual(evaluate('needs.*.result', ctx), ['success', 'failure']);
    assert.strictEqual(evaluate("contains(needs.*.result, 'failure')", ctx), true);
  });

  test('interpolation keeps a lone expression typed', () => {
    assert.strictEqual(interpolate('${{ matrix.node }}', ctx), 20);
    assert.strictEqual(interpolate('node-${{ matrix.node }}', ctx), 'node-20');
  });

  test('if: is success() && … unless it calls a status function', () => {
    assert.strictEqual(evaluateCondition('true', { ...ctx, status: 'failure' }), false);
    assert.strictEqual(evaluateCondition('${{ always() }}', { ...ctx, status: 'failure' }), true);
    assert.strictEqual(evaluateCondition('failure()', { ...ctx, status: 'failure' }), true);
    assert.strictEqual(evaluateCondition(undefined, ctx), true);
  });

  test('unknown contexts and functions are errors', () => {
    assert.throws(() => evaluate('nope.x', ctx), /Unrecognized named-value/);
    assert.throws(() => evaluate('nope()', ctx), /Unknown function/);
  });
});

describe('shell', () => {
  async function sh(script: string, files: Record<string, string> = {}) {
    const fs = new VirtualFS(files);
    fs.mkdir('/w');
    const shell = new Shell({ fs, env: { HOME: '/home/runner' }, cwd: '/w' });
    let out = '';
    let err = '';
    const code = await shell.run(script, { stdin: '', stdout: (t) => (out += t), stderr: (t) => (err += t) });
    return { code, out, err, fs };
  }

  test('quoting, variables and substitution', async () => {
    const r = await sh(`X=world; echo "hello $X" 'not $X' \${Y:-def} "$(echo inner)"`);
    assert.strictEqual(r.out, 'hello world not $X def inner\n');
  });

  test('set -e stops at the first failure, but not inside && / || or if', async () => {
    const r = await sh('false || echo a\nif false; then echo no; fi\nfalse && echo no\necho b\nfalse\necho never');
    assert.strictEqual(r.out, 'a\nb\n');
    assert.strictEqual(r.code, 1);
  });

  test('redirections, here-documents, pipes and loops', async () => {
    const r = await sh(`echo one > f.txt\necho two >> f.txt\ncat <<EOF >> f.txt\nthree $((1 + 2))\nEOF\nfor l in $(cat f.txt | grep -v two); do echo "[$l]"; done`);
    assert.strictEqual(r.fs.read('/w/f.txt'), 'one\ntwo\nthree 3\n');
    assert.strictEqual(r.out, '[one]\n[three]\n[3]\n');
  });

  test('an assignment exits with its substitution\'s status', async () => {
    const r = await sh('X=$(false)\necho never');
    assert.strictEqual(r.code, 1);
    assert.strictEqual(r.out, '');
  });

  test('unknown commands exit 127', async () => {
    const r = await sh('nope');
    assert.strictEqual(r.code, 127);
    assert.match(r.err, /nope: command not found/);
  });

  test('test / [ and exit codes', async () => {
    const r = await sh('[ -f a ] && echo has-a; [ "x" = "y" ] || echo differ; exit 3', { '/w/a': '' });
    assert.strictEqual(r.out, 'has-a\ndiffer\n');
    assert.strictEqual(r.code, 3);
  });
});

describe('workflow files', () => {
  test('parses jobs, needs and steps, and reports problems with lines', () => {
    const wf = parseWorkflow('.github/workflows/ci.yml', STARTER_WORKFLOW);
    assert.deepStrictEqual(wf.errors, []);
    assert.strictEqual(wf.name, 'CI');
    assert.deepStrictEqual(Object.keys(wf.on), ['pull_request', 'push', 'workflow_dispatch']);
    assert.strictEqual(wf.jobs[0].steps.length, 5);

    const bad = parseWorkflow('w.yml', 'on: push\njobs:\n  a:\n    runs-on: x\n    needs: missing\n    steps:\n      - name: nothing\n');
    assert.deepStrictEqual(bad.errors.map((e) => e.message), [
      'jobs.a: step 1 needs either \'uses\' or \'run\'.',
      "jobs.a needs 'missing', which is not a job in this workflow.",
    ]);
    assert.strictEqual(bad.errors[0].line, 7);
    const invalid = parseWorkflow('w.yml', 'on: push\njobs:\n  a:\n    steps:\n      - run: a ? 0 : 1\n');
    assert.strictEqual(invalid.errors[0].line, 5);
  });

  test('matrix: product, exclude and include', () => {
    const combos = expandMatrix({
      node: [20, 22],
      os: ['linux', 'mac'],
      exclude: [{ node: 20, os: 'mac' }],
      include: [{ node: 22, experimental: true }, { node: 24, os: 'linux' }],
    });
    assert.deepStrictEqual(combos, [
      { node: 20, os: 'linux' },
      { node: 22, os: 'linux', experimental: true },
      { node: 22, os: 'mac', experimental: true },
      { node: 24, os: 'linux' },
    ]);
  });

  test('triggers and branch filters', () => {
    const wf = parseWorkflow('w.yml', 'on:\n  pull_request:\n    branches: [main, "release/**"]\njobs: {a: {runs-on: x, steps: [{run: "true"}]}}');
    assert.deepStrictEqual(triggeredBy(wf, { name: 'pull_request', branch: 'release/1.0' }), { runs: true });
    assert.strictEqual(triggeredBy(wf, { name: 'pull_request', branch: 'dev' }).runs, false);
    assert.strictEqual(triggeredBy(wf, { name: 'push', branch: 'main' }).runs, false);
  });

  test('file commands', () => {
    assert.deepStrictEqual(parseFileCommand('a=1\nb<<EOF\nx\ny\nEOF\nc=d=e\n'), { a: '1', b: 'x\ny', c: 'd=e' });
  });
});

describe('running workflows', () => {
  const pr = { name: 'pull_request', branch: 'main' };
  const run = (yml: string, files = hello) =>
    runWorkflow({ workflow: parseWorkflow('.github/workflows/ci.yml', yml), event: pr, files, toolchain: nodeToolchain, repository: 'me/demo' }).done;
  const logOf = (r: WorkflowRun, job = 0) => r.jobs[job].steps.flatMap((s) => s.log.map((l) => l.text)).join('\n');

  test('the starter workflow type checks and tests a project with tsrs', async () => {
    const r = await run(STARTER_WORKFLOW);
    assert.strictEqual(r.conclusion, 'success', logOf(r));
    const log = logOf(r);
    assert.match(log, /Checked out 6 files of me\/demo/);
    assert.match(log, /✔ greets a user by name/);
    assert.match(log, /pass 2/);
    assert.deepStrictEqual(r.notEmulated, []);
  });

  test('a type error fails `tsc` with an annotation on the file', async () => {
    const files = { ...hello, 'src/greet.ts': hello['src/greet.ts'].replace('return `Hello', 'const n: number = "x";\n  return `Hello') };
    const r = await run(STARTER_WORKFLOW, files);
    assert.strictEqual(r.conclusion, 'failure');
    const error = r.annotations.find((a) => a.level === 'error');
    assert.strictEqual(error?.file, 'src/greet.ts');
    assert.strictEqual(error?.title, 'TS2322');
    // Steps after the failure are skipped.
    assert.strictEqual(r.jobs[0].steps.find((s) => s.name === 'Tests')?.conclusion, 'skipped');
  });

  test('a failing test fails the job', async () => {
    const files = { ...hello, 'src/greet.test.ts': `test('breaks', () => { expect(1).toBe(2); });\n` };
    const r = await run(STARTER_WORKFLOW, files);
    assert.strictEqual(r.conclusion, 'failure');
    assert.match(logOf(r), /✖ breaks/);
  });

  test('without actions/checkout the workspace is empty, as on GitHub', async () => {
    const r = await run('on: pull_request\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n');
    assert.strictEqual(r.conclusion, 'failure');
    assert.match(logOf(r), /did the workflow check out the repository/);
  });

  test('outputs flow between steps and jobs; needs, if and matrix', async () => {
    const r = await run(`
on: pull_request
jobs:
  first:
    runs-on: ubuntu-latest
    outputs:
      greeting: \${{ steps.say.outputs.text }}
    steps:
      - id: say
        run: echo "text=hi from \${{ github.repository }}" >> "$GITHUB_OUTPUT"
  second:
    needs: first
    runs-on: ubuntu-latest
    strategy:
      matrix:
        n: [1, 2]
    steps:
      - run: echo "\${{ needs.first.outputs.greeting }} / n=\${{ matrix.n }}"
      - if: matrix.n == 2
        run: echo only-two
  never:
    needs: second
    if: github.event_name == 'push'
    runs-on: ubuntu-latest
    steps:
      - run: exit 1
`);
    assert.strictEqual(r.conclusion, 'success');
    assert.deepStrictEqual(r.jobs.map((j) => [j.key, j.conclusion]), [
      ['first', 'success'],
      ['second (1)', 'success'],
      ['second (2)', 'success'],
      ['never', 'skipped'],
    ]);
    assert.match(logOf(r, 1), /hi from me\/demo \/ n=1/);
    assert.doesNotMatch(logOf(r, 1), /only-two/);
    assert.match(logOf(r, 2), /only-two/);
  });

  test('npm run uses package.json scripts; continue-on-error and failure()', async () => {
    const files = { ...hello, 'package.json': JSON.stringify({ scripts: { typecheck: 'tsc --noEmit', test: 'node --test', lint: 'eslint .' } }) };
    const r = await run(`
on: pull_request
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - run: npm run typecheck && npm test
      - run: npm run lint
      - id: flaky
        continue-on-error: true
        run: exit 4
      - run: echo "flaky was \${{ steps.flaky.outcome }}"
      - if: failure()
        run: echo should-not-run
`, files);
    assert.strictEqual(r.conclusion, 'success', logOf(r));
    const log = logOf(r);
    assert.match(log, /> typecheck\n> tsc --noEmit/);
    assert.match(log, /flaky was failure/);
    assert.doesNotMatch(log, /should-not-run/);
    // eslint can't run here: the run says so.
    assert.deepStrictEqual(r.notEmulated.map((n) => n.tool), ['eslint']);
  });

  test('node -p reads package.json, as CI one-liners do', async () => {
    const files = { ...hello, 'package.json': JSON.stringify({ version: '1.2.3', devDependencies: { '@playwright/test': '^1.62.0' } }) };
    const r = await run(`
on: pull_request
jobs:
  v:
    runs-on: ubuntu-latest
    outputs:
      version: \${{ steps.v.outputs.version }}
    steps:
      - uses: actions/checkout@v7
      - id: v
        run: |
          VERSION=$(node -p "require('./package.json').devDependencies['@playwright/test'].replace(/[\\^~]/g, '')")
          echo "version=$VERSION" >> $GITHUB_OUTPUT
      - run: |
          node -e "process.exit(require('./package.json').version === '1.2.3' ? 0 : 1)"
      - id: missing
        continue-on-error: true
        run: node -p "require('./nope.json')"
`, files);
    assert.strictEqual(r.conclusion, 'success', logOf(r));
    assert.deepStrictEqual(r.jobs[0].outputs, { version: '1.62.0' });
    assert.match(logOf(r), /require\('\.\/nope\.json'\) is not emulated/);
  });

  test('a workflow the event does not trigger is skipped', async () => {
    const r = await run('on: push\njobs: {a: {runs-on: x, steps: [{run: "true"}]}}');
    assert.strictEqual(r.conclusion, 'skipped');
    assert.match(r.annotations[0].message, /doesn't run on pull_request/);
  });

  test('cancelling stops the run', async () => {
    const controller = new AbortController();
    const { done } = runWorkflow({
      workflow: parseWorkflow('w.yml', 'on: pull_request\njobs: {a: {runs-on: x, steps: [{run: "while true; do :; done"}]}}'),
      event: pr,
      files: hello,
      toolchain: nodeToolchain,
      signal: controller.signal,
      onUpdate: (r) => {
        if (r.jobs[0]?.steps[1]?.status === 'in_progress') controller.abort();
      },
    });
    const r = await done;
    assert.strictEqual(r.conclusion, 'cancelled');
  });
});
