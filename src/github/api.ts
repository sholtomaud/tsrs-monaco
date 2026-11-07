// A small client for GitHub's REST API, the only code in the playground that
// talks to GitHub. api.github.com allows cross-origin requests, so the
// browser calls it directly with the user's token: no server in between.

export const API_URL = 'https://api.github.com';

export class GitHubError extends Error {
  readonly status: number;
  readonly documentation?: string;
  constructor(status: number, message: string, documentation?: string) {
    super(message);
    this.status = status;
    this.documentation = documentation;
  }
}

export interface User {
  login: string;
  name: string | null;
  avatar_url: string;
  html_url: string;
}

export interface Repository {
  full_name: string;
  name: string;
  owner: { login: string };
  default_branch: string;
  private: boolean;
  fork: boolean;
  html_url: string;
  permissions?: { admin: boolean; push: boolean; pull: boolean };
  parent?: { full_name: string };
}

export interface TreeEntry {
  path: string;
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
  size?: number;
}

export interface PullRequest {
  number: number;
  html_url: string;
  title: string;
  head: { ref: string };
  base: { ref: string };
}

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export class GitHubClient {
  private token: string;
  private fetchImpl: Fetch;
  private apiUrl: string;
  /** Scopes of a classic token (fine-grained tokens report none). */
  scopes: string[] | null = null;

  constructor(token: string, fetchImpl: Fetch = (i, init) => fetch(i, init), apiUrl = API_URL) {
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.apiUrl = apiUrl;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.apiUrl}${path}`, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store',
      });
    } catch (error) {
      throw new GitHubError(0, `Couldn't reach GitHub: ${(error as Error).message}`);
    }
    const scopes = response.headers.get('x-oauth-scopes');
    if (scopes !== null) this.scopes = scopes.split(',').map((s) => s.trim()).filter(Boolean);
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    const data = text ? JSON.parse(text) : undefined;
    if (!response.ok) {
      const details = Array.isArray(data?.errors)
        ? data.errors.map((e: { message?: string; code?: string }) => e.message ?? e.code).filter(Boolean).join('; ')
        : '';
      const message = `${data?.message ?? response.statusText}${details ? ` (${details})` : ''}`;
      throw new GitHubError(response.status, message, data?.documentation_url);
    }
    return data as T;
  }

  user() {
    return this.request<User>('GET', '/user');
  }

  repository(owner: string, repo: string) {
    return this.request<Repository>('GET', `/repos/${owner}/${repo}`);
  }

  async branchSha(owner: string, repo: string, branch: string): Promise<string> {
    const ref = await this.request<{ object: { sha: string } }>('GET', `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch).replace(/%2F/g, '/')}`);
    return ref.object.sha;
  }

  async commitTree(owner: string, repo: string, commit: string): Promise<string> {
    const c = await this.request<{ tree: { sha: string } }>('GET', `/repos/${owner}/${repo}/git/commits/${commit}`);
    return c.tree.sha;
  }

  tree(owner: string, repo: string, sha: string) {
    return this.request<{ sha: string; tree: TreeEntry[]; truncated: boolean }>('GET', `/repos/${owner}/${repo}/git/trees/${sha}?recursive=1`);
  }

  blob(owner: string, repo: string, sha: string) {
    return this.request<{ content: string; encoding: string; size: number }>('GET', `/repos/${owner}/${repo}/git/blobs/${sha}`);
  }

  async createBlob(owner: string, repo: string, content: string): Promise<string> {
    const b = await this.request<{ sha: string }>('POST', `/repos/${owner}/${repo}/git/blobs`, { content, encoding: 'utf-8' });
    return b.sha;
  }

  async createTree(owner: string, repo: string, baseTree: string, tree: { path: string; mode: string; type: 'blob'; sha: string | null }[]): Promise<string> {
    const t = await this.request<{ sha: string }>('POST', `/repos/${owner}/${repo}/git/trees`, { base_tree: baseTree, tree });
    return t.sha;
  }

  async createCommit(owner: string, repo: string, message: string, tree: string, parent: string): Promise<string> {
    const c = await this.request<{ sha: string }>('POST', `/repos/${owner}/${repo}/git/commits`, { message, tree, parents: [parent] });
    return c.sha;
  }

  createBranch(owner: string, repo: string, branch: string, sha: string) {
    return this.request('POST', `/repos/${owner}/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha });
  }

  createPullRequest(owner: string, repo: string, pr: { title: string; body: string; head: string; base: string; draft: boolean }) {
    return this.request<PullRequest>('POST', `/repos/${owner}/${repo}/pulls`, { ...pr, maintainer_can_modify: true });
  }

  fork(owner: string, repo: string) {
    return this.request<Repository>('POST', `/repos/${owner}/${repo}/forks`, { default_branch_only: true });
  }

  /** Brings a fork's branch up to date with its upstream (best effort). */
  syncFork(owner: string, repo: string, branch: string) {
    return this.request('POST', `/repos/${owner}/${repo}/merge-upstream`, { branch });
  }
}
