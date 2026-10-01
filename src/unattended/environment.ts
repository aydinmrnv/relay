import { harnessRegistration } from '../agents/index.ts';
import type { RunState } from '../workflow/state.ts';
import { unattendedOf } from './policy.ts';

/**
 * What a run nobody is watching keeps away from its agents.
 *
 * An unattended run reads an issue a stranger may have written and hands it to
 * a model with a shell. Whatever the allowlist and the comment filter let
 * through is still text a model can be talked round by, and the process it
 * runs in used to inherit everything Relay did: `GH_TOKEN`, the other vendor's
 * API key, a deploy key some earlier step exported. One `env` in a tool call
 * and all of it is in the transcript, or in a pull request.
 *
 * So on an unattended run the agents — and the test suite, which runs code an
 * agent has just written — get the environment with the secrets taken out. A
 * variable is withheld when its *name* says it is a secret. Three things are
 * let through:
 *
 * - **The CLI's own sign-in.** Claude Code still gets `ANTHROPIC_API_KEY` and
 *   Codex still gets `OPENAI_API_KEY`; each gets only its own, and the test
 *   suite gets neither.
 * - **What the repository names.** `unattended.allowEnv` lists variables the
 *   agents and the suite are allowed to see, for the project whose tests need
 *   one.
 * - **Everything that does not look like a secret.** `PATH`, `HOME`, a proxy,
 *   a toolchain's own settings: an agent with no environment cannot build
 *   anything.
 *
 * Only names are examined, never values, so "Relay never reads a credential"
 * stays true of this file too. That is also its limit: a secret in a variable
 * called `CONFIG` is not withheld, and a file on disk never was. This narrows
 * what an injected instruction can reach; it does not make an untrusted issue
 * safe to run.
 *
 * Relay's own subprocesses — `git`, `gh` — are not affected. They are how the
 * run pushes a branch and opens a pull request, and they are argv Relay wrote
 * rather than commands a model chose.
 */

/** Words that mark a secret wherever they appear in a name: `PGPASSWORD`, `NPM_AUTHTOKEN`. */
const SECRET_SUBSTRINGS = [
  'TOKEN',
  'SECRET',
  'PASSWORD',
  'PASSWD',
  'PASSPHRASE',
  'CREDENTIAL',
  'APIKEY',
  'PRIVATEKEY',
  'ACCESSKEY',
  'WEBHOOK',
] as const;

/**
 * Words that mark a secret only as a whole word of the name. `KEY` is a
 * secret in `STRIPE_KEY` and nothing of the kind in `KEYBOARD_LAYOUT`; `AUTH`
 * is one in `SSH_AUTH_SOCK` and not in `XAUTHORITY`.
 */
const SECRET_WORDS: ReadonlySet<string> = new Set(['KEY', 'KEYS', 'AUTH', 'PAT', 'PASS', 'CREDS', 'COOKIE', 'DSN']);

/** `DATABASE_URL`, `REDIS_URI`: an address that carries its own password. */
const STORE_WORDS: ReadonlySet<string> = new Set([
  'DATABASE',
  'DB',
  'POSTGRES',
  'POSTGRESQL',
  'PG',
  'MYSQL',
  'MONGO',
  'MONGODB',
  'REDIS',
  'AMQP',
  'RABBITMQ',
]);
const ADDRESS_WORDS: ReadonlySet<string> = new Set(['URL', 'URI', 'DSN']);

/** Whether a variable's name says it holds a secret. The value is never looked at. */
export function looksSecret(name: string): boolean {
  const upper = name.toUpperCase();
  if (SECRET_SUBSTRINGS.some((word) => upper.includes(word))) return true;

  const words = upper.split(/[^A-Z0-9]+/).filter((word) => word.length > 0);
  if (words.some((word) => SECRET_WORDS.has(word))) return true;
  return words.some((word) => STORE_WORDS.has(word)) && words.some((word) => ADDRESS_WORDS.has(word));
}

export interface WithheldEnvironment {
  /**
   * Overrides for the child's environment: every withheld variable set to
   * `undefined`, which is how `runProcess` is told to drop one.
   */
  env: Record<string, undefined>;
  /** The names that were withheld, sorted, for the note the run prints. */
  names: string[];
}

export interface WithholdOptions {
  /**
   * The harness whose turn this is, so its CLI keeps its own sign-in. Absent
   * for the test suite, which is nobody's CLI and keeps none.
   */
  provider?: string;
  /** `unattended.allowEnv`: names the repository lets through deliberately. */
  allow?: readonly string[];
  env?: NodeJS.ProcessEnv;
}

/** The secret-looking variables to keep from one child process, and how. */
export function withholdSecrets(options: WithholdOptions = {}): WithheldEnvironment {
  const env = options.env ?? process.env;
  const allowed = new Set((options.allow ?? []).map((name) => name.toUpperCase()));
  const own = options.provider === undefined ? [] : (harnessRegistration(options.provider)?.ownEnvironment?.(env) ?? []);

  const names = Object.keys(env)
    .filter((name) => env[name] !== undefined && looksSecret(name))
    .filter((name) => {
      const upper = name.toUpperCase();
      return !allowed.has(upper) && !own.some((prefix) => upper.startsWith(prefix));
    })
    .sort();

  const overrides: Record<string, undefined> = {};
  for (const name of names) overrides[name] = undefined;
  return { env: overrides, names };
}

/** `GH_TOKEN, NPM_TOKEN and 3 more` — names are not secrets, and a long list is noise. */
export function describeWithheld(names: readonly string[], shown = 6): string {
  if (names.length <= shown) return names.join(', ');
  return `${names.slice(0, shown).join(', ')} and ${names.length - shown} more`;
}

/**
 * What this run withholds from one of its child processes, or undefined when
 * it withholds nothing — which is every run a person started. Somebody at the
 * terminal chose the issue and is watching the agents work on it; their
 * environment is theirs to hand over, and a test suite that needs a key from
 * it has always been able to read one.
 */
export function unattendedEnvironment(state: RunState, provider?: string): WithheldEnvironment | undefined {
  if (state.trigger === undefined) return undefined;
  return withholdSecrets({
    allow: unattendedOf(state.config).allowEnv,
    ...(provider === undefined ? {} : { provider }),
  });
}
