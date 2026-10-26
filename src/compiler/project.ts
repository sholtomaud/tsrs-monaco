// The virtual project the playground compiles. Paths in the store are
// relative to PROJECT_ROOT; tsrs sees them as absolute in-memory files.

export const PROJECT_ROOT = '/project';
export const TSCONFIG = 'tsconfig.json';
export const OUT_DIR = 'dist';
export const ENTRY = 'src/index.ts';
export const TEST_FILE = /\.test\.(m|c)?js$/;

export type ProjectFiles = Record<string, string>;

export const DEFAULT_TSCONFIG = `{
  "compilerOptions": {
    "target": "es2022",
    "module": "esnext",
    "moduleResolution": "bundler",
    // Code runs in a Web Worker, so there is no DOM.
    "lib": ["esnext", "webworker"],
    "strict": true,
    // Don't type check fetched npm declaration files, only your code.
    "skipLibCheck": true,
    "allowImportingTsExtensions": true,
    "rewriteRelativeImportExtensions": true,
    "rootDir": "src",
    "outDir": "${OUT_DIR}"
  },
  "include": ["src"]
}
`;

export function toAbsolute(path: string): string {
  return `${PROJECT_ROOT}/${path}`;
}

export function toRelative(path: string): string {
  const prefix = `${PROJECT_ROOT}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/** The emitted .js path for a source file, e.g. src/a.ts -> dist/a.js. */
export function outputPathFor(source: string): string {
  const withoutRoot = source.replace(/^src\//, '');
  return `${OUT_DIR}/${withoutRoot.replace(/\.(m|c)?tsx?$/, '.$1js')}`;
}

export function isSourceFile(path: string): boolean {
  return /\.(m|c)?(t|j)sx?$/.test(path) && !path.endsWith('.d.ts');
}

/** The file Run starts from: src/index.ts, or src/main.ts in a Boba/Vite app. */
export function entryFile(files: ProjectFiles): string {
  for (const candidate of [ENTRY, 'src/main.ts']) {
    if (candidate in files) return candidate;
  }
  return Object.keys(files).find(isSourceFile) ?? ENTRY;
}
