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
 * - **A shipped CLI's own sign-in.** Claude Code still gets `ANTHROPIC_API_KEY`
 *   and Codex still gets `OPENAI_API_KEY`; each gets only its own, and the
 *   test suite gets neither. A harness defined in config keeps nothing by
 *   this rule — Relay does not know which variable it signs in with — so its
 *   key has to be named in `unattended.allowEnv`, which shows it to every
 *   agent and to the suite.
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

/** Fragments that mark a secret wherever they appear in a name: `PGPASSWORD`, `MYAPIKEY`. */
const SECRET_FRAGMENTS = [
  'SECRET',
  'PASSWORD',
  'PASSWD',
  'PASSPHRASE',
  'CREDENTIAL',
  'APIKEY',
  'PRIVATEKEY',
  'ACCESSKEY',
] as const;

/**
 * Words that mark a secret only as a whole word of the name. `KEY` is a
 * secret in `STRIPE_KEY` and nothing of the kind in `KEYBOARD_LAYOUT`; `AUTH`
 * is one in `SSH_AUTH_SOCK` and not in `XAUTHORITY`.
 */
const SECRET_WORDS: ReadonlySet<string> = new Set([
  'KEY',
  'KEYS',
  'AUTH',
  'PAT',
  'PASS',
  'CREDS',
  'COOKIE',
  'DSN',
  'PEM',
  'JWT',
]);

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

/**
 * Last words that say a variable is *about* a secret rather than holding one:
 * where a password store lives, how many tokens a model may use, the URL a
 * token is requested from. `PASSWORD_STORE_DIR` is a directory, and
 * `ACTIONS_ID_TOKEN_REQUEST_URL` is useless without the token beside it —
 * which is withheld. Withholding these as well buys nothing and quietly
 * changes how a toolchain behaves.
 */
const DESCRIPTOR_WORDS: ReadonlySet<string> = new Set([
  'DIR',
  'DIRECTORY',
  'PATH',
  'URL',
  'URI',
  'ENDPOINT',
  'HOST',
  'PORT',
  'COUNT',
  'LIMIT',
  'TIMEOUT',
  'TTL',
  'TYPE',
  'NAME',
  'EMAIL',
  'VERSION',
  'REGION',
  'ENABLED',
  'MODE',
  'FORMAT',
  'LENGTH',
  'SIZE',
  'PARALLELISM',
]);

/**
 * Whether a variable's name says it holds a secret. The value is never looked at.
 *
 * A name is a guess at a value, and this guesses in both directions on
 * purpose: it would rather withhold `STRIPE_KEY` from an agent that did not
 * need it than hand over a key because its name was unusual. What it must not
 * do is break the toolchain for nothing, so the exceptions are the names that
 * are certainly not secrets, each for a reason given where it is made.
 */
export function looksSecret(name: string): boolean {
  const upper = name.toUpperCase();
  const words = upper.split(/[^A-Z0-9]+/).filter((word) => word.length > 0);
  const has = (word: string): boolean => words.includes(word);

  // Git's configuration-by-environment: `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_0`,
  // `GIT_CONFIG_VALUE_0`. "KEY" here is the name of a setting, and the three
  // only mean anything together — with the count kept and a key withheld,
  // every `git` the agent or the suite ran would fail on the missing one.
  if (upper.startsWith('GIT_CONFIG_')) return false;

  // An address that carries its own password: a data store's URL, a webhook,
  // a connection string. Checked before the descriptor rule below, because
  // these end in `URL` and are the secret itself.
  if (words.some((word) => STORE_WORDS.has(word)) && words.some((word) => ADDRESS_WORDS.has(word))) return true;
  if (upper.includes('WEBHOOK') || upper.includes('CONNECTIONSTRING') || (has('CONNECTION') && has('STRING'))) return true;

  if (DESCRIPTOR_WORDS.has(words.at(-1) ?? '')) return false;

  if (SECRET_FRAGMENTS.some((fragment) => upper.includes(fragment))) return true;
  // `GH_TOKEN`, `NPM_AUTHTOKEN` — and not `MAX_THINKING_TOKENS`, which is a
  // number of them, nor `TOKENIZERS_PARALLELISM`.
  if (words.some((word) => word.endsWith('TOKEN'))) return true;
  if (words.some((word) => SECRET_WORDS.has(word))) return true;
  // `MYSQL_PWD` is a password; `PWD` and `OLDPWD` are where the shell is.
  if (has('PWD') && words.length > 1) return true;
  return has('SERVICE') && has('ACCOUNT');
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
   * The harness whose turn this is, so that Claude Code or Codex keeps its own
   * sign-in. Absent for the test suite, which is nobody's CLI and keeps none —
   * and a harness defined in config keeps none either: it has no registration
   * to say which variables are its own.
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
