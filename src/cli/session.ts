import { parseIssueRef } from '../github/provider.ts';
import { Prompter, isPromptCancelled, type PromptSession } from '../ui/prompt.ts';
import { errorMessage } from '../util/errors.ts';
import { showHome, type HomeScreen } from './commands/home.ts';
import { runCommand, type RunOptions } from './commands/run.ts';
import { hint, out, reportError } from './output.ts';

/**
 * Relay as somewhere you stay, rather than a command you re-type.
 *
 * A finished run is not the end of the work — the next issue is. So once the
 * agents are done and delivery has asked the two questions only a person can
 * answer, Relay does not exit: it draws the home screen again and waits for the
 * next issue, for as long as somebody is at the terminal.
 *
 * Nothing changes behind a pipe or in CI. There is nobody there to ask, so a run
 * ends the process exactly as it always did — a session that loops on an empty
 * terminal is a hang with a nicer name.
 */

export interface SessionDeps {
  prompter: PromptSession;
  /** Draws the home screen, and says whether a run can start from here. */
  home: () => Promise<HomeScreen>;
  run: (issueRef: string, options: RunOptions) => Promise<number>;
}

/** Typed instead of an issue when you are done for now. Enter does the same. */
const QUIT = new Set(['q', 'quit', 'exit']);

const NEXT_ISSUE = '  Next issue? (number, owner/repo#number, or URL — Enter to exit)';

export function sessionDeps(): SessionDeps {
  return { prompter: new Prompter(), home: showHome, run: runCommand };
}

/** `relay` on its own: the home screen, and then whatever you run from it. */
export async function homeSession(): Promise<number> {
  const deps = sessionDeps();
  // Drawn before the loop, so a bare `relay` whose stdin is not a terminal still
  // prints the screen it was asked for and then stops.
  const screen = await deps.home();
  return relaySession(deps, {}, { screen });
}

/** `relay run <issue>`: the run, and then the screen it came from. */
export async function runSession(issueRef: string, options: RunOptions = {}): Promise<number> {
  const deps = sessionDeps();
  const code = await deps.run(issueRef, options);
  return relaySession(deps, options, { code });
}

/**
 * The loop: home screen, next issue, run, home screen again.
 *
 * The exit code is the last run's, so a session is worth exactly what the work
 * in it was — and the flags the session was opened with carry to every run in
 * it, because `relay run 12 --fast` then asking for issue 13 means the same
 * thing both times.
 */
export async function relaySession(
  deps: SessionDeps,
  options: RunOptions = {},
  seed: { code?: number; screen?: HomeScreen } = {},
): Promise<number> {
  let code = seed.code ?? 0;
  let screen = seed.screen;

  if (!deps.prompter.interactive) return code;

  try {
    for (;;) {
      screen ??= await deps.home();
      if (!screen.ready) return code;

      const answer = await deps.prompter.text(NEXT_ISSUE, '', validateNextIssue);
      if (isQuit(answer)) {
        out();
        hint('`relay` opens this screen again.');
        out();
        return code;
      }

      // Release the terminal before the run renderer takes it: two readers of
      // one terminal means neither gets a whole keystroke.
      deps.prompter.close();
      out();
      code = await startRun(deps, answer, options);
      // The next question deserves a screen that knows about the run just made.
      screen = undefined;
    }
  } catch (error) {
    if (!isPromptCancelled(error)) throw error;
    out();
    return code;
  } finally {
    deps.prompter.close();
  }
}

/**
 * One run, with its failure kept inside the session. An issue that does not
 * exist, or a `gh` that has signed out since, is a thing to fix and try again —
 * not a reason to put the user back on a shell prompt.
 */
async function startRun(deps: SessionDeps, issueRef: string, options: RunOptions): Promise<number> {
  try {
    return await deps.run(issueRef, options);
  } catch (error) {
    if (isPromptCancelled(error)) throw error;
    reportError(error);
    return 1;
  }
}

/** Rejects a malformed reference at the prompt, but lets an empty answer through. */
export function validateIssueRef(value: string): string | undefined {
  if (value.trim().length === 0) return undefined;
  try {
    parseIssueRef(value);
    return undefined;
  } catch (error) {
    return errorMessage(error);
  }
}

function validateNextIssue(value: string): string | undefined {
  return isQuit(value) ? undefined : validateIssueRef(value);
}

function isQuit(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized.length === 0 || QUIT.has(normalized);
}
