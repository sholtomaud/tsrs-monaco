// Signing in to GitHub with a personal access token. A static page can't use
// GitHub's OAuth flows on its own (the web flow needs a client secret, and
// the device flow's endpoints don't allow cross-origin requests), so the user
// pastes a fine-grained token scoped to the repositories they choose.
//
// The token is kept out of the workspace (which is saved to localStorage and
// may be exported): it lives in sessionStorage, so it is forgotten when the
// tab closes, or in localStorage only if the user asks to be remembered.

import { GitHubClient, GitHubError, type Fetch, type User } from './api.ts';

const TOKEN_KEY = 'tsrs-monaco:github-token';

/** Where to make a token, with the permissions a pull request needs. */
export const NEW_TOKEN_URL =
  'https://github.com/settings/personal-access-tokens/new?name=tsrs%20%C3%97%20Monaco&description=Open%20pull%20requests%20from%20the%20tsrs%20%C3%97%20Monaco%20playground&contents=write&pull_requests=write&workflows=write';

export interface Session {
  user: User;
  client: GitHubClient;
  remembered: boolean;
}

interface TokenStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

const storage = (kind: 'local' | 'session'): TokenStore => ({
  get: (key) => {
    try {
      return (kind === 'local' ? localStorage : sessionStorage).getItem(key);
    } catch {
      return null;
    }
  },
  set: (key, value) => {
    try {
      (kind === 'local' ? localStorage : sessionStorage).setItem(key, value);
    } catch {
      // Private mode: the token lasts as long as the page.
    }
  },
  remove: (key) => {
    try {
      (kind === 'local' ? localStorage : sessionStorage).removeItem(key);
    } catch {
      // Nothing stored.
    }
  },
});

export const looksLikeToken = (token: string) => /^(github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,})$/.test(token.trim());

export class GitHubAuth extends EventTarget {
  private session: Session | null = null;
  private restoring: Promise<Session | null> | null = null;
  private fetchImpl?: Fetch;
  private stores: { local: TokenStore; session: TokenStore };

  constructor(options: { fetch?: Fetch; stores?: { local: TokenStore; session: TokenStore } } = {}) {
    super();
    this.fetchImpl = options.fetch;
    this.stores = options.stores ?? { local: storage('local'), session: storage('session') };
  }

  get current(): Session | null {
    return this.session;
  }

  /** Signs in again with a stored token, if there is one. */
  restore(): Promise<Session | null> {
    this.restoring ??= (async () => {
      const remembered = this.stores.local.get(TOKEN_KEY);
      const token = remembered ?? this.stores.session.get(TOKEN_KEY);
      if (!token) return null;
      try {
        return await this.signIn(token, { remember: remembered !== null });
      } catch (error) {
        // A revoked or expired token is forgotten; a network error is not.
        if (error instanceof GitHubError && error.status === 401) this.forget();
        return null;
      }
    })();
    return this.restoring;
  }

  /** Checks the token with GitHub, then keeps it. */
  async signIn(token: string, { remember = false } = {}): Promise<Session> {
    const trimmed = token.trim();
    if (!trimmed) throw new GitHubError(0, 'Paste a token first.');
    const client = new GitHubClient(trimmed, this.fetchImpl);
    let user: User;
    try {
      user = await client.user();
    } catch (error) {
      if (error instanceof GitHubError && error.status === 401) {
        throw new GitHubError(401, 'GitHub did not accept that token (it may be mistyped, expired or revoked).');
      }
      throw error;
    }
    this.forget();
    (remember ? this.stores.local : this.stores.session).set(TOKEN_KEY, trimmed);
    this.session = { user, client, remembered: remember };
    this.dispatchEvent(new Event('change'));
    return this.session;
  }

  signOut() {
    this.forget();
    this.session = null;
    this.restoring = null;
    this.dispatchEvent(new Event('change'));
  }

  private forget() {
    this.stores.local.remove(TOKEN_KEY);
    this.stores.session.remove(TOKEN_KEY);
  }
}

let auth: GitHubAuth | null = null;

/** The app's one sign-in. */
export function getGitHubAuth(): GitHubAuth {
  auth ??= new GitHubAuth();
  return auth;
}
