// The GitHub side bar view: sign in with a token, link the active project
// to a repository (or import one as a new project), see what changed, and
// open a pull request, after running the project's workflows here first.

import type { ProjectFiles } from '../../compiler/project.ts';
import type { WorkflowRun } from '../../actions/runner.ts';
import { GitHubError } from '../../github/api.ts';
import { NEW_TOKEN_URL, getGitHubAuth, type GitHubAuth } from '../../github/auth.ts';
import {
  checkBranchName,
  createPullRequest,
  fetchChanges,
  importRepository,
  parseRepoInput,
  repoName,
  suggestBranch,
  type Change,
  type ImportResult,
  type RepoLink,
} from '../../github/repository.ts';
import { codicon } from '../../workspace/icons.ts';
import { h } from './dom.ts';
import { stateOf } from './actions-view.ts';

export interface GitHubHost {
  project(): string;
  files(): ProjectFiles;
  link(): RepoLink | undefined;
  setLink(link: RepoLink | undefined): void;
  openFile(path: string): void;
  importProject(result: ImportResult): void;
  /** Runs the workflows a pull request to `base` would trigger. */
  runWorkflows(base: string): Promise<WorkflowRun[]>;
}

interface Draft {
  branch: string;
  title: string;
  body: string;
  draft: boolean;
  runFirst: boolean;
}

const message = (error: unknown) => {
  if (error instanceof GitHubError) {
    if (error.status === 403 || error.status === 404) {
      return `${error.message}. Check that the token can access this repository, with read and write access to Contents and Pull requests.`;
    }
    return error.message;
  }
  return (error as Error).message;
};

const KIND = { added: 'A', modified: 'M', deleted: 'D' } as const;

export class GitHubView {
  private el: HTMLElement;
  private host: GitHubHost;
  private auth: GitHubAuth;
  private busy: string | null = null;
  private error: string | null = null;
  private notice: { text: string; url?: string } | null = null;
  private changes = new Map<string, { changes: Change[]; error?: string; loading: boolean }>();
  private drafts = new Map<string, Draft>();
  private editingLink = false;
  /** Runs that failed before a pull request: offer to open it anyway. */
  private failedRuns: WorkflowRun[] | null = null;

  constructor(el: HTMLElement, host: GitHubHost, auth = getGitHubAuth()) {
    this.el = el;
    this.host = host;
    this.auth = auth;
    auth.addEventListener('change', () => this.render());
    void auth.restore().then(() => this.render());
  }

  get user() {
    return this.auth.current?.user;
  }

  private draft(): Draft {
    const project = this.host.project();
    let d = this.drafts.get(project);
    if (!d) {
      d = { branch: suggestBranch(project), title: `Update ${project}`, body: '', draft: false, runFirst: true };
      this.drafts.set(project, d);
    }
    return d;
  }

  /** Re-renders; call when the active project or its files change. */
  render() {
    const session = this.auth.current;
    const body = h('div', { class: 'view-body' });
    if (this.error) body.append(h('p', { class: 'view-error', role: 'alert' }, this.error));
    if (this.notice) {
      body.append(h('p', { class: 'view-notice', role: 'status' }, this.notice.text, ' ', this.notice.url ? h('a', { href: this.notice.url, target: '_blank', rel: 'noopener noreferrer' }, this.notice.url.replace('https://github.com/', '')) : null));
    }
    if (!session) body.append(this.signInForm());
    else {
      body.append(
        h('div', { class: 'account' },
          h('img', { src: session.user.avatar_url, alt: '', width: 20, height: 20 }),
          h('span', {}, 'Signed in as ', h('strong', { id: 'github-login' }, session.user.login)),
          h('button', { class: 'icon-button', title: 'Sign out (forgets the token)', 'aria-label': 'Sign Out', onclick: () => this.auth.signOut() }, codicon('signOut'))
        ),
        this.repositorySection(),
        this.host.link() && !this.editingLink ? this.changesSection() : '',
        this.host.link() && !this.editingLink ? this.pullRequestSection() : '',
        this.importSection()
      );
    }
    if (this.busy) body.append(h('p', { class: 'view-progress', role: 'status' }, codicon('sync', 'spin'), ` ${this.busy}`));
    this.el.replaceChildren(
      h('div', { class: 'sidebar-title' }, h('h2', {}, 'GitHub'),
        h('div', { class: 'sidebar-actions' }, session && this.host.link() ? h('button', { class: 'icon-button', title: 'Refresh Changes', 'aria-label': 'Refresh Changes', onclick: () => void this.refreshChanges() }, codicon('refresh')) : '')),
      body
    );
  }

  private async task(label: string, fn: () => Promise<void>) {
    if (this.busy) return;
    this.busy = label;
    this.error = null;
    this.notice = null;
    this.render();
    try {
      await fn();
    } catch (error) {
      this.error = message(error);
    } finally {
      this.busy = null;
      this.render();
    }
  }

  // ---- Sign in -------------------------------------------------------------------

  private signInForm() {
    const token = h('input', { id: 'github-token', class: 'view-input', type: 'password', autocomplete: 'off', spellcheck: false, placeholder: 'github_pat_…', 'aria-label': 'Personal access token' });
    const remember = h('input', { id: 'github-remember', type: 'checkbox' });
    const submit = (e: Event) => {
      e.preventDefault();
      void this.task('Checking the token with GitHub…', async () => {
        await this.auth.signIn(token.value, { remember: remember.checked });
      });
    };
    return h('form', { class: 'view-form', onsubmit: submit },
      h('p', { class: 'view-text' }, 'Sign in to open pull requests from the playground. Use a ',
        h('a', { href: NEW_TOKEN_URL, target: '_blank', rel: 'noopener noreferrer' }, 'fine-grained personal access token'),
        ' for the repositories you choose, with read and write access to Contents, Pull requests and (to change workflow files) Workflows.'),
      h('label', { class: 'view-label' }, 'Token', token),
      h('label', { class: 'view-check' }, remember, 'Remember on this device'),
      h('button', { class: 'action action-primary', type: 'submit', id: 'github-sign-in' }, codicon('github'), h('span', {}, 'Sign In')),
      h('p', { class: 'view-hint' }, 'The token stays in this browser (for this tab only, unless remembered) and is only sent to api.github.com. It is never saved with your projects.')
    );
  }

  // ---- Repository link -----------------------------------------------------------

  private repositorySection() {
    const link = this.host.link();
    const project = this.host.project();
    if (link && !this.editingLink) {
      return h('section', { class: 'view-section' },
        h('h3', {}, 'Repository'),
        h('p', { class: 'repo-link', id: 'github-link' },
          codicon('repo'), ' ',
          h('a', { href: `https://github.com/${repoName(link)}/tree/${link.base}${link.dir ? `/${link.dir}` : ''}`, target: '_blank', rel: 'noopener noreferrer' }, `${repoName(link)}${link.dir ? `/${link.dir}` : ''}`),
          h('span', { class: 'view-hint' }, ` → ${link.base}`)
        ),
        h('div', { class: 'view-buttons' },
          h('button', { class: 'action', onclick: () => { this.editingLink = true; this.render(); } }, h('span', {}, 'Change…')),
          h('button', { class: 'action', onclick: () => { this.host.setLink(undefined); this.changes.delete(project); this.render(); } }, h('span', {}, 'Unlink'))
        )
      );
    }
    const repo = h('input', { id: 'github-repo', class: 'view-input', placeholder: 'owner/repo', spellcheck: false, value: link ? repoName(link) : '' });
    const base = h('input', { id: 'github-base', class: 'view-input', placeholder: 'the default branch', spellcheck: false, value: link?.base ?? '' });
    const dir = h('input', { id: 'github-dir', class: 'view-input', placeholder: '(the root)', spellcheck: false, value: link?.dir ?? '' });
    const submit = (e: Event) => {
      e.preventDefault();
      void this.task('Looking up the repository…', async () => {
        const parsed = parseRepoInput(repo.value);
        if (!parsed) throw new Error('Enter a repository as owner/repo or a github.com URL.');
        const info = await this.auth.current!.client.repository(parsed.owner, parsed.repo);
        const branch = base.value.trim() || parsed.branch || info.default_branch;
        await this.auth.current!.client.branchSha(parsed.owner, parsed.repo, branch).catch(() => {
          throw new Error(`${info.full_name} has no branch ${branch}.`);
        });
        this.host.setLink({
          owner: info.owner.login,
          repo: info.name,
          base: branch,
          dir: (dir.value.trim() || parsed.dir || '').replace(/^\/+|\/+$/g, ''),
          // Keep the imported files when only the branch or folder changes.
          tracked: link && repoName(link) === info.full_name ? link.tracked : undefined,
        });
        this.editingLink = false;
        this.changes.delete(project);
        await this.loadChanges();
      });
    };
    return h('section', { class: 'view-section' },
      h('h3', {}, 'Repository'),
      h('form', { class: 'view-form', onsubmit: submit },
        h('p', { class: 'view-text' }, `Link ${project} to the repository its pull requests go to.`),
        h('label', { class: 'view-label' }, 'Repository', repo),
        h('label', { class: 'view-label' }, 'Base branch', base),
        h('label', { class: 'view-label' }, 'Folder in the repository', dir),
        h('div', { class: 'view-buttons' },
          h('button', { class: 'action action-primary', type: 'submit', id: 'github-link-submit' }, codicon('repo'), h('span', {}, 'Link Repository')),
          link ? h('button', { class: 'action', type: 'button', onclick: () => { this.editingLink = false; this.render(); } }, h('span', {}, 'Cancel')) : ''
        )
      )
    );
  }

  private importSection() {
    const input = h('input', { id: 'github-import', class: 'view-input', placeholder: 'owner/repo or …/tree/branch/folder', spellcheck: false });
    const submit = (e: Event) => {
      e.preventDefault();
      void this.task('Importing…', async () => {
        const parsed = parseRepoInput(input.value);
        if (!parsed) throw new Error('Enter a repository as owner/repo or a github.com URL.');
        const result = await importRepository(this.auth.current!.client, parsed, (m) => {
          this.busy = m;
          this.render();
        });
        this.host.importProject(result);
        const skipped = result.skipped.length ? ` (${result.skipped.length} skipped: ${result.skipped.slice(0, 3).map((s) => `${s.path}, ${s.reason}`).join('; ')}${result.skipped.length > 3 ? '; …' : ''})` : '';
        this.notice = { text: `Imported ${Object.keys(result.files).length} files from ${repoName(result.link)}@${result.link.base}${skipped}.` };
      });
    };
    return h('details', { class: 'view-section' },
      h('summary', {}, h('h3', {}, 'Open a Repository as a Project')),
      h('form', { class: 'view-form', onsubmit: submit },
        h('label', { class: 'view-label' }, 'Repository', input),
        h('button', { class: 'action', type: 'submit', id: 'github-import-submit' }, codicon('cloudDownload'), h('span', {}, 'Import'))
      )
    );
  }

  // ---- Changes ---------------------------------------------------------------------

  private async loadChanges() {
    const project = this.host.project();
    const link = this.host.link();
    const session = this.auth.current;
    if (!link || !session) return;
    this.changes.set(project, { changes: this.changes.get(project)?.changes ?? [], loading: true });
    this.render();
    try {
      const { changes } = await fetchChanges(session.client, this.host.files(), link);
      this.changes.set(project, { changes, loading: false });
    } catch (error) {
      this.changes.set(project, { changes: [], loading: false, error: message(error) });
    }
    this.render();
  }

  refreshChanges() {
    return this.loadChanges();
  }

  private changesSection() {
    const project = this.host.project();
    const state = this.changes.get(project);
    if (!state) queueMicrotask(() => void this.loadChanges());
    const list = state?.changes ?? [];
    return h('section', { class: 'view-section' },
      h('h3', {}, 'Changes ', h('span', { class: 'badge', 'data-count': list.length, id: 'github-change-count' }, String(list.length))),
      state?.error ? h('p', { class: 'view-error' }, state.error) : null,
      !state || state.loading ? h('p', { class: 'view-hint' }, 'Comparing with the repository…') : null,
      state && !state.loading && !state.error && !list.length ? h('p', { class: 'view-hint' }, `No changes from ${this.host.link()!.base}.`) : null,
      h('ul', { class: 'change-list', id: 'github-changes' }, ...list.map((c) =>
        h('li', {}, h('button', { 'data-kind': c.kind, disabled: c.kind === 'deleted', onclick: () => this.host.openFile(c.path) },
          h('span', { class: 'change-kind', title: c.kind }, KIND[c.kind]), h('span', {}, c.path)))
      ))
    );
  }

  // ---- Pull request --------------------------------------------------------------

  private pullRequestSection() {
    const d = this.draft();
    const link = this.host.link()!;
    const branch = h('input', { id: 'pr-branch', class: 'view-input', value: d.branch, spellcheck: false, oninput: (e: Event) => (d.branch = (e.target as HTMLInputElement).value) });
    const title = h('input', { id: 'pr-title', class: 'view-input', value: d.title, oninput: (e: Event) => (d.title = (e.target as HTMLInputElement).value) });
    const body = h('textarea', { id: 'pr-body', class: 'view-input', rows: 4, placeholder: 'What does this change?', oninput: (e: Event) => (d.body = (e.target as HTMLTextAreaElement).value) });
    body.value = d.body;
    const draft = h('input', { type: 'checkbox', checked: d.draft, onchange: (e: Event) => (d.draft = (e.target as HTMLInputElement).checked) });
    const runFirst = h('input', { id: 'pr-run-first', type: 'checkbox', checked: d.runFirst, onchange: (e: Event) => (d.runFirst = (e.target as HTMLInputElement).checked) });
    const changes = this.changes.get(this.host.project());
    const nothing = !!changes && !changes.loading && !changes.error && !changes.changes.length;
    return h('section', { class: 'view-section' },
      h('h3', {}, 'Pull Request'),
      h('form', { class: 'view-form', onsubmit: (e: Event) => { e.preventDefault(); void this.open(false); } },
        h('label', { class: 'view-label' }, 'Branch', branch),
        h('label', { class: 'view-label' }, 'Title', title),
        h('label', { class: 'view-label' }, 'Description', body),
        h('label', { class: 'view-check' }, runFirst, `Run the workflows for pull_request → ${link.base} first`),
        h('label', { class: 'view-check' }, draft, 'Open as a draft'),
        this.failedRuns
          ? h('div', { class: 'view-error', role: 'alert' },
            `${this.failedRuns.filter((r) => r.conclusion === 'failure').map((r) => r.name).join(', ')} failed here. Fix it, or open the pull request anyway.`,
            h('div', { class: 'view-buttons' }, h('button', { class: 'action', type: 'button', id: 'pr-anyway', onclick: () => void this.open(true) }, h('span', {}, 'Open Anyway'))))
          : null,
        h('button', { class: 'action action-primary', type: 'submit', id: 'pr-create', disabled: !!this.busy || nothing }, codicon('gitPullRequest'), h('span', {}, 'Create Pull Request'))
      )
    );
  }

  private async open(anyway: boolean) {
    const d = this.draft();
    const link = this.host.link();
    const session = this.auth.current;
    if (!link || !session) return;
    const branchError = checkBranchName(d.branch.trim());
    if (branchError) {
      this.error = branchError;
      this.render();
      return;
    }
    if (!d.title.trim()) {
      this.error = 'Give the pull request a title.';
      this.render();
      return;
    }
    let runs: WorkflowRun[] = [];
    if (d.runFirst && !anyway) {
      this.failedRuns = null;
      this.busy = 'Running the workflows…';
      this.error = null;
      this.render();
      try {
        runs = await this.host.runWorkflows(link.base);
      } finally {
        this.busy = null;
      }
      if (runs.some((r) => r.conclusion === 'failure' || r.conclusion === 'cancelled')) {
        this.failedRuns = runs;
        this.render();
        return;
      }
    } else if (anyway) runs = this.failedRuns ?? [];
    this.failedRuns = null;
    const project = this.host.project();
    await this.task('Creating the pull request…', async () => {
      const result = await createPullRequest(session.client, {
        link,
        files: this.host.files(),
        branch: d.branch.trim(),
        title: d.title.trim(),
        body: withChecks(d.body, runs),
        commitMessage: d.title.trim(),
        draft: d.draft,
        onProgress: (m) => {
          this.busy = m;
          this.render();
        },
      });
      this.notice = { text: `Opened pull request #${result.pullRequest.number} (${result.changes.length} file${result.changes.length === 1 ? '' : 's'}):`, url: result.pullRequest.html_url };
      // The next pull request starts from a fresh branch name.
      this.drafts.delete(project);
      this.changes.delete(project);
    });
  }
}

/** The description, with what the emulated workflows found. */
export function withChecks(body: string, runs: WorkflowRun[]): string {
  if (!runs.length) return body;
  const icon = { success: '✅', failure: '❌', cancelled: '⏹️', skipped: '⏭️', queued: '⏳', in_progress: '⏳', completed: '✅' } as const;
  const lines = runs.flatMap((r) => [
    `- ${icon[stateOf(r)]} **${r.name}** (\`${r.workflow}\`)${r.notEmulated.length ? ` — partly emulated: ${r.notEmulated.map((n) => n.tool).join(', ')}` : ''}`,
    ...r.jobs.map((j) => `  - ${icon[stateOf(j)]} ${j.name}`),
  ]);
  return `${body.trim() ? `${body.trim()}\n\n` : ''}<details><summary>Workflows run in the browser with tsrs × Monaco before opening this pull request</summary>\n\n${lines.join('\n')}\n\n</details>\n`;
}
