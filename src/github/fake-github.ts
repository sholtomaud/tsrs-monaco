// An in-memory GitHub, just the REST endpoints the playground calls, for
// unit tests (as a fetch) and e2e tests (behind page.route).

import { gitBlobSha } from './repository.ts';

interface FakeRepo {
  owner: string;
  name: string;
  defaultBranch: string;
  push: boolean;
  /** Branch → commit sha. */
  branches: Record<string, string>;
  parent?: string;
}

interface Commit {
  tree: string;
  parents: string[];
  message: string;
}

export interface FakeRequest {
  method: string;
  path: string;
  body?: unknown;
}

export class FakeGitHub {
  readonly token: string;
  readonly login: string;
  readonly requests: FakeRequest[] = [];
  readonly pulls: { repo: string; number: number; title: string; body: string; head: string; base: string; draft: boolean }[] = [];
  private repos = new Map<string, FakeRepo>();
  private blobs = new Map<string, string>();
  private trees = new Map<string, Map<string, { sha: string; mode: string }>>();
  private commits = new Map<string, Commit>();
  private counter = 0;

  constructor(options: { token?: string; login?: string } = {}) {
    this.token = options.token ?? 'github_pat_fake_0123456789abcdefghijklmnop';
    this.login = options.login ?? 'octocat';
  }

  private id(prefix: string) {
    return `${prefix}${(++this.counter).toString(16).padStart(40 - prefix.length, '0')}`;
  }

  /** Adds a repository whose default branch holds `files`. */
  async addRepo(fullName: string, files: Record<string, string>, options: { push?: boolean; branch?: string } = {}) {
    const [owner, name] = fullName.split('/');
    const entries = new Map<string, { sha: string; mode: string }>();
    for (const [path, text] of Object.entries(files)) {
      const sha = await gitBlobSha(text);
      this.blobs.set(sha, text);
      entries.set(path, { sha, mode: '100644' });
    }
    const tree = this.id('t');
    this.trees.set(tree, entries);
    const commit = this.id('c');
    this.commits.set(commit, { tree, parents: [], message: 'Initial commit' });
    const branch = options.branch ?? 'main';
    this.repos.set(fullName.toLowerCase(), { owner, name, defaultBranch: branch, push: options.push ?? true, branches: { [branch]: commit } });
  }

  /** The files of a branch, as they are now. */
  filesAt(fullName: string, branch: string): Record<string, string> | undefined {
    const repo = this.repos.get(fullName.toLowerCase());
    const commit = repo?.branches[branch];
    if (!commit) return undefined;
    const tree = this.trees.get(this.commits.get(commit)!.tree)!;
    return Object.fromEntries([...tree].map(([p, e]) => [p, this.blobs.get(e.sha)!]));
  }

  private repoJson(r: FakeRepo) {
    return {
      full_name: `${r.owner}/${r.name}`,
      name: r.name,
      owner: { login: r.owner },
      default_branch: r.defaultBranch,
      private: false,
      fork: !!r.parent,
      html_url: `https://github.com/${r.owner}/${r.name}`,
      permissions: { admin: r.push, push: r.push, pull: true },
      ...(r.parent ? { parent: { full_name: r.parent } } : {}),
    };
  }

  /** Handles one API request. */
  async handle(method: string, url: string, headers: Record<string, string>, body?: unknown): Promise<{ status: number; json?: unknown }> {
    const path = new URL(url).pathname;
    const query = new URL(url).searchParams;
    this.requests.push({ method, path, body });
    const auth = headers.authorization ?? headers.Authorization;
    if (auth !== `Bearer ${this.token}`) return { status: 401, json: { message: 'Bad credentials' } };
    if (method === 'GET' && path === '/user') {
      return { status: 200, json: { login: this.login, name: 'The Octocat', avatar_url: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=', html_url: `https://github.com/${this.login}` } };
    }
    const m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
    if (!m) return { status: 404, json: { message: 'Not Found' } };
    const [, owner, name, rest = ''] = m;
    const key = `${owner}/${name}`.toLowerCase();
    const repo = this.repos.get(key);
    const b = (body ?? {}) as Record<string, unknown>;

    if (rest === '/forks' && method === 'POST') {
      if (!repo) return { status: 404, json: { message: 'Not Found' } };
      const forkKey = `${this.login}/${repo.name}`.toLowerCase();
      if (!this.repos.has(forkKey)) {
        this.repos.set(forkKey, { owner: this.login, name: repo.name, defaultBranch: repo.defaultBranch, push: true, branches: { [repo.defaultBranch]: repo.branches[repo.defaultBranch] }, parent: `${repo.owner}/${repo.name}` });
      }
      return { status: 202, json: this.repoJson(this.repos.get(forkKey)!) };
    }
    if (!repo) return { status: 404, json: { message: 'Not Found' } };
    if (method === 'GET' && rest === '') return { status: 200, json: this.repoJson(repo) };

    const ref = /^\/git\/ref\/heads\/(.+)$/.exec(rest);
    if (method === 'GET' && ref) {
      const sha = repo.branches[decodeURIComponent(ref[1])];
      return sha ? { status: 200, json: { ref: `refs/heads/${ref[1]}`, object: { sha, type: 'commit' } } } : { status: 404, json: { message: 'Not Found' } };
    }
    const commit = /^\/git\/commits\/(\w+)$/.exec(rest);
    if (method === 'GET' && commit) {
      const c = this.commits.get(commit[1]);
      return c ? { status: 200, json: { sha: commit[1], tree: { sha: c.tree }, message: c.message } } : { status: 404, json: { message: 'Not Found' } };
    }
    const tree = /^\/git\/trees\/(\w+)$/.exec(rest);
    if (method === 'GET' && tree) {
      const t = this.trees.get(tree[1]);
      if (!t) return { status: 404, json: { message: 'Not Found' } };
      void query;
      return {
        status: 200,
        json: { sha: tree[1], truncated: false, tree: [...t].map(([p, e]) => ({ path: p, mode: e.mode, type: 'blob', sha: e.sha, size: this.blobs.get(e.sha)!.length })) },
      };
    }
    const blob = /^\/git\/blobs\/(\w+)$/.exec(rest);
    if (method === 'GET' && blob) {
      const text = this.blobs.get(blob[1]);
      if (text === undefined) return { status: 404, json: { message: 'Not Found' } };
      const bytes = new TextEncoder().encode(text);
      return { status: 200, json: { sha: blob[1], encoding: 'base64', size: bytes.length, content: btoa(String.fromCharCode(...bytes)) } };
    }
    // Anyone can open a pull request; only writing needs push access.
    if (!repo.push && method === 'POST' && rest !== '/pulls') return { status: 403, json: { message: 'Resource not accessible by personal access token' } };
    if (method === 'POST' && rest === '/git/blobs') {
      const sha = await gitBlobSha(String(b.content));
      this.blobs.set(sha, String(b.content));
      return { status: 201, json: { sha } };
    }
    if (method === 'POST' && rest === '/git/trees') {
      const base = this.trees.get(String(b.base_tree));
      if (!base) return { status: 422, json: { message: 'base_tree not found' } };
      const next = new Map(base);
      for (const e of b.tree as { path: string; mode: string; sha: string | null }[]) {
        if (e.sha === null) next.delete(e.path);
        else next.set(e.path, { sha: e.sha, mode: e.mode });
      }
      const sha = this.id('t');
      this.trees.set(sha, next);
      return { status: 201, json: { sha } };
    }
    if (method === 'POST' && rest === '/git/commits') {
      const sha = this.id('c');
      this.commits.set(sha, { tree: String(b.tree), parents: b.parents as string[], message: String(b.message) });
      return { status: 201, json: { sha } };
    }
    if (method === 'POST' && rest === '/git/refs') {
      const branch = String(b.ref).replace(/^refs\/heads\//, '');
      if (repo.branches[branch]) return { status: 422, json: { message: 'Reference already exists' } };
      repo.branches[branch] = String(b.sha);
      return { status: 201, json: { ref: b.ref, object: { sha: b.sha } } };
    }
    if (method === 'POST' && rest === '/merge-upstream') return { status: 200, json: { message: 'up to date' } };
    if (method === 'POST' && rest === '/pulls') {
      const pr = { repo: key, number: this.pulls.length + 1, title: String(b.title), body: String(b.body), head: String(b.head), base: String(b.base), draft: !!b.draft };
      this.pulls.push(pr);
      return { status: 201, json: { number: pr.number, html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pr.number}`, title: pr.title, head: { ref: pr.head }, base: { ref: pr.base } } };
    }
    return { status: 404, json: { message: `Not emulated: ${method} ${path}` } };
  }

  /** A fetch that answers from this fake. */
  fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const result = await this.handle(init.method ?? 'GET', input, headers, init.body ? JSON.parse(String(init.body)) : undefined);
    return new Response(result.json === undefined ? null : JSON.stringify(result.json), { status: result.status, headers: { 'content-type': 'application/json' } });
  };
}
