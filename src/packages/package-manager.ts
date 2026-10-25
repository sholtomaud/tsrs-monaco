// Ties npm support together for the playground: which packages the project
// imports, their declaration files for tsrs, and their runtime URLs.

import { isSourceFile, type ProjectFiles } from '../compiler/project.ts';
import { ESM_SH, JsDelivrSource, runtimeUrl } from './cdn.ts';
import { bareImports, type BareSpecifier } from './specifiers.ts';
import { TypeAcquirer, type Acquisition, type PackageSource } from './type-acquisition.ts';

export const PACKAGE_JSON = 'package.json';

/** Version ranges from the project's own package.json, if it has one. */
export function projectRanges(files: ProjectFiles): Record<string, string> {
  try {
    const pkg = JSON.parse(files[PACKAGE_JSON] ?? '{}');
    return { ...pkg.devDependencies, ...pkg.dependencies };
  } catch {
    return {};
  }
}

export function packageJsonError(files: ProjectFiles): string | null {
  if (files[PACKAGE_JSON] === undefined) return null;
  try {
    JSON.parse(files[PACKAGE_JSON]);
    return null;
  } catch (error) {
    return `package.json is not valid JSON, so its versions are ignored: ${(error as Error).message}`;
  }
}

export function projectImports(files: ProjectFiles): BareSpecifier[] {
  const seen = new Set<string>();
  const out: BareSpecifier[] = [];
  for (const [path, text] of Object.entries(files)) {
    if (!isSourceFile(path) && !path.endsWith('.d.ts')) continue;
    for (const spec of bareImports(text)) {
      const key = spec.name + spec.subpath;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(spec);
      }
    }
  }
  return out;
}

export class PackageManager {
  private source: PackageSource;
  private acquirer: TypeAcquirer;
  private urls = new Map<string, Promise<string>>();

  constructor(source: PackageSource = new JsDelivrSource()) {
    this.source = source;
    this.acquirer = new TypeAcquirer(source);
  }

  /** Declaration files for every package the project imports. */
  async types(files: ProjectFiles): Promise<Acquisition> {
    const result = await this.acquirer.acquire(projectImports(files), projectRanges(files));
    const error = packageJsonError(files);
    return error ? { ...result, errors: [error, ...result.errors] } : result;
  }

  /**
   * Maps each bare specifier in the emitted JavaScript to a URL, using the
   * versions the types were fetched for so types and runtime agree.
   */
  async runtimeImports(
    modules: Record<string, string>,
    files: ProjectFiles,
    versions: Record<string, string>
  ): Promise<Record<string, string>> {
    const ranges = projectRanges(files);
    const specs = new Map<string, BareSpecifier>();
    for (const code of Object.values(modules)) {
      for (const spec of bareImports(code)) specs.set(spec.name + spec.subpath, spec);
    }
    const entries = await Promise.all(
      [...specs].map(async ([spec, { name, subpath }]) => {
        try {
          const version =
            versions[name] ??
            (await this.source.resolveVersion(name, ranges[name] ?? 'latest'));
          const key = `${name}@${version}${subpath}`;
          let url = this.urls.get(key);
          if (!url) {
            url = runtimeUrl(this.source, name, version, subpath);
            this.urls.set(key, url);
          }
          return [spec, await url] as const;
        } catch {
          // Let esm.sh resolve it (and report the error if it can't).
          return [spec, `${ESM_SH}/${spec}`] as const;
        }
      })
    );
    return Object.fromEntries(entries);
  }
}

let shared: PackageManager | null = null;

/** One package manager for the app, so fetched types survive page changes. */
export function getPackageManager(): PackageManager {
  shared ??= new PackageManager();
  return shared;
}
