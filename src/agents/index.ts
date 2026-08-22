import type { AuthSupport } from '../auth/delegated.ts';
import { ClaudeHarness, claudeSignedIn } from './claude.ts';
import { CodexHarness } from './codex.ts';
import type { AgentHarness } from './types.ts';

/**
 * Everything Relay is willing to tell a harness at construction time. It is
 * deliberately narrow: a harness reads its own auth, picks its own defaults, and
 * only ever learns the model the user configured for it.
 */
export interface HarnessOptions {
  defaultModel?: string;
  /**
   * Where the executable lives, when it is not simply the CLI's name on PATH.
   * The conformance suite uses this to point a registered harness at a fixture
   * player instead of the real CLI.
   */
  binary?: string;
}

export interface HarnessRegistration {
  /** Name used in `.relay/config.json` (`agents.*`, `models.*`) and on the CLI. */
  readonly name: string;
  /** Human label for `relay doctor` and `relay init`. */
  readonly label: string;
  /** Identity used in the `Co-Authored-By` trailer of a `--commit` commit. */
  readonly coAuthor: { readonly name: string; readonly email: string };
  /** Printed when the CLI is missing. Relay shows it; the user runs it. */
  readonly installCommand: string;
  /**
   * How this vendor answers "are you signed in?" and "sign me in". Relay only
   * ever delegates to these — it holds no credential of its own.
   */
  readonly auth: AuthSupport;
  /**
   * Whether the harness can actually enforce `read_only`. Absent means yes —
   * every shipped CLI can. Config-defined harnesses without `readOnly` flags
   * set this to `false`, which is what bars them from review roles.
   */
  readonly enforcesReadOnly?: boolean;
  create(options: HarnessOptions): AgentHarness;
}

/**
 * The single list of coding CLIs Relay knows about.
 *
 * This is the seam the README promises: a new CLI is one file under
 * `src/agents/` plus one row here. Config validation, `createCliContext`,
 * `relay doctor` and `relay init` all read this array rather than naming
 * providers, so none of them need touching.
 */
export const AGENT_REGISTRY: readonly HarnessRegistration[] = [
  {
    name: 'claude',
    label: 'Claude Code',
    coAuthor: { name: 'Claude', email: 'noreply@anthropic.com' },
    installCommand: 'npm install -g @anthropic-ai/claude-code',
    auth: {
      // `claude auth status` exits 0 whether or not a session exists, so the
      // answer is read from its own JSON rather than from the exit code.
      status: { command: 'claude', args: ['auth', 'status'], signedIn: claudeSignedIn },
      login: { command: 'claude', args: ['auth', 'login'] },
    },
    create: (options) => new ClaudeHarness(options),
  },
  {
    name: 'codex',
    label: 'Codex',
    coAuthor: { name: 'Codex', email: 'noreply@openai.com' },
    installCommand: 'npm install -g @openai/codex',
    auth: {
      status: { command: 'codex', args: ['login', 'status'] },
      login: { command: 'codex', args: ['login'] },
    },
    create: (options) => new CodexHarness(options),
  },
];

export const AGENT_PROVIDERS: readonly string[] = AGENT_REGISTRY.map((entry) => entry.name);

export function isAgentProvider(value: unknown): value is string {
  return typeof value === 'string' && AGENT_PROVIDERS.includes(value);
}

export function harnessRegistration(name: string): HarnessRegistration | undefined {
  return AGENT_REGISTRY.find((entry) => entry.name === name);
}

/** One live harness per registered provider, keyed by name. */
export function createHarnesses(
  models: Readonly<Record<string, string | undefined>> = {},
): Record<string, AgentHarness> {
  const harnesses: Record<string, AgentHarness> = {};
  for (const entry of AGENT_REGISTRY) {
    const model = models[entry.name];
    harnesses[entry.name] = entry.create(model === undefined ? {} : { defaultModel: model });
  }
  return harnesses;
}
