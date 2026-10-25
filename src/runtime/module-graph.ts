// Links the compiler's emitted files into something the browser can import.
// Blob URLs have no path, so relative specifiers like './greet.js' cannot be
// resolved against them. Instead every module is turned into a Blob URL in
// dependency order and its relative imports are rewritten to point at the
// Blob URLs of its dependencies. Bare and absolute URL specifiers are left
// alone unless `external` maps them (npm packages to CDN URLs), so
// `import x from 'https://esm.sh/...'` still works at runtime.

const SPECIFIER =
  /(\bimport\s*\(\s*|\bimport\s+|\bfrom\s*|\bexport\s*\*\s*from\s*)(['"])([^'"\n]+)\2/g;

const isRelative = (spec: string) => spec.startsWith('./') || spec.startsWith('../');

export type Modules = Record<string, string>;

export function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

export function joinPath(base: string, relative: string): string {
  const parts = base ? base.split('/') : [];
  for (const part of relative.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

/** Resolves `spec` imported from `from` to a key of `modules`, or null. */
export function resolveSpecifier(
  modules: Modules,
  from: string,
  spec: string
): string | null {
  const base = joinPath(dirname(from), spec);
  for (const candidate of [base, `${base}.js`, `${base}/index.js`]) {
    if (candidate in modules) return candidate;
  }
  return null;
}

export function relativeImports(code: string): string[] {
  return [...code.matchAll(SPECIFIER)].map((m) => m[3]).filter(isRelative);
}

export class LinkError extends Error {}

/**
 * Returns a function that rewrites every module reachable from an entry,
 * calling `toUrl` for each one after its dependencies, and returns the
 * entry's URL. Modules are linked once per linker, so entries that share a
 * dependency also share its instance.
 */
export function createLinker(
  modules: Modules,
  toUrl: (path: string, code: string) => string,
  external: Record<string, string> = {}
): (entry: string) => string {
  const urls = new Map<string, string>();
  const visiting = new Set<string>();

  const visit = (path: string, chain: string[]): string => {
    const done = urls.get(path);
    if (done) return done;
    if (visiting.has(path)) {
      throw new LinkError(
        `Circular imports are not supported: ${[...chain, path].join(' -> ')}`
      );
    }
    visiting.add(path);
    const code = modules[path].replace(
      SPECIFIER,
      (match, prefix: string, quote: string, spec: string) => {
        if (!isRelative(spec)) {
          const url = external[spec];
          return url ? `${prefix}${quote}${url}${quote}` : match;
        }
        const target = resolveSpecifier(modules, path, spec);
        if (!target) {
          throw new LinkError(`Cannot find module '${spec}' from '${path}'.`);
        }
        return `${prefix}${quote}${visit(target, [...chain, path])}${quote}`;
      }
    );
    visiting.delete(path);
    const url = toUrl(path, code);
    urls.set(path, url);
    return url;
  };

  return (entry) => {
    if (!(entry in modules)) {
      throw new LinkError(`Entry module '${entry}' was not emitted.`);
    }
    return visit(entry, []);
  };
}

export function link(
  modules: Modules,
  entry: string,
  toUrl: (path: string, code: string) => string
): string {
  return createLinker(modules, toUrl)(entry);
}
