// The virtual project the playground compiles. Paths in the store are
// relative to PROJECT_ROOT; tsrs sees them as absolute in-memory files.

export const PROJECT_ROOT = '/project';
export const TSCONFIG = 'tsconfig.json';
export const OUT_DIR = 'dist';
export const ENTRY = 'src/index.ts';

export type ProjectFiles = Record<string, string>;

export const DEFAULT_TSCONFIG = `{
  "compilerOptions": {
    "target": "es2022",
    "module": "esnext",
    "moduleResolution": "bundler",
    // Code runs in a Web Worker, so there is no DOM.
    "lib": ["esnext", "webworker"],
    "strict": true,
    "allowImportingTsExtensions": true,
    "rewriteRelativeImportExtensions": true,
    "rootDir": "src",
    "outDir": "${OUT_DIR}"
  },
  "include": ["src"]
}
`;

export const DEFAULT_FILES: ProjectFiles = {
  [TSCONFIG]: DEFAULT_TSCONFIG,
  [ENTRY]: `import { greet, type User } from './greet.ts';

const users: User[] = [
  { name: 'Alice', languages: ['TypeScript', 'Rust'] },
  { name: 'Bob', languages: ['JavaScript'] },
];

for (const user of users) {
  console.log(greet(user));
}

// Try breaking a type: change 'Alice' to 42 and watch the squiggle appear.
const total = users.reduce((n, u) => n + u.languages.length, 0);
console.info(\`\${users.length} users know \${total} languages\`);
`,
  'src/greet.ts': `export interface User {
  name: string;
  languages: string[];
}

export function greet(user: User): string {
  return \`Hello, \${user.name}! You write \${user.languages.join(' and ')}.\`;
}
`,
};

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
