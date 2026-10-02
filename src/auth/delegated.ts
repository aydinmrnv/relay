import { runInteractive } from '../process/interactive.ts';
import { resolveExecutable, runProcess } from '../process/runner.ts';

/**
 * Delegated authentication: how Relay treats every tool that can sign itself in.
 *
 * Relay holds no API keys for the tools it drives, reads none of their
 * credentials and never sees one of their tokens. Every such tool — the coding
 * CLIs, `gh` — owns its own auth. This module can therefore do exactly two
 * things: ask a vendor's CLI whether it is signed in, and hand the terminal to
 * that vendor's own login command. There is deliberately no third capability.
 *
 * A tracker with no CLI to drive is the one exception, and it lives elsewhere:
 * `src/issues/linear.ts` reads `LINEAR_API_KEY`, because there is no login
 * command to hand a terminal to.
 *
 * The one sign-in that cannot be delegated lives next door, in `chatgpt.ts`,
 * and reaches this module only as `own`: an answer about its state, never the
 * credential behind it.
 */

/**
 * `unknown` is a real answer, not a failure: a CLI may offer no way to ask
 * without spending tokens, and guessing "signed in" would strand the user at
 * the first agent turn instead of at onboarding.
 */
export type AuthState = 'authenticated' | 'unauthenticated' | 'unknown';

export interface AuthCommand {
  readonly command: string;
  readonly args: readonly string[];
}

/** The state of a sign-in Relay holds itself, as one row of a report. */
export interface OwnSignIn {
  state: 'authenticated' | 'unauthenticated';
  detail: string;
  hint?: string;
}

export interface AuthSupport {
  /**
   * The vendor's own status command. Its output is used to derive one enum
   * value and is then discarded — it never reaches a log, the terminal, or
   * disk, because status output is the most likely place a CLI prints
   * something account-shaped.
   */
  readonly status?: AuthCommand & {
    /** Reads sign-in state out of the probe's stdout when the exit code is not enough. */
    readonly signedIn?: (stdout: string) => boolean | undefined;
  };
  /** The vendor's interactive login. Spawned with the terminal, never read. */
  readonly login: AuthCommand;
  /**
   * A sign-in Relay holds for this vendor instead of the vendor's own (Sign in
   * with ChatGPT). Asked first, and when it has an answer the CLI is not
   * asked at all. Undefined means there is none, and the CLI's answer stands.
   */
  readonly own?: () => Promise<OwnSignIn | undefined>;
  /** The command that starts that sign-in, for onboarding to mention beside the vendor's. */
  readonly ownLogin?: string;
}

/** How a command is spelled when Relay tells the user to run it. */
export function describeCommand(command: AuthCommand): string {
  return [command.command, ...command.args].join(' ');
}

/**
 * Asks a vendor CLI whether it is signed in.
 *
 * Only the state enum escapes this function. An exit code is the default
 * signal; a `signedIn` reader exists for CLIs that report the answer in their
 * output and exit 0 either way.
 */
export async function probeAuth(support: AuthSupport, options: { cwd?: string } = {}): Promise<AuthState> {
  const own = await support.own?.().catch(() => undefined);
  if (own !== undefined) return own.state;

  const status = support.status;
  if (status === undefined) return 'unknown';

  // A CLI that is not installed has no sign-in state to report; the caller
  // already knows it is missing and says so in better words than a probe could.
  if ((await resolveExecutable(status.command)) === null) return 'unknown';

  try {
    const result = await runProcess(status.command, status.args, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      timeoutMs: 20_000,
      env: { NO_COLOR: '1' },
    });

    const reported = status.signedIn?.(result.stdout);
    if (reported !== undefined) return reported ? 'authenticated' : 'unauthenticated';
    return result.ok ? 'authenticated' : 'unauthenticated';
  } catch {
    return 'unknown';
  }
}

/**
 * Runs the vendor's own login flow with the terminal handed over.
 *
 * Relay never prompts for a token, never passes one on a command line and never
 * sees the exchange: `runInteractive` inherits stdio rather than capturing it.
 */
export async function delegateLogin(support: AuthSupport, options: { cwd?: string } = {}): Promise<boolean> {
  const result = await runInteractive(support.login.command, support.login.args, options);
  return result.ok;
}
