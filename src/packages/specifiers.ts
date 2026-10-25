// Finding and parsing bare module specifiers ('onnxruntime-web',
// '@tensorflow/tfjs-core/dist/foo') in TypeScript, declaration files and
// emitted JavaScript.

const NODE_BUILTINS = new Set(
  'assert buffer child_process cluster crypto dgram dns events fs http http2 https module net os path perf_hooks process querystring readline stream string_decoder timers tls tty url util v8 vm worker_threads zlib'.split(
    ' '
  )
);

const NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

export interface BareSpecifier {
  name: string;
  /** '' for the package root, otherwise e.g. '/webgpu'. */
  subpath: string;
}

/** Splits an npm specifier into package name and subpath, or null if it isn't one. */
export function parseBareSpecifier(spec: string): BareSpecifier | null {
  if (!spec || spec.startsWith('.') || spec.startsWith('/') || spec.includes(':')) {
    return null;
  }
  const parts = spec.split('/');
  const nameParts = spec.startsWith('@') ? 2 : 1;
  if (parts.length < nameParts) return null;
  const name = parts.slice(0, nameParts).join('/');
  if (!NAME.test(name) || NODE_BUILTINS.has(name)) return null;
  const rest = parts.slice(nameParts).join('/');
  return { name, subpath: rest ? `/${rest}` : '' };
}

// import x from 'a'; import 'a'; export * from 'a'; import('a');
// import x = require('a'); declare module 'a' is deliberately not matched.
const MODULE_REFERENCE =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(['"])([^'"\n]+)\1/g;
const REFERENCE_TYPES = /\/\/\/\s*<reference\s+types\s*=\s*(['"])([^'"]+)\1/g;
const REFERENCE_PATH = /\/\/\/\s*<reference\s+path\s*=\s*(['"])([^'"]+)\1/g;

// Strings are kept (they hold the specifiers); comments are dropped so prose
// like "copied from 'somewhere'" isn't mistaken for an import.
const STRING_OR_COMMENT =
  /("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;

export function stripComments(code: string): string {
  return code.replace(STRING_OR_COMMENT, (match, string) => string ?? ' ');
}

/** Every module specifier a file refers to, in order, without duplicates. */
export function moduleReferences(code: string): string[] {
  const specs = new Set<string>();
  for (const m of stripComments(code).matchAll(MODULE_REFERENCE)) specs.add(m[2]);
  for (const m of code.matchAll(REFERENCE_TYPES)) specs.add(m[2]);
  return [...specs];
}

/** `/// <reference path="..."/>` targets, which are relative file paths. */
export function referencePaths(code: string): string[] {
  return [...code.matchAll(REFERENCE_PATH)].map((m) => m[2]);
}

export function bareImports(code: string): BareSpecifier[] {
  const seen = new Set<string>();
  const out: BareSpecifier[] = [];
  for (const spec of moduleReferences(code)) {
    const bare = parseBareSpecifier(spec);
    if (bare && !seen.has(spec)) {
      seen.add(spec);
      out.push(bare);
    }
  }
  return out;
}

/** '@types/babel__core' for '@babel/core', '@types/lodash' for 'lodash'. */
export function typesPackageFor(name: string): string {
  return `@types/${name.startsWith('@') ? name.slice(1).replace('/', '__') : name}`;
}
