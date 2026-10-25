// Packages come from public CDNs: version resolution, file listings and
// declaration files from jsDelivr; code to run from jsDelivr when the
// package's browser ES module is self-contained, otherwise from esm.sh,
// which rewrites a package's own bare imports to more esm.sh URLs.

import { browserEntry, type PackageJson } from './package-json.ts';
import type { PackageSource } from './type-acquisition.ts';

export const JSDELIVR = 'https://cdn.jsdelivr.net/npm';
export const JSDELIVR_DATA = 'https://data.jsdelivr.com/v1/packages/npm';
export const ESM_SH = 'https://esm.sh';

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/;

type Fetch = (url: string) => Promise<Response>;

export class JsDelivrSource implements PackageSource {
  private fetch: Fetch;
  private cache = new Map<string, Promise<unknown>>();

  constructor(fetchImpl: Fetch = (url) => fetch(url)) {
    this.fetch = fetchImpl;
  }

  private get<T>(url: string, as: 'json' | 'text'): Promise<T> {
    let pending = this.cache.get(url) as Promise<T> | undefined;
    if (!pending) {
      pending = this.fetch(url).then((response) => {
        if (!response.ok) throw new Error(`${response.status} for ${url}`);
        return (as === 'json' ? response.json() : response.text()) as Promise<T>;
      });
      // Don't cache failures (e.g. going offline for a moment).
      pending.catch(() => this.cache.delete(url));
      this.cache.set(url, pending);
    }
    return pending;
  }

  async resolveVersion(name: string, range: string): Promise<string> {
    if (EXACT_VERSION.test(range)) return range;
    const { version } = await this.get<{ version: string | null }>(
      `${JSDELIVR_DATA}/${name}/resolved?specifier=${encodeURIComponent(range)}`,
      'json'
    );
    if (!version) throw new Error(`no version matches '${range}'`);
    return version;
  }

  packageJson(name: string, version: string): Promise<PackageJson> {
    return this.get(`${JSDELIVR}/${name}@${version}/package.json`, 'json');
  }

  async listFiles(name: string, version: string): Promise<string[]> {
    const { files } = await this.get<{ files: { name: string }[] }>(
      `${JSDELIVR_DATA}/${name}@${version}?structure=flat`,
      'json'
    );
    return files.map((f) => f.name.replace(/^\//, ''));
  }

  readFile(name: string, version: string, path: string): Promise<string> {
    return this.get(`${JSDELIVR}/${name}@${version}/${path}`, 'text');
  }
}

/**
 * The URL to import `name@version` + `subpath` from at runtime. A browser ES
 * module with no bare imports of its own is loaded straight from jsDelivr,
 * so assets it locates with import.meta.url (onnxruntime-web's .wasm files,
 * for example) resolve next to it. Anything else goes through esm.sh.
 */
export async function runtimeUrl(
  source: PackageSource,
  name: string,
  version: string,
  subpath: string
): Promise<string> {
  try {
    const pkg = await source.packageJson(name, version);
    const entry = browserEntry(pkg, subpath);
    if (entry && /\.m?js$/.test(entry)) {
      const code = await source.readFile(name, version, entry);
      if (isSelfContainedModule(code)) {
        return `${JSDELIVR}/${name}@${version}/${entry}`;
      }
    }
  } catch {
    // Fall back to esm.sh, which can also convert CommonJS.
  }
  return `${ESM_SH}/${name}@${version}${subpath}`;
}

// Statement-level imports, so text inside strings in minified code (e.g.
// `conversion from 'int32' to`) doesn't count.
const STATIC_IMPORT =
  /(?:^|[;}\n])\s*(?:import|export)(?:\s*[\w$*{},\s]+?\s*from)?\s*(['"])([^'"\n]+)\1/g;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g;
const ESM_EXPORT =
  /(?:^|[;}\n])\s*export\s*(?:[{*]|default\b|const\b|let\b|var\b|function\b|class\b|async\b)/;

/**
 * A bundled ES module: it exports something, has no static imports (an
 * unbundled entry like tfjs-core's dist/index.js imports its own files and
 * other packages), and only lazily imports files of its own.
 */
export function isSelfContainedModule(code: string): boolean {
  if (!ESM_EXPORT.test(code)) return false;
  for (const m of code.matchAll(STATIC_IMPORT)) {
    if (!/^https?:/.test(m[2])) return false;
  }
  for (const m of code.matchAll(DYNAMIC_IMPORT)) {
    if (!m[2].startsWith('./') && !/^https?:/.test(m[2])) return false;
  }
  return true;
}
