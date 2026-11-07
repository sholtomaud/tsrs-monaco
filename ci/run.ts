// The tsrs × Monaco CI action's driver: reads the project's files, opens the
// deployed playground's CI page (ci.html) in headless Chromium, and has it
// type check and test them with the editor's own pipeline. Prints the result
// like a test runner, with annotations, a step summary and step outputs.
// Node runs this file as it is (it only uses erasable TypeScript syntax).

import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

interface Problem {
  file: string | null;
  severity: 'error' | 'warning' | 'info' | 'hint';
  code: number;
  message: string;
  startLineNumber: number;
  startColumn: number;
}

interface Check {
  ok: boolean;
  errors: number;
  problems: Problem[];
  tests: { file: string; name: string; status: 'pass' | 'fail'; error?: string }[] | null;
  passed: number;
  failed: number;
  testError?: string;
  entry: { file: string; ok: boolean; error?: string; console: { level: string; text: string }[] } | null;
  log: string[];
}

interface TsrsCi {
  version: string;
  tsrs: string;
  check(files: Record<string, string>, options: { tests: boolean; entry: boolean }): Promise<Check>;
}

const env = (name: string, fallback: string) => process.env[name]?.trim() || fallback;
const projectDir = path.resolve(process.env.GITHUB_WORKSPACE ?? '.', env('TSRS_CI_PATH', '.'));
const version = env('TSRS_CI_VERSION', 'latest');
const base = env('TSRS_CI_URL', 'https://sholtomaud.github.io/tsrs-monaco').replace(/\/+$/, '');
const url = `${base}${version === 'latest' ? '' : `/v/${version}`}/ci.html`;
const options = { tests: env('TSRS_CI_TESTS', 'true') === 'true', entry: env('TSRS_CI_ENTRY', 'false') === 'true' };

/** Annotations point at files relative to the repository root. */
const relative = path.relative(process.env.GITHUB_WORKSPACE ?? process.cwd(), projectDir).split(path.sep).join('/');
const repoPath = (file: string) => (relative && relative !== '.' ? `${relative}/${file}` : file);

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist']);
const MAX_BYTES = 1024 * 1024;

/** The project's text files, by path relative to it. */
function readProject(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (at: string) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
      } else if (entry.isFile() && fs.statSync(full).size <= MAX_BYTES) {
        const bytes = fs.readFileSync(full);
        if (bytes.includes(0)) continue; // Binary.
        files[path.relative(dir, full).split(path.sep).join('/')] = bytes.toString('utf8');
      }
    }
  };
  walk(dir);
  return files;
}

/** Escapes a workflow command's message and properties. */
const escapeData = (s: string) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escapeProperty = (s: string) => escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

function appendFile(variable: string, text: string) {
  const file = process.env[variable];
  if (file) fs.appendFileSync(file, text);
}

async function main(): Promise<number> {
  if (!fs.existsSync(path.join(projectDir, 'tsconfig.json'))) {
    console.log(`::error::No tsconfig.json in ${projectDir}. Did the workflow check out the repository (actions/checkout) first?`);
    return 1;
  }
  const files = readProject(projectDir);
  console.log(`Checking ${Object.keys(files).length} files from ${projectDir} with ${url}`);

  const browser = await chromium.launch({
    // For running the action locally against another Chromium build.
    executablePath: process.env.TSRS_CI_CHROMIUM || undefined,
    // WebGPU on SwiftShader (software Vulkan), so GPU code runs without a GPU.
    args: ['--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader', '--enable-features=Vulkan'],
  });
  try {
    const page = await browser.newPage();
    page.on('pageerror', (error) => console.log(`::warning title=Playground page error::${escapeData(error.message)}`));
    const response = await page.goto(url);
    if (!response?.ok()) {
      console.log(`::error title=Playground not found::${url} returned ${response?.status() ?? 'nothing'}. Is playground-version (${version}) a published release?`);
      return 1;
    }
    await page.waitForFunction(() => document.body.dataset.ready === 'true', undefined, { timeout: 60_000 });
    const info = await page.evaluate(() => {
      const ci = (window as unknown as { tsrsCi: TsrsCi }).tsrsCi;
      return { version: ci.version, tsrs: ci.tsrs };
    });
    console.log(`Playground ${info.version} · @tsrs/wasm ${info.tsrs}\n`);
    const check = await page.evaluate(
      ([projectFiles, checkOptions]) => (window as unknown as { tsrsCi: TsrsCi }).tsrsCi.check(projectFiles, checkOptions),
      [files, options] as const
    );

    // Indented, so problem matchers (setup-node registers one for tsc) don't turn
    // the log's own error lines into extra annotations, without the project's folder;
    // the annotations below have the right paths.
    for (const line of check.log) console.log(`  ${line}`);
    for (const p of check.problems) {
      if (p.severity !== 'error' && p.severity !== 'warning') continue;
      const where = p.file ? ` file=${escapeProperty(repoPath(p.file))},line=${p.startLineNumber},col=${p.startColumn},` : ' ';
      console.log(`::${p.severity}${where}title=TS${p.code}::${escapeData(p.message)}`);
    }
    for (const t of check.tests ?? []) {
      if (t.status !== 'fail') continue;
      const file = repoPath(t.file.replace(/^dist\//, 'src/').replace(/\.js$/, '.ts'));
      console.log(`::error file=${escapeProperty(file)},title=${escapeProperty(`Test failed: ${t.name}`)}::${escapeData(t.error ?? 'failed')}`);
    }
    if (check.testError) console.log(`::error title=Tests could not run::${escapeData(check.testError)}`);

    let entryLog = '';
    if (check.entry) {
      entryLog = path.join(process.env.RUNNER_TEMP ?? projectDir, 'tsrs-ci', 'entry.log');
      fs.mkdirSync(path.dirname(entryLog), { recursive: true });
      fs.writeFileSync(entryLog, check.entry.console.map((c) => `${c.text}\n`).join(''));
      if (check.entry.error) console.log(`::error title=${escapeProperty(`${check.entry.file} failed`)}::${escapeData(check.entry.error)}`);
    }

    appendFile('GITHUB_OUTPUT', [
      `errors=${check.errors}`,
      `passed=${check.passed}`,
      `failed=${check.failed}`,
      `entry-log=${entryLog}`,
      `playground-version=${info.version}`,
    ].map((l) => `${l}\n`).join(''));
    const icon = check.ok ? '✅' : '❌';
    appendFile('GITHUB_STEP_SUMMARY', [
      `### ${icon} tsrs × Monaco: ${relative && relative !== '.' ? relative : 'project'}`,
      '',
      `| Type errors | Tests passed | Tests failed | Playground | @tsrs/wasm |`,
      `| --- | --- | --- | --- | --- |`,
      `| ${check.errors} | ${check.passed} | ${check.failed} | ${info.version} | ${info.tsrs} |`,
      '',
    ].join('\n'));
    return check.ok ? 0 : 1;
  } finally {
    await browser.close();
  }
}

process.exitCode = await main().catch((error: unknown) => {
  console.log(`::error title=tsrs × Monaco CI::${escapeData(error instanceof Error ? (error.stack ?? error.message) : String(error))}`);
  return 1;
});
