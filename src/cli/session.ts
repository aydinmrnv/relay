import { parseIssueRef } from '../github/provider.ts';
import { looksLikePath } from '../issues/local.ts';
import { composerSupported, composerWidth, readComposer } from '../ui/composer.ts';
import { Prompter, isPromptCancelled, type PromptSession } from '../ui/prompt.ts';
import { errorMessage } from '../util/errors.ts';
import { showHome, type HomeOptions, type HomeScreen } from './commands/home.ts';
import { runCommand, type RunOptions } from './commands/run.ts';
import { chatCompletions, describeChatInput, parseChatInput, runChatCommand } from './chat.ts';
import { jsonMode } from './json.ts';
import { hint, out, reportError, theme } from './output.ts';

/**
 * Relay as somewhere you stay, rather than a command you re-type.
 *
 * A finished run is not the end of the work — the next task is. So once the
 * agents are done and delivery has asked the two questions only a person can
 * answer, Relay does not exit: it draws the home screen again and waits, for as
 * long as somebody is at the terminal.
 *
 * What it waits with is a composer rather than a question. The prompt takes an
 * issue number, a path, a slash command, or the work itself in plain words —
 * and says which of those it is reading while you type, so a run never starts
 * from a misread line.
 *
 * Nothing changes behind a pipe or in CI. There is nobody there to ask, so a run
 * ends the process exactly as it always did — a session that loops on an empty
 * terminal is a hang with a nicer name.
 */

export interface SessionDeps {
  prompter: PromptSession;
  /**
   * Draws the home screen, and says whether a run can start from here. The
   * session's flags go with it, so the panel describes the run that would
   * actually start rather than the config file as written.
   */
  home: (options?: HomeOptions) => Promise<HomeScreen>;
  /** Undefined is `relay run --prompt`/`--editor`, which name no reference. */
  run: (issueRef: string | undefined, options: RunOptions) => Promise<number>;
  /**
   * Reads one line of chat input. Defaults to the framed composer on a terminal
   * that can host one, and to a plain question everywhere else — which is what
   * lets a scripted prompter drive the whole loop in tests.
   */
  compose?: (options: ComposeOptions) => Promise<string>;
}

export interface ComposeOptions {
  /** Everything typed here before, oldest first. */
  history: readonly string[];
}

const PLACEHOLDER = 'Describe the work, or name an issue — /help';
const HINT_KEYS = 'Enter start · Tab complete · ^C exit';
/** The plain-terminal version of the same question. */
const FALLBACK_PROMPT = '  What should Relay work on? (a description, an issue, a path, or /help — Enter to exit)';

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
export async function runSession(issueRef: string[] | undefined, options: RunOptions = {}): Promise<number> {
  const deps = sessionDeps();
  const code = await runCommand(issueRef, options);
  // A detached run is already gone; there is no result to hand a session, and
  // nobody is waiting at this terminal for the next question.
  if (options.detach === true) return code;
  return relaySession(deps, options, { code });
}

/**
 * The loop: home screen, prompt, run, home screen again.
 *
 * The exit code is the last run's, so a session is worth exactly what the work
 * in it was — and the flags the session was opened with carry to every run in
 * it, because `relay run 12 --fast` then asking for issue 13 means the same
 * thing both times. A `/command` edits those flags for everything after it.
 */
export async function relaySession(
  deps: SessionDeps,
  options: RunOptions = {},
  seed: { code?: number; screen?: HomeScreen } = {},
): Promise<number> {
  let code = seed.code ?? 0;
  let screen = seed.screen;
  // The session's own copy, because `/review thorough` must outlive the line
  // that typed it without editing the caller's object.
  const sessionOptions: RunOptions = { ...options };
  const history: string[] = [];

  // A terminal nobody is watching, or one where the output is being parsed:
  // either way there is nothing to compose, and the prompt would be a hang.
  // `--json` reaches here on a real TTY, so the theme cannot answer this.
  if (jsonMode() || !deps.prompter.interactive) return code;

  const compose = deps.compose ?? ((composeOptions) => defaultCompose(deps.prompter, composeOptions));

  try {
    for (;;) {
      screen ??= await deps.home({ session: sessionOptions });
      if (!screen.ready) return code;

      const answer = await compose({ history });
      const trimmed = answer.trim();
      if (trimmed.length > 0 && history.at(-1) !== trimmed) history.push(trimmed);

      const intent = parseChatInput(answer);
      if (intent.kind === 'exit') {
        out();
        hint('`relay` opens this screen again.');
        out();
        return code;
      }

      if (intent.kind === 'command') {
        const action = await runChatCommand(intent.name, intent.argument, {
          options: sessionOptions,
          prompter: deps.prompter,
        });
        if (action.kind === 'exit') {
          out();
          hint('`relay` opens this screen again.');
          out();
          return code;
        }
        // A command that only printed something leaves the screen alone: the
        // panel above has not changed, and redrawing it would push what the
        // command just said off the top of the terminal.
        if (action.kind === 'prompt') continue;
        if (action.kind === 'screen') {
          screen = undefined;
          continue;
        }
        code = await startRun(deps, action.issueRef, { ...sessionOptions, ...action.options });
        screen = undefined;
        continue;
      }

      // Release the terminal before the run renderer takes it: two readers of
      // one terminal means neither gets a whole keystroke.
      deps.prompter.close();
      out();
      code = await startRun(deps, ...runFor(intent, sessionOptions));
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
 * How each kind of input becomes a run.
 *
 * Work typed in plain words is `--prompt`, which is the flag that has always
 * meant "there is no ticket, this is the task" — so a sentence at the prompt
 * and `relay run --prompt "…"` produce the same run, recorded the same way.
 */
function runFor(
  intent: { kind: 'issue'; ref: string } | { kind: 'file'; path: string } | { kind: 'task'; text: string },
  options: RunOptions,
): [string | undefined, RunOptions] {
  switch (intent.kind) {
    case 'issue':
      return [intent.ref, options];
    case 'file':
      return [intent.path, options];
    case 'task':
      return [undefined, { ...options, prompt: intent.text }];
  }
}

/** The composer where one fits, and the plain question everywhere else. */
async function defaultCompose(prompter: PromptSession, options: ComposeOptions): Promise<string> {
  if (!composerSupported()) return prompter.text(FALLBACK_PROMPT, '');

  // Readline and the composer both read stdin, and two readers of one terminal
  // means neither gets a whole keystroke.
  prompter.close();
  out();
  return readComposer({
    theme: theme(),
    width: composerWidth(),
    placeholder: PLACEHOLDER,
    hint: HINT_KEYS,
    describe: describeChatInput,
    completions: chatCompletions(),
    history: options.history,
  });
}

/**
 * One run, with its failure kept inside the session. An issue that does not
 * exist, or a `gh` that has signed out since, is a thing to fix and try again —
 * not a reason to put the user back on a shell prompt.
 */
async function startRun(deps: SessionDeps, issueRef: string | undefined, options: RunOptions): Promise<number> {
  deps.prompter.close();
  try {
    return await deps.run(issueRef, options);
  } catch (error) {
    if (isPromptCancelled(error)) throw error;
    reportError(error);
    return 1;
  }
}

/**
 * Rejects a malformed reference where one is required — `relay run`'s argument,
 * which still means an issue or a file and nothing else. The chat prompt is
 * looser on purpose: there, anything that is not a reference is the task.
 */
export function validateIssueRef(value: string): string | undefined {
  if (value.trim().length === 0 || looksLikePath(value)) return undefined;
  try {
    parseIssueRef(value);
    return undefined;
  } catch (error) {
    return `${errorMessage(error)} A path to a markdown file works too.`;
  }
}
