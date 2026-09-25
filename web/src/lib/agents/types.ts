/**
 * Shapes shared by the local bridge (server) and the UI (client).
 *
 * "Bring your own subscription": the studio never holds a model credential.
 * It asks each vendor's CLI whether it is signed in, and it can start that
 * CLI's own login flow. What comes back is the state below, and nothing more.
 */

export type AgentId = 'claude' | 'codex';

export const AGENT_IDS: AgentId[] = ['claude', 'codex'];

/** Everything a runner can sign in to: the coding agents, and GitHub on a Relay Cloud machine. */
export type AccountId = AgentId | 'github';

export type AuthMethod = 'subscription' | 'api-key' | 'none' | 'unknown';

export interface AgentAccount {
  id: AgentId;
  name: string;
  installed: boolean;
  version: string | null;
  loggedIn: boolean;
  method: AuthMethod;
  /** Plan name as the CLI reports it, e.g. `max`, `pro`, `team`. Claude only. */
  plan: string | null;
  /** Account email when the CLI reports one. Shown to the user, never stored. */
  email: string | null;
  installCommand: string;
  /** How the CLI is signed in from a terminal, for the copy button. */
  loginCommand: string;
}

export interface AgentsStatus {
  bridge: true;
  checkedAt: string;
  agents: Record<AgentId, AgentAccount>;
}

export type LoginMode = 'browser' | 'device' | 'console';

export type LoginStatus = 'pending' | 'succeeded' | 'failed' | 'cancelled';

/** GitHub on a Relay Cloud machine, signed in with `gh`'s device flow. */
export interface GithubAccount {
  installed: boolean;
  version: string | null;
  loggedIn: boolean;
  /** The GitHub login, e.g. `octocat`. */
  login: string | null;
  loginCommand: string;
}

export interface LoginSessionView {
  id: string;
  agent: AccountId;
  mode: LoginMode;
  status: LoginStatus;
  /** The vendor's sign-in URL, once the CLI has printed it. */
  url: string | null;
  /** A one-time device code to type on the vendor's page (Codex's and GitHub's device flows). */
  code: string | null;
  /** True when the CLI is waiting for the user to paste an authorization code back (Claude). */
  needsCode: boolean;
  error: string | null;
  startedAt: string;
}

export const AGENT_META: Record<AgentId, { name: string; vendor: string; subscription: string; installCommand: string; loginCommand: string }> = {
  claude: {
    name: 'Claude Code',
    vendor: 'Anthropic',
    subscription: 'Claude Pro, Max, Team or Enterprise',
    installCommand: 'npm install -g @anthropic-ai/claude-code',
    loginCommand: 'claude auth login',
  },
  codex: {
    name: 'Codex',
    vendor: 'OpenAI',
    subscription: 'ChatGPT Plus, Pro, Business or Enterprise',
    installCommand: 'npm install -g @openai/codex',
    loginCommand: 'codex login',
  },
};

/** What the sign-in dialog says about each account. */
export const ACCOUNT_META: Record<AccountId, { name: string; vendor: string; loginCommand: string }> = {
  claude: AGENT_META.claude,
  codex: AGENT_META.codex,
  github: { name: 'GitHub', vendor: 'GitHub', loginCommand: 'gh auth login' },
};
