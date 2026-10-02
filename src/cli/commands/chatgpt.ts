import {
  beginChatgptSignIn,
  CHATGPT_USAGE_URL,
  chatgptSignOut,
  chatgptStatus,
  ChatgptSignInError,
  type ChatgptDeps,
  type ChatgptState,
  type PendingSignIn,
  type SignInOptions,
} from '../../auth/chatgpt.ts';
import { resolveExecutable } from '../../process/runner.ts';
import { openInBrowser } from '../../studio/open.ts';
import { EXIT } from '../exit.ts';
import { emitJson } from '../json.ts';
import { command, dim, fail, hint, ok, out, theme, warn } from '../output.ts';

/**
 * `relay chatgpt`: Sign in with ChatGPT, from a terminal.
 *
 * `codex login` signs the Codex CLI in. This signs *Relay* in: the person
 * authorizes it on OpenAI's page, Codex turns that Relay starts then spend
 * their ChatGPT plan, and how much of it Relay may use is theirs to set in
 * ChatGPT's settings. Either works; this one needs no Codex sign-in at all.
 *
 * The commands print who is signed in and what that means for the bill. None
 * of them prints, returns or accepts a token.
 */

export interface ChatgptLoginOptions {
  /** Register another ChatGPT account or workspace instead of the saved one. */
  new?: boolean;
  /** Commander's `--no-open`: print the link and leave the browser alone. */
  open?: boolean;
  json?: boolean;
}

/** Seams for the tests. The defaults talk to OpenAI and open the real browser. */
export interface ChatgptCommandDeps {
  begin?: (options: SignInOptions) => Promise<PendingSignIn>;
  open?: (url: string) => Promise<boolean>;
  codexInstalled?: () => Promise<boolean>;
  store?: Partial<ChatgptDeps>;
}

const STATE_LINES: Record<ChatgptState, string> = {
  active: 'Signed in. Codex turns in Relay use your ChatGPT plan.',
  'no-plan': 'Signed in, but Relay may not use your ChatGPT plan, so Codex keeps its own sign-in.',
  lapsed: 'The sign-in expired. Codex turns fail until you sign in again.',
  'signed-out': 'Not signed in. Codex uses its own sign-in (`codex login`).',
};

export async function chatgptLoginCommand(options: ChatgptLoginOptions = {}, deps: ChatgptCommandDeps = {}): Promise<number> {
  const json = options.json === true;
  const pending = await (deps.begin ?? beginChatgptSignIn)({
    account: options.new === true ? 'new' : 'saved',
    ...(deps.store === undefined ? {} : { deps: deps.store }),
  });

  // Ctrl-C is the person abandoning the sign-in: the listener goes with it.
  const abandon = (): void => pending.cancel();
  process.once('SIGINT', abandon);

  // A browser is opened only for a person at a terminal who has not said
  // otherwise. Anything else gets the link, which works just as well by hand.
  const opened = options.open !== false && !json && theme().interactive ? await (deps.open ?? openInBrowser)(pending.url) : false;
  out('Continue with ChatGPT');
  if (opened) hint('Your browser is open on OpenAI\'s sign-in page. If it is not, use this link:');
  else hint('Open this link in a browser on this machine to sign in:');
  command(pending.url);
  out();
  hint('Waiting for you to finish there. Ctrl-C cancels.');

  try {
    const result = await pending.result;
    const codex = await (deps.codexInstalled ?? (async () => (await resolveExecutable('codex')) !== null))();

    if (json) emitJson('chatgpt', { state: result.planEnabled ? 'active' : 'no-plan', email: result.email, usageUrl: CHATGPT_USAGE_URL });
    out();
    if (!result.planEnabled) {
      warn(`Signed in${result.email === null ? '' : ` as ${result.email}`}, but Relay was not allowed to use your ChatGPT plan.`);
      hint('Nothing changes: Codex keeps its own sign-in. Run `relay chatgpt login` again to allow it.');
      return EXIT.preconditions;
    }

    ok(`Signed in${result.email === null ? '' : ` as ${result.email}`}.`);
    // Said once, the first time: from here on, somebody else's meter is running.
    if (result.registered) {
      out();
      out('You\'re using your ChatGPT plan');
      hint('Codex turns Relay starts on this machine now use the usage included in your ChatGPT plan.');
      hint('They no longer need `codex login`. Claude Code is unaffected.');
    }
    hint(`Manage usage: ${CHATGPT_USAGE_URL}`);
    if (!codex) {
      out();
      warn('Codex is not installed, and it is what spends the plan.');
      command('npm install -g @openai/codex');
    }
    return EXIT.success;
  } catch (error) {
    if (!(error instanceof ChatgptSignInError)) throw error;
    if (json) emitJson('chatgpt', { state: 'signed-out', error: error.code });
    out();
    if (error.code === 'cancelled') {
      hint('Sign-in cancelled.');
      return EXIT.cancelled;
    }
    fail(error.message);
    if (error.code === 'declined') hint('Nothing changed. Run `relay chatgpt login` when you want to try again.');
    return EXIT.error;
  } finally {
    process.off('SIGINT', abandon);
  }
}

export async function chatgptStatusCommand(options: { json?: boolean } = {}, deps: ChatgptCommandDeps = {}): Promise<number> {
  const status = await chatgptStatus(deps.store);
  if (options.json === true) {
    emitJson('chatgpt', { state: status.state, email: status.email, usageUrl: CHATGPT_USAGE_URL });
    return status.state === 'lapsed' ? EXIT.preconditions : EXIT.success;
  }

  const who = status.email === null ? '' : dim(`  ${status.email}`);
  if (status.state === 'active') ok(`${STATE_LINES.active}${who}`);
  else if (status.state === 'lapsed') fail(`${STATE_LINES.lapsed}${who}`);
  else if (status.state === 'no-plan') warn(`${STATE_LINES['no-plan']}${who}`);
  else out(STATE_LINES['signed-out']);

  if (status.state === 'active') hint(`Manage usage: ${CHATGPT_USAGE_URL}`);
  else hint(status.state === 'signed-out' ? 'To use your ChatGPT plan through Relay instead: `relay chatgpt login`.' : 'Run `relay chatgpt login`.');
  return status.state === 'lapsed' ? EXIT.preconditions : EXIT.success;
}

export async function chatgptLogoutCommand(options: { json?: boolean } = {}, deps: ChatgptCommandDeps = {}): Promise<number> {
  const result = await chatgptSignOut(deps.store);
  if (options.json === true) {
    emitJson('chatgpt', { state: 'signed-out', signedOut: result.signedOut, revoked: result.revoked });
    return EXIT.success;
  }

  if (!result.signedOut) {
    out('Not signed in with ChatGPT, so there is nothing to sign out of.');
    return EXIT.success;
  }
  ok(`Signed out${result.email === null ? '' : ` of ${result.email}`}. Codex is back on its own sign-in.`);
  if (!result.revoked) {
    warn('OpenAI did not confirm the session is over. The tokens are gone from this machine either way.');
    hint('To be sure, disconnect Relay under Security and login in ChatGPT\'s settings.');
  }
  return EXIT.success;
}
