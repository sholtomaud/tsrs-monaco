// Automatic type acquisition: given the bare imports in the project, fetch
// the declaration files they reach (following relative imports, imports of
// other packages and /// <reference> directives) and lay them out under
// node_modules/ so tsrs can resolve them like a local install.

import { joinPath, dirname } from '../runtime/module-graph.ts';
import {
  declarationCandidates,
  dependencyRange,
  typesEntry,
  type PackageJson,
} from './package-json.ts';
import {
  moduleReferences,
  parseBareSpecifier,
  referencePaths,
  typesPackageFor,
  type BareSpecifier,
} from './specifiers.ts';

export interface PackageSource {
  /** Exact version for a range or dist-tag ('latest', '^4.0.0', '1.2.3'). */
  resolveVersion(name: string, range: string): Promise<string>;
  packageJson(name: string, version: string): Promise<PackageJson>;
  /** Every file in the published package, without a leading slash. */
  listFiles(name: string, version: string): Promise<string[]>;
  readFile(name: string, version: string, path: string): Promise<string>;
}

export interface Acquisition {
  /**
   * Project-relative paths (node_modules/...) to declaration file contents,
   * for the requested imports and the packages they depend on.
   */
  files: Record<string, string>;
  /** Exact version of every package that was looked at. */
  versions: Record<string, string>;
  errors: string[];
}

interface PackageRecord {
  key: string;
  name: string;
  version: string;
  pkg: PackageJson;
  list: Set<string>;
  /** Fetched declaration files, by path inside the package. */
  files: Map<string, string>;
  /** Keys of the packages its declarations refer to (including @types). */
  deps: Set<string>;
}

const MAX_FILES = 4000;
const CONCURRENCY = 16;

export class TypeAcquirer {
  private source: PackageSource;
  private versions = new Map<string, Promise<string>>();
  private records = new Map<string, Promise<PackageRecord>>();
  /** name@version + subpath -> key of the record holding its types, or null. */
  private entries = new Map<string, Promise<string | null>>();
  private crawled = new Set<string>();
  private errors = new Map<string, string>();
  private fileCount = 0;
  private active = 0;
  private waiting: (() => void)[] = [];

  constructor(source: PackageSource) {
    this.source = source;
  }

  /**
   * Fetches types for `imports`. `ranges` comes from the project's
   * package.json, if it has one. Fetched files are cached across calls, but
   * each result only holds what these imports need.
   */
  async acquire(
    imports: BareSpecifier[],
    ranges: Record<string, string> = {}
  ): Promise<Acquisition> {
    const wanted = new Set(imports.map((i) => i.name));
    for (const name of wanted) this.errors.delete(name);
    const roots = await Promise.all(
      imports.map((spec) => this.ensureEntry(spec, ranges[spec.name] ?? 'latest'))
    );

    // Everything reachable from the imports, breadth first so a version the
    // project imports directly wins over one a dependency asks for (as npm
    // would hoist it), and one version per package name.
    const files: Record<string, string> = {};
    const versions: Record<string, string> = {};
    const queue = roots.filter((key): key is string => key !== null);
    const seen = new Set<string>(queue);
    while (queue.length) {
      const record = await this.records.get(queue.shift()!)!;
      if (record.name in versions) continue;
      versions[record.name] = record.version;
      files[`node_modules/${record.name}/package.json`] = JSON.stringify(record.pkg, null, 2);
      for (const [path, text] of record.files) {
        files[`node_modules/${record.name}/${path}`] = text;
      }
      for (const dep of record.deps) {
        if (!seen.has(dep)) {
          seen.add(dep);
          queue.push(dep);
        }
      }
    }

    return {
      files,
      versions,
      errors: [...this.errors]
        .filter(([name]) => wanted.has(name))
        .map(([, message]) => message),
    };
  }

  private async ensurePackage(name: string, range: string): Promise<PackageRecord | null> {
    try {
      let version = this.versions.get(`${name}@${range}`);
      if (!version) {
        version = this.source.resolveVersion(name, range);
        version.catch(() => this.versions.delete(`${name}@${range}`));
        this.versions.set(`${name}@${range}`, version);
      }
      const key = `${name}@${await version}`;
      let record = this.records.get(key);
      if (!record) {
        record = (async () => {
          const v = await version;
          const [pkg, list] = await Promise.all([
            this.source.packageJson(name, v),
            this.source.listFiles(name, v),
          ]);
          return { key, name, version: v, pkg, list: new Set(list), files: new Map(), deps: new Set() };
        })();
        record.catch(() => this.records.delete(key));
        this.records.set(key, record);
      }
      return await record;
    } catch (error) {
      this.errors.set(name, `Could not fetch '${name}@${range}': ${(error as Error).message}`);
      return null;
    }
  }

  /** Makes sure the declarations for one import exist; resolves to their record key. */
  private async ensureEntry(
    { name, subpath }: BareSpecifier,
    range: string
  ): Promise<string | null> {
    const record = await this.ensurePackage(name, range);
    if (!record) return null;
    const entryKey = `${record.key}${subpath}`;
    let done = this.entries.get(entryKey);
    if (!done) {
      done = (async () => {
        const entry = typesEntry(record.pkg, subpath, (p) => record.list.has(p));
        if (entry) {
          await this.crawl(record, entry);
          return record.key;
        }
        // No bundled types: try DefinitelyTyped.
        if (!name.startsWith('@types/')) {
          const typesName = typesPackageFor(name);
          const found = await this.ensureEntry({ name: typesName, subpath }, 'latest');
          this.errors.delete(typesName);
          if (found) {
            record.deps.add(found);
            return record.key;
          }
        }
        this.errors.set(name, `No type declarations found for '${name}${subpath}'.`);
        return null;
      })();
      this.entries.set(entryKey, done);
    }
    return done;
  }

  private async crawl(record: PackageRecord, path: string): Promise<void> {
    const key = `${record.key}/${path}`;
    if (this.crawled.has(key) || this.fileCount >= MAX_FILES) return;
    this.crawled.add(key);
    this.fileCount++;

    let text: string;
    try {
      text = await this.limit(() =>
        this.source.readFile(record.name, record.version, path)
      );
    } catch {
      return; // A missing file becomes a "Cannot find module" from tsrs.
    }
    record.files.set(path, text);

    const dir = dirname(path);
    const work: Promise<unknown>[] = [];
    for (const ref of referencePaths(text)) {
      work.push(this.crawlRelative(record, dir, ref));
    }
    for (const spec of moduleReferences(text)) {
      if (spec.startsWith('.')) {
        work.push(this.crawlRelative(record, dir, spec));
        continue;
      }
      const bare = parseBareSpecifier(spec);
      if (!bare) continue;
      if (bare.name === record.name) {
        const entry = typesEntry(record.pkg, bare.subpath, (p) => record.list.has(p));
        if (entry) work.push(this.crawl(record, entry));
        continue;
      }
      const range = dependencyRange(record.pkg, bare.name) ?? 'latest';
      work.push(
        this.ensureEntry(bare, range).then((dep) => {
          if (dep) record.deps.add(dep);
        })
      );
    }
    await Promise.all(work);
  }

  private crawlRelative(record: PackageRecord, dir: string, spec: string) {
    const base = joinPath(dir, spec);
    const candidates = [...declarationCandidates(base), `${base}/index.d.ts`];
    const found = candidates.find((p) => record.list.has(p));
    return found ? this.crawl(record, found) : Promise.resolve();
  }
  private async limit<T>(task: () => Promise<T>): Promise<T> {
    while (this.active >= CONCURRENCY) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active++;
    try {
      return await task();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}
