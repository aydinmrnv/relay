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
   * Overrides the executable the harness spawns. Tests and the conformance
   * suite use it to build the real argv against a no-op or fixture-player
   * binary; a user can use it to pin an absolute path.
   */
  binary?: string;
}

/**
 * How a harness's read-only capability is actually enforced — by the operating
 * system, or by a deny list inside the CLI's own process. Declared here so
 * `relay doctor` can report the difference instead of the README implying
 * parity, and so Relay knows which harnesses need its own OS sandbox wrapped
 * around their read-only turns.
 */
export interface EnforcementInfo {
  /**
   * `os-sandbox`: the CLI itself confines the turn at the OS level, and Relay
   * must not wrap it again (a nested Seatbelt profile fails on macOS).
   * `deny-list`: the CLI only refuses tools by name, so Relay wraps the turn in
   * its own OS sandbox where the platform offers one (`src/agents/sandbox.ts`).
   * `cli-flag`: a config-defined harness passes the `readOnly` flags its config
   * declares — Relay forwards them and takes the config's word for the rest.
   * `none`: no read-only mode at all, which bars the harness from review roles.
   */
  readonly readOnly: 'os-sandbox' | 'deny-list' | 'cli-flag' | 'none';
  /** One line for `relay doctor`, e.g. `OS sandbox (codex --sandbox read-only)`. */
  readonly detail: string;
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
  /** What enforces `read_only` for this harness. `relay doctor` reports it. */
  readonly enforcement: EnforcementInfo;
  /**
   * The environment variables this CLI signs in with, as name prefixes.
   *
   * An unattended run withholds secret-looking variables from its agents
   * (`src/unattended/environment.ts`), and a CLI that authenticates from the
   * environment — every one of them does, in CI — would be signed out by that.
   * These are the names that stay. It is a function of the environment because
   * what a CLI needs depends on how it was pointed: Claude Code reads AWS
   * credentials only when it has been told to use Bedrock.
   *
   * Relay matches names against these and reads no value: the variables go
   * from the job's environment to the vendor's process, as they always have.
   */
  readonly ownEnvironment?: (env: NodeJS.ProcessEnv) => readonly string[];
  /**
   * Whether the harness can actually enforce `read_only`. Absent means yes —
   * every shipped CLI can. Config-defined harnesses without `readOnly` flags
   * set this to `false` (their `enforcement.readOnly` is `none`), which is
   * what bars them from review roles.
   */
  readonly enforcesReadOnly?: boolean;
  create(options: HarnessOptions): AgentHarness;
}

/** A switch variable that is set to something other than off. */
function switchedOn(value: string | undefined): boolean {
  return value !== undefined && value !== '' && value !== '0' && value.toLowerCase() !== 'false';
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
    enforcement: {
      readOnly: 'deny-list',
      detail: 'tool deny list (--disallowed-tools)',
    },
    ownEnvironment: (env) => [
      'ANTHROPIC_',
      'CLAUDE_',
      // Only when Claude Code has been pointed at a cloud provider's hosting of
      // the model: otherwise the cloud account's keys are not its to see.
      ...(switchedOn(env['CLAUDE_CODE_USE_BEDROCK']) ? ['AWS_'] : []),
      ...(switchedOn(env['CLAUDE_CODE_USE_VERTEX']) ? ['GOOGLE_', 'GCLOUD_', 'CLOUD_ML_'] : []),
    ],
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
    enforcement: {
      readOnly: 'os-sandbox',
      detail: 'OS sandbox (codex --sandbox read-only)',
    },
    ownEnvironment: () => ['OPENAI_', 'CODEX_', 'AZURE_OPENAI_'],
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
