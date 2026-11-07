import { test, describe } from 'node:test';
import assert from 'node:assert';
import { GitHubClient } from './api.ts';
import { GitHubAuth, looksLikeToken } from './auth.ts';
import { FakeGitHub } from './fake-github.ts';
import {
  checkBranchName,
  createPullRequest,
  fetchChanges,
  gitBlobSha,
  importRepository,
  parseRepoInput,
  type RepoLink,
} from './repository.ts';

const memory = () => {
  const data = new Map<string, string>();
  return { data, get: (k: string) => data.get(k) ?? null, set: (k: string, v: string) => void data.set(k, v), remove: (k: string) => void data.delete(k) };
};

describe('GitHub sign-in', () => {
  test('checks the token, then keeps it for the session only unless remembered', async () => {
    const gh = new FakeGitHub();
    const stores = { local: memory(), session: memory() };
    const auth = new GitHubAuth({ fetch: gh.fetch, stores });
    const session = await auth.signIn(` ${gh.token} `);
    assert.strictEqual(session.user.login, 'octocat');
    assert.strictEqual(stores.session.data.size, 1);
    assert.strictEqual(stores.local.data.size, 0);

    await auth.signIn(gh.token, { remember: true });
    assert.strictEqual(stores.session.data.size, 0);
    assert.strictEqual(stores.local.data.size, 1);

    // A new page signs in again from storage.
    const again = new GitHubAuth({ fetch: gh.fetch, stores });
    assert.strictEqual((await again.restore())?.user.login, 'octocat');

    auth.signOut();
    assert.strictEqual(stores.local.data.size + stores.session.data.size, 0);
  });

  test('a rejected token is not kept', async () => {
    const gh = new FakeGitHub();
    const stores = { local: memory(), session: memory() };
    const auth = new GitHubAuth({ fetch: gh.fetch, stores });
    await assert.rejects(auth.signIn('github_pat_wrong'), /did not accept that token/);
    assert.strictEqual(stores.session.data.size, 0);
    assert.strictEqual(auth.current, null);
  });

  test('token shapes', () => {
    assert.ok(looksLikeToken('github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz'));
    assert.ok(looksLikeToken('ghp_abcdefghijklmnopqrstuvwxyz0123456789'));
    assert.ok(!looksLikeToken('password'));
  });
});

describe('repositories', () => {
  test('git blob shas match git hash-object', async () => {
    // printf 'hello\n' | git hash-object --stdin
    assert.strictEqual(await gitBlobSha('hello\n'), 'ce013625030ba8dba906f756967f9e9ca394464a');
    assert.strictEqual(await gitBlobSha(''), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  });

  test('parses repository references', () => {
    assert.deepStrictEqual(parseRepoInput('sholtomaud/tsrs-monaco'), { owner: 'sholtomaud', repo: 'tsrs-monaco', branch: undefined, dir: undefined });
    assert.deepStrictEqual(parseRepoInput('https://github.com/a/b.git'), { owner: 'a', repo: 'b', branch: undefined, dir: undefined });
    assert.deepStrictEqual(parseRepoInput('https://github.com/a/b/tree/dev/packages/x/'), { owner: 'a', repo: 'b', branch: 'dev', dir: 'packages/x' });
    assert.strictEqual(parseRepoInput('not a repo'), null);
  });

  test('branch names', () => {
    assert.strictEqual(checkBranchName('feature/x-1'), null);
    assert.ok(checkBranchName('has space'));
    assert.ok(checkBranchName('a..b'));
    assert.ok(checkBranchName(''));
  });

  test('imports a folder of a repository, skipping binaries', async () => {
    const gh = new FakeGitHub();
    await gh.addRepo('acme/site', { 'README.md': '# hi\n', 'app/src/index.ts': 'export {};\n', 'app/logo.png': 'x', 'app/tsconfig.json': '{}' });
    const result = await importRepository(new GitHubClient(gh.token, gh.fetch), { owner: 'acme', repo: 'site', dir: 'app' });
    assert.deepStrictEqual(result.files, { 'src/index.ts': 'export {};\n', 'tsconfig.json': '{}' });
    assert.deepStrictEqual(result.skipped, [{ path: 'logo.png', reason: 'binary' }]);
    assert.deepStrictEqual(result.link, { owner: 'acme', repo: 'site', base: 'main', dir: 'app', tracked: ['src/index.ts', 'tsconfig.json'] });
  });
});

describe('pull requests', () => {
  async function setup(options: { push?: boolean } = {}) {
    const gh = new FakeGitHub();
    await gh.addRepo('acme/lib', { 'README.md': '# lib\n', 'src/a.ts': 'export const a = 1;\n', 'src/old.ts': 'old\n' }, options);
    const client = new GitHubClient(gh.token, gh.fetch);
    const imported = await importRepository(client, { owner: 'acme', repo: 'lib' });
    return { gh, client, link: imported.link, files: imported.files };
  }

  test('only changed files are committed; removed imported files are deleted', async () => {
    const { gh, client, link, files } = await setup();
    const edited: Record<string, string> = { ...files, 'src/a.ts': 'export const a = 2;\n', 'src/b.ts': 'export const b = 1;\n' };
    delete edited['src/old.ts'];
    const { changes } = await fetchChanges(client, edited, link);
    assert.deepStrictEqual(changes, [
      { path: 'src/a.ts', kind: 'modified' },
      { path: 'src/b.ts', kind: 'added' },
      { path: 'src/old.ts', kind: 'deleted' },
    ]);

    const result = await createPullRequest(client, { link, files: edited, branch: 'feat/b', title: 'Add b', body: 'From the playground', commitMessage: 'Add b', draft: true });
    assert.strictEqual(result.pullRequest.html_url, 'https://github.com/acme/lib/pull/1');
    assert.strictEqual(result.pushedTo, 'acme/lib');
    assert.deepStrictEqual(gh.pulls[0], { repo: 'acme/lib', number: 1, title: 'Add b', body: 'From the playground', head: 'feat/b', base: 'main', draft: true });
    assert.deepStrictEqual(gh.filesAt('acme/lib', 'feat/b'), { 'README.md': '# lib\n', 'src/a.ts': 'export const a = 2;\n', 'src/b.ts': 'export const b = 1;\n' });
    // main is untouched, and only the two changed files were uploaded.
    assert.strictEqual(gh.filesAt('acme/lib', 'main')?.['src/a.ts'], 'export const a = 1;\n');
    assert.strictEqual(gh.requests.filter((r) => r.path.endsWith('/git/blobs') && r.method === 'POST').length, 2);
  });

  test('a project that is not imported never deletes files, and goes in its folder', async () => {
    const { gh, client } = await setup();
    const link: RepoLink = { owner: 'acme', repo: 'lib', base: 'main', dir: 'examples/demo' };
    await createPullRequest(client, { link, files: { 'src/index.ts': 'console.log(1);\n' }, branch: 'demo', title: 't', body: '', commitMessage: 'm', draft: false });
    assert.deepStrictEqual(Object.keys(gh.filesAt('acme/lib', 'demo')!).sort(), ['README.md', 'examples/demo/src/index.ts', 'src/a.ts', 'src/old.ts']);
  });

  test('without push access the branch goes to a fork', async () => {
    const { gh, client, link, files } = await setup({ push: false });
    const result = await createPullRequest(client, { link, files: { ...files, 'src/a.ts': 'changed\n' }, branch: 'fix', title: 't', body: '', commitMessage: 'm', draft: false });
    assert.strictEqual(result.pushedTo, 'octocat/lib');
    assert.strictEqual(gh.pulls[0].head, 'octocat:fix');
    assert.strictEqual(gh.filesAt('octocat/lib', 'fix')?.['src/a.ts'], 'changed\n');
  });

  test('no changes, or an existing branch, are explained', async () => {
    const { client, link, files } = await setup();
    const request = { link, branch: 'x', title: 't', body: '', commitMessage: 'm', draft: false };
    await assert.rejects(createPullRequest(client, { ...request, files }), /Nothing to commit/);
    const changed = { ...files, 'src/a.ts': 'z\n' };
    await createPullRequest(client, { ...request, files: changed });
    await assert.rejects(createPullRequest(client, { ...request, files: changed }), /already exists/);
  });
});
