// Just enough of Node's package.json resolution (exports conditions, types
// fields and sibling .d.ts files) to find declaration files and browser ES
// module entry points on a CDN.

export interface PackageJson {
  name?: string;
  version?: string;
  types?: string;
  typings?: string;
  main?: string;
  module?: string;
  browser?: string | Record<string, string | false>;
  exports?: unknown;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

// The conditions tsrs uses with moduleResolution: bundler (no 'require').
export const TYPES_CONDITIONS = ['types', 'import', 'module', 'browser', 'default'];
export const BROWSER_CONDITIONS = ['browser', 'import', 'module', 'default'];

const clean = (path: string) => path.replace(/^\.?\//, '');

/** Picks a target from an exports value by walking conditions in order. */
function pickTarget(value: unknown, conditions: string[]): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const target = pickTarget(item, conditions);
      if (target) return target;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      if (key === 'default' || conditions.includes(key)) {
        const target = pickTarget(inner, conditions);
        if (target) return target;
      }
    }
  }
  return null;
}

/** Resolves `subpath` ('' or '/x') through package.json "exports". */
export function resolveExports(
  pkg: PackageJson,
  subpath: string,
  conditions: string[]
): string | null | undefined {
  const exports = pkg.exports;
  if (exports === undefined || exports === null) return undefined;
  const key = `.${subpath}`;
  const isMap =
    typeof exports === 'object' &&
    !Array.isArray(exports) &&
    Object.keys(exports as object).some((k) => k.startsWith('.'));
  if (!isMap) {
    const target = subpath ? null : pickTarget(exports, conditions);
    return target ? clean(target) : null;
  }

  const map = exports as Record<string, unknown>;
  if (key in map) {
    const target = pickTarget(map[key], conditions);
    return target ? clean(target) : null;
  }
  // Pattern exports: "./features/*": "./dist/features/*.js"
  for (const [pattern, value] of Object.entries(map)) {
    const star = pattern.indexOf('*');
    if (star === -1) continue;
    const [prefix, suffix] = [pattern.slice(0, star), pattern.slice(star + 1)];
    if (key.startsWith(prefix) && key.endsWith(suffix) && key.length >= prefix.length + suffix.length) {
      const match = key.slice(prefix.length, key.length - suffix.length);
      const target = pickTarget(value, conditions);
      return target ? clean(target.replace(/\*/g, match)) : null;
    }
  }
  return null;
}

/** The declaration files TypeScript would look for next to a JS file. */
export function declarationCandidates(path: string): string[] {
  const p = clean(path);
  if (/\.d\.[mc]?ts$/.test(p)) return [p];
  const m = p.match(/^(.*)\.([mc]?)(?:js|ts|jsx|tsx)$/);
  if (m) return [`${m[1]}.d.${m[2]}ts`];
  return [`${p}.d.ts`, `${p}/index.d.ts`];
}

/** Where the declarations for `subpath` of this package should be. */
export function typesEntry(
  pkg: PackageJson,
  subpath: string,
  has: (path: string) => boolean
): string | null {
  const first = (paths: string[]) => paths.find(has) ?? null;
  const exported = resolveExports(pkg, subpath, TYPES_CONDITIONS);
  if (exported) return first(declarationCandidates(exported));
  if (exported === null) return null;

  if (!subpath) {
    for (const field of [pkg.types, pkg.typings]) {
      if (field) return first(declarationCandidates(field));
    }
    const main = pkg.module ?? pkg.main;
    return first([...(main ? declarationCandidates(main) : []), 'index.d.ts']);
  }
  return first(declarationCandidates(subpath.slice(1)));
}

/** The browser ES module for `subpath`, or null if the package has none. */
export function browserEntry(pkg: PackageJson, subpath: string): string | null {
  const exported = resolveExports(pkg, subpath, BROWSER_CONDITIONS);
  if (exported !== undefined) return exported;
  if (subpath) return subpath.slice(1);
  if (typeof pkg.browser === 'string' && /\.mjs$/.test(pkg.browser)) return clean(pkg.browser);
  return pkg.module ? clean(pkg.module) : null;
}

export function dependencyRange(pkg: PackageJson, name: string): string | undefined {
  return (
    pkg.dependencies?.[name] ??
    pkg.peerDependencies?.[name] ??
    pkg.optionalDependencies?.[name]
  );
}
