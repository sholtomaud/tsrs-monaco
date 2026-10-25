import type { PackageJson } from './package-json.ts';
import type { PackageSource } from './type-acquisition.ts';

/**
 * A PackageSource over in-memory packages: name -> version -> path -> text.
 * 'latest' and ranges resolve to the highest version present. Used by tests.
 */
export class MemorySource implements PackageSource {
  requests: string[] = [];
  private packages: Record<string, Record<string, Record<string, string>>>;

  constructor(packages: Record<string, Record<string, Record<string, string>>>) {
    this.packages = packages;
  }

  private files(name: string, version: string) {
    const files = this.packages[name]?.[version];
    if (!files) throw new Error(`404 ${name}@${version}`);
    return files;
  }

  async resolveVersion(name: string, range: string) {
    const versions = Object.keys(this.packages[name] ?? {});
    if (!versions.length) throw new Error(`404 ${name}`);
    const exact = range.replace(/^[\^~]/, '');
    return versions.includes(exact) ? exact : versions.sort().at(-1)!;
  }

  async packageJson(name: string, version: string): Promise<PackageJson> {
    return JSON.parse(this.files(name, version)['package.json'] ?? '{}');
  }

  async listFiles(name: string, version: string) {
    return Object.keys(this.files(name, version));
  }

  async readFile(name: string, version: string, path: string) {
    this.requests.push(`${name}@${version}/${path}`);
    const text = this.files(name, version)[path];
    if (text === undefined) throw new Error(`404 ${path}`);
    return text;
  }
}
