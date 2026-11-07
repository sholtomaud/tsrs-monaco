// A project linked to a GitHub repository: importing a repository (or a
// folder of it) as a project, working out what changed, and opening a pull
// request with those changes. Commits are made with the Git Data API (blobs,
// a tree, a commit, a branch), so nothing is cloned and no server is needed.

import type { ProjectFiles } from '../compiler/project.ts';
import { GitHubClient, GitHubError, type PullRequest, type TreeEntry } from './api.ts';

/** Where a project lives on GitHub. Saved with the workspace (no secrets). */
export interface RepoLink {
  owner: string;
  repo: string;
  /** The branch pull requests target. */
  base: string;
  /** The folder of the repository the project is, '' for the root. */
  dir: string;
  /** Files that came from the repository, so deleting one here deletes it there. */
  tracked?: string[];
}

export const repoName = (link: Pick<RepoLink, 'owner' | 'repo'>) => `${link.owner}/${link.repo}`;

/** owner/repo, a github.com URL, or owner/repo/tree/branch/dir. */
export function parseRepoInput(input: string): { owner: string; repo: string; branch?: string; dir?: string } | null {
  const text = input.trim().replace(/^https?:\/\/(www\.)?github\.com\//, '').replace(/\.git$/, '').replace(/\/+$/, '');
  const m = /^([A-Za-z0-9-]+)\/([\w.-]+)(?:\/tree\/([^/]+)(?:\/(.+))?)?$/.exec(text);
  if (!m) return null;
  return { owner: m[1], repo: m[2], branch: m[3], dir: m[4] };
}

const repoPath = (link: RepoLink, path: string) => (link.dir ? `${link.dir}/${path}` : path);

/** The SHA-1 git gives a file's contents: sha1("blob <bytes>\0<bytes>"). */
export async function gitBlobSha(text: string): Promise<string> {
  const body = new TextEncoder().encode(text);
  const header = new TextEncoder().encode(`blob ${body.length}\0`);
  const bytes = new Uint8Array(header.length + body.length);
  bytes.set(header);
  bytes.set(body, header.length);
  const digest = await crypto.subtle.digest('SHA-1', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface Change {
  /** Relative to the project. */
  path: string;
  kind: 'added' | 'modified' | 'deleted';
}

/** Paths a pull request never includes. */
const IGNORED = /(^|\/)(node_modules|dist)\//;

/**
 * What a pull request from the project would change, against the files on
 * `base` (the repository's tree). Files are only deleted if they were imported.
 */
export async function planChanges(files: ProjectFiles, link: RepoLink, tree: TreeEntry[]): Promise<Change[]> {
  const remote = new Map(tree.filter((e) => e.type === 'blob').map((e) => [e.path, e]));
  const changes: Change[] = [];
  for (const path of Object.keys(files).sort()) {
    if (IGNORED.test(path)) continue;
    const entry = remote.get(repoPath(link, path));
    if (!entry) changes.push({ path, kind: 'added' });
    else if ((await gitBlobSha(files[path])) !== entry.sha) changes.push({ path, kind: 'modified' });
  }
  for (const path of link.tracked ?? []) {
    if (!(path in files) && remote.has(repoPath(link, path))) changes.push({ path, kind: 'deleted' });
  }
  return changes;
}

/** Changes against the repository's base branch right now. */
export async function fetchChanges(client: GitHubClient, files: ProjectFiles, link: RepoLink): Promise<{ changes: Change[]; baseSha: string; truncated: boolean }> {
  const baseSha = await client.branchSha(link.owner, link.repo, link.base);
  const treeSha = await client.commitTree(link.owner, link.repo, baseSha);
  const tree = await client.tree(link.owner, link.repo, treeSha);
  return { changes: await planChanges(files, link, tree.tree), baseSha, truncated: tree.truncated };
}

export interface PullRequestRequest {
  link: RepoLink;
  files: ProjectFiles;
  branch: string;
  title: string;
  body: string;
  commitMessage: string;
  draft: boolean;
  onProgress?: (message: string) => void;
}

export interface PullRequestResult {
  pullRequest: PullRequest;
  changes: Change[];
  /** owner/repo the branch was pushed to: the repository, or the user's fork. */
  pushedTo: string;
}

/** A branch name git accepts. */
export function checkBranchName(name: string): string | null {
  if (!name.trim()) return 'Name the branch.';
  if (/[\s~^:?*[\\]|\.\.|@\{|\/\/|^\/|\/$|\.lock$|^\.|\/\.|\.$/.test(name)) return `"${name}" is not a valid branch name.`;
  return null;
}

export const suggestBranch = (project: string, now = new Date()) =>
  `tsrs-monaco/${project.toLowerCase().replace(/[^a-z0-9-]+/g, '-')}-${now.toISOString().slice(0, 16).replace(/[-:T]/g, '')}`;

async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]);
      }
    })
  );
  return results;
}

/** A fork of the repository the user can push to, made if needed. */
async function forkFor(client: GitHubClient, owner: string, repo: string, base: string, progress: (m: string) => void): Promise<{ owner: string; repo: string }> {
  progress(`You can't push to ${owner}/${repo}; using your fork…`);
  const fork = await client.fork(owner, repo);
  const target = { owner: fork.owner.login, repo: fork.name };
  // A new fork takes a few seconds to appear.
  for (let attempt = 0; ; attempt++) {
    try {
      await client.branchSha(target.owner, target.repo, base);
      break;
    } catch (error) {
      if (attempt >= 15 || !(error instanceof GitHubError) || (error.status !== 404 && error.status !== 409)) throw error;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  try {
    await client.syncFork(target.owner, target.repo, base);
  } catch {
    // An out-of-date fork still works: the commit's parent is the upstream branch.
  }
  return target;
}

/** Commits the project's changes to a new branch and opens a pull request. */
export async function createPullRequest(client: GitHubClient, request: PullRequestRequest): Promise<PullRequestResult> {
  const { link, files } = request;
  const progress = request.onProgress ?? (() => {});
  const branchError = checkBranchName(request.branch);
  if (branchError) throw new GitHubError(0, branchError);

  progress(`Reading ${repoName(link)}@${link.base}…`);
  const repository = await client.repository(link.owner, link.repo);
  const { changes, baseSha, truncated } = await fetchChanges(client, files, link);
  if (!changes.length) throw new GitHubError(0, `Nothing to commit: the project matches ${repoName(link)}@${link.base}.`);
  if (truncated) progress('The repository is large; its file list was truncated, so unchanged files may be re-uploaded.');

  const target = repository.permissions?.push ? { owner: link.owner, repo: link.repo } : await forkFor(client, link.owner, link.repo, link.base, progress);

  const uploads = changes.filter((c) => c.kind !== 'deleted');
  let done = 0;
  const shas = await pool(uploads, 4, async (c) => {
    const sha = await client.createBlob(target.owner, target.repo, files[c.path]);
    progress(`Uploading files (${++done} of ${uploads.length})…`);
    return sha;
  });
  progress('Committing…');
  const baseTree = await client.commitTree(link.owner, link.repo, baseSha);
  const tree = await client.createTree(target.owner, target.repo, baseTree, [
    ...uploads.map((c, i) => ({ path: repoPath(link, c.path), mode: '100644', type: 'blob' as const, sha: shas[i] })),
    ...changes.filter((c) => c.kind === 'deleted').map((c) => ({ path: repoPath(link, c.path), mode: '100644', type: 'blob' as const, sha: null })),
  ]);
  const commit = await client.createCommit(target.owner, target.repo, request.commitMessage, tree, baseSha);
  progress(`Pushing ${request.branch}…`);
  try {
    await client.createBranch(target.owner, target.repo, request.branch, commit);
  } catch (error) {
    if (error instanceof GitHubError && error.status === 422) {
      throw new GitHubError(422, `A branch ${request.branch} already exists in ${target.owner}/${target.repo}; choose another name.`);
    }
    throw error;
  }
  progress('Opening the pull request…');
  const head = target.owner === link.owner ? request.branch : `${target.owner}:${request.branch}`;
  const pullRequest = await client.createPullRequest(link.owner, link.repo, {
    title: request.title,
    body: request.body,
    head,
    base: link.base,
    draft: request.draft,
  });
  return { pullRequest, changes, pushedTo: `${target.owner}/${target.repo}` };
}

export interface ImportResult {
  files: ProjectFiles;
  link: RepoLink;
  skipped: { path: string; reason: string }[];
}

export const IMPORT_LIMITS = { files: 400, bytes: 512 * 1024 };

const BINARY = /\.(png|jpe?g|gif|webp|ico|bmp|pdf|zip|gz|tgz|wasm|woff2?|ttf|otf|eot|mp[34]|wav|ogg|mov|avi|jar|exe|dll|so|dylib|bin|onnx|pb|lock)$/i;

/** Fetches a repository's text files (or a folder's) as a project. */
export async function importRepository(
  client: GitHubClient,
  source: { owner: string; repo: string; branch?: string; dir?: string },
  onProgress: (message: string) => void = () => {}
): Promise<ImportResult> {
  const repository = await client.repository(source.owner, source.repo);
  const base = source.branch ?? repository.default_branch;
  const dir = (source.dir ?? '').replace(/^\/+|\/+$/g, '');
  onProgress(`Reading ${repository.full_name}@${base}…`);
  const sha = await client.branchSha(source.owner, source.repo, base);
  const tree = await client.tree(source.owner, source.repo, await client.commitTree(source.owner, source.repo, sha));
  const prefix = dir ? `${dir}/` : '';
  const skipped: ImportResult['skipped'] = [];
  const wanted: TreeEntry[] = [];
  for (const entry of tree.tree) {
    if (entry.type !== 'blob' || !entry.path.startsWith(prefix)) continue;
    const path = entry.path.slice(prefix.length);
    if (IGNORED.test(path) || /(^|\/)package-lock\.json$/.test(path)) skipped.push({ path, reason: 'not needed in the playground' });
    else if (BINARY.test(path)) skipped.push({ path, reason: 'binary' });
    else if ((entry.size ?? 0) > IMPORT_LIMITS.bytes) skipped.push({ path, reason: 'larger than 512 KiB' });
    else if (entry.mode === '120000') skipped.push({ path, reason: 'a symbolic link' });
    else wanted.push(entry);
  }
  if (!wanted.length && !skipped.length) throw new GitHubError(404, dir ? `${repository.full_name} has no folder ${dir}.` : `${repository.full_name} is empty.`);
  for (const extra of wanted.splice(IMPORT_LIMITS.files)) skipped.push({ path: extra.path.slice(prefix.length), reason: `over the ${IMPORT_LIMITS.files}-file limit` });

  const files: ProjectFiles = {};
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let done = 0;
  await pool(wanted, 6, async (entry) => {
    const path = entry.path.slice(prefix.length);
    const blob = await client.blob(source.owner, source.repo, entry.sha);
    onProgress(`Downloading files (${++done} of ${wanted.length})…`);
    const binary = atob(blob.content.replace(/\n/g, ''));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    try {
      const text = decoder.decode(bytes);
      if (text.includes('\u0000')) throw new Error('binary');
      files[path] = text;
    } catch {
      skipped.push({ path, reason: 'binary' });
    }
  });
  const sorted = Object.fromEntries(Object.keys(files).sort().map((p) => [p, files[p]]));
  return {
    files: sorted,
    link: { owner: repository.owner.login, repo: repository.name, base, dir, tracked: Object.keys(sorted) },
    skipped: skipped.sort((a, b) => a.path.localeCompare(b.path)),
  };
}
