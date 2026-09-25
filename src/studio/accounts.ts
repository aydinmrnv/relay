import { resolveExecutable, runProcess } from '../process/runner.ts';
import type { AccountId, GithubAccount } from './protocol.ts';

/**
 * GitHub, as a sign-in the companion can hold for itself.
 *
 * On someone's own computer Relay uses whatever `gh` is already signed in to
 * and never asks. A cloud runner starts with nothing, so it offers `gh`'s own
 * device flow — a code to type at github.com/login/device — exactly the way it
 * offers Codex's. The rules are the agents' rules: ask `gh` whether it is
 * signed in and keep only the login name; never read, print or forward the
 * token it stores.
 */

export const ACCOUNT_NAMES: Record<AccountId, string> = { claude: 'Claude Code', codex: 'Codex', github: 'GitHub' };

export const GITHUB_LOGIN_COMMAND = 'gh auth login --hostname github.com --git-protocol https --web';

/** `gh auth login` for a machine with no browser: a device code, HTTPS for git, and the scope pushing a workflow file needs. */
export const GITHUB_LOGIN_ARGS = ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web', '--skip-ssh-key', '--scopes', 'workflow'];

export function isAccountId(value: unknown): value is AccountId {
  return value === 'claude' || value === 'codex' || value === 'github';
}

/** Reads `gh auth status`, which says who is signed in in prose (on stdout in current releases, stderr in older ones). */
export function parseGithubStatus(text: string, ok: boolean): Pick<GithubAccount, 'loggedIn' | 'login'> {
  const match = text.match(/Logged in to github\.com (?:account|as) ([A-Za-z0-9-]+)/);
  if (match !== null) return { loggedIn: true, login: match[1] ?? null };
  if (/not logged in/i.test(text)) return { loggedIn: false, login: null };
  return { loggedIn: ok, login: null };
}

export async function githubStatus(): Promise<GithubAccount> {
  const base: GithubAccount = { installed: false, version: null, loggedIn: false, login: null, loginCommand: GITHUB_LOGIN_COMMAND };
  if ((await resolveExecutable('gh')) === null) return base;
  const env = { NO_COLOR: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_PROMPT_DISABLED: '1' };
  const [version, status] = await Promise.all([
    runProcess('gh', ['--version'], { timeoutMs: 8_000, env }).catch(() => null),
    runProcess('gh', ['auth', 'status', '--hostname', 'github.com'], { timeoutMs: 20_000, env, maxCaptureChars: 64_000 }).catch(() => null),
  ]);
  const found = version === null ? null : `${version.stdout}`.match(/\d+\.\d+\.\d+/);
  const signIn = status === null ? { loggedIn: false, login: null } : parseGithubStatus(`${status.stdout}\n${status.stderr}`, status.ok);
  return { ...base, installed: true, version: found?.[0] ?? null, ...signIn };
}

/**
 * Points git at `gh` for github.com, so a clone, a fetch and the engine's own
 * push use the account signed in above. `gh` writes it to the user's git
 * config; running it again changes nothing.
 */
export async function configureGitForGithub(): Promise<boolean> {
  if ((await resolveExecutable('gh')) === null) return false;
  const result = await runProcess('gh', ['auth', 'setup-git', '--hostname', 'github.com'], { timeoutMs: 20_000, env: { GH_PROMPT_DISABLED: '1' } }).catch(() => null);
  return result?.ok === true;
}
