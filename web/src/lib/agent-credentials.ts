/**
 * What each coding agent needs in GitHub Actions, for each way of signing in.
 * A runner cannot click a sign-in page, so each agent reads one repository
 * secret; these are the names the compiler asks for (`compileWorkflow`) and
 * the commands that set them, said once for Settings and for setup.
 *
 * The commands carry no `# comment`: an interactive zsh, which is what a Mac
 * opens, hands the words after `#` to the command as arguments.
 */
import type { AuthPreference } from './workflow/schema';

export type AgentKey = 'claude' | 'codex';

export interface AgentCredential {
  secret: string;
  what: string;
  commands: (repo: string) => string;
}

export const AGENT_CREDENTIALS: Record<AgentKey, { name: string } & Record<AuthPreference, AgentCredential>> = {
  claude: {
    name: 'Claude Code',
    subscription: {
      secret: 'CLAUDE_CODE_OAUTH_TOKEN',
      what: 'A one-year token from claude setup-token, tied to the Claude Pro, Max, Team or Enterprise plan of whoever creates it. Runs count against that plan’s usage. The second command asks for the token: paste it there.',
      commands: (repo) => `claude setup-token\ngh secret set CLAUDE_CODE_OAUTH_TOKEN -R ${repo}`,
    },
    'api-key': {
      secret: 'ANTHROPIC_API_KEY',
      what: 'A key from the Anthropic Console. Runs are billed per token to that Console account. The command asks for the key: paste it there.',
      commands: (repo) => `gh secret set ANTHROPIC_API_KEY -R ${repo}`,
    },
  },
  codex: {
    name: 'Codex',
    subscription: {
      secret: 'CODEX_AUTH_JSON',
      what: 'The sign-in file Codex keeps at ~/.codex/auth.json after codex login with a ChatGPT plan. OpenAI documents this for CI but asks that it not be used on public repositories. The file rotates: if runs stop signing in, log in again and re-seed the secret.',
      commands: (repo) => `codex login\ngh secret set CODEX_AUTH_JSON -R ${repo} < ~/.codex/auth.json`,
    },
    'api-key': {
      secret: 'OPENAI_API_KEY',
      what: 'A key from the OpenAI Platform. Runs are billed per token to that account. The command asks for the key: paste it there.',
      commands: (repo) => `gh secret set OPENAI_API_KEY -R ${repo}`,
    },
  },
};

/** Which agent reads a secret, by the secret's name. */
export function agentOfSecret(secret: string): AgentKey | null {
  for (const key of Object.keys(AGENT_CREDENTIALS) as AgentKey[]) {
    if (AGENT_CREDENTIALS[key].subscription.secret === secret || AGENT_CREDENTIALS[key]['api-key'].secret === secret) return key;
  }
  return null;
}
