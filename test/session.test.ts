import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { setTheme } from '../src/cli/output.ts';
import { relaySession, validateIssueRef, type SessionDeps } from '../src/cli/session.ts';
import type { RunOptions } from '../src/cli/commands/run.ts';
import type { HomeScreen } from '../src/cli/commands/home.ts';
import { RelayError } from '../src/util/errors.ts';
import type { Theme } from '../src/ui/theme.ts';
import { ScriptedPrompter } from './helpers/scriptedPrompter.ts';

const PIPED: Theme = { color: false, unicode: true, interactive: false };

beforeEach(() => {
  setTheme(PIPED);
});

afterEach(() => {
  setTheme(undefined);
});

interface Started {
  /** Undefined when the run named no reference, as `--prompt` and `--editor` do. */
  issueRef: string | undefined;
  options: RunOptions;
  /** Whether the prompt had released the terminal by the time the run began. */
  terminalReleased: boolean;
}

interface Session {
  code: number;
  /** Every run the session started, in order. */
  started: Started[];
  /** How many times the home screen was drawn. */
  homes: number;
  asked: string[];
  output: string;
}

interface Options {
  interactive?: boolean;
  ready?: boolean;
  options?: RunOptions;
  seed?: { code?: number; screen?: HomeScreen };
  /** What each run returns, in order. A thrown value is thrown by the run. */
  outcomes?: ReadonlyArray<number | Error>;
  prompter?: ScriptedPrompter;
}

/** Drives the session against a scripted terminal and a run that never happens. */
async function session(answers: readonly string[], options: Options = {}): Promise<Session> {
  const prompter = options.prompter ?? new ScriptedPrompter(answers, options.interactive ?? true);
  const started: Started[] = [];
  const outcomes = [...(options.outcomes ?? [])];
  let homes = 0;

  const deps: SessionDeps = {
    prompter,
    home: async () => {
      homes += 1;
      return { ready: options.ready ?? true };
    },
    run: async (issueRef, runOptions) => {
      started.push({ issueRef, options: runOptions, terminalReleased: prompter.closed });
      const outcome = outcomes.shift() ?? 0;
      if (outcome instanceof Error) throw outcome;
      // The real run leaves the terminal usable again for the next question.
      prompter.closed = false;
      return outcome;
    },
  };

  let output = '';
  const original = process.stdout.write;
  const stderr = process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    output += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    output += chunk.toString();
    return true;
  }) as typeof process.stderr.write;

  try {
    const code = await relaySession(deps, options.options ?? {}, options.seed ?? {});
    return { code, started, homes, asked: prompter.asked, output };
  } finally {
    process.stdout.write = original;
    process.stderr.write = stderr;
  }
}

describe('the Relay session', () => {
  it('comes back for the next issue instead of exiting', async () => {
    const result = await session(['12', '13', '']);

    assert.deepEqual(result.started.map(({ issueRef }) => issueRef), ['12', '13']);
    // One screen before each question: the one it opened on, and one after each
    // run — which is what makes the finished run visible on it.
    assert.equal(result.homes, 3);
    assert.equal(result.asked.length, 3);
    for (const question of result.asked) assert.match(question, /What should Relay work on\?/);
  });

  it('leaves on Enter, and on the words for it', async () => {
    for (const answer of ['', 'q', 'quit', 'exit', 'EXIT']) {
      const result = await session([answer]);
      assert.equal(result.started.length, 0, `"${answer}" must not start a run`);
      assert.match(result.output, /`relay` opens this screen again/);
    }
  });

  it('hands the terminal to the run and takes it back afterwards', async () => {
    // Two readers of one terminal means neither gets a whole keystroke, so the
    // prompt has to be closed before the run renderer starts drawing.
    const result = await session(['12', '']);
    assert.equal(result.started[0]?.terminalReleased, true);
  });

  it('reports the last run it finished', async () => {
    assert.equal((await session(['12', ''], { outcomes: [1] })).code, 1);
    assert.equal((await session(['12', '13', ''], { outcomes: [1, 0] })).code, 0);
    // A session nobody ran anything in is worth what it was handed.
    assert.equal((await session([''], { seed: { code: 130 } })).code, 130);
  });

  it('carries the flags it was opened with into every run in it', async () => {
    const result = await session(['12', '13', ''], { options: { fast: true, verbose: true } });
    for (const started of result.started) assert.deepEqual(started.options, { fast: true, verbose: true });
  });

  it('keeps a failed run inside the session rather than dropping to a shell', async () => {
    const result = await session(['12', '13', ''], {
      outcomes: [new RelayError('Issue #12 was not found.', { code: 'ISSUE_NOT_FOUND', hint: 'Check the number.' })],
    });

    assert.equal(result.started.length, 2, 'a bad issue number must not end the session');
    assert.match(result.output, /Issue #12 was not found\./);
    assert.match(result.output, /Check the number\./);
    assert.equal(result.code, 0, 'the second run succeeded, and that is the session\'s result');
  });

  it('never prompts a terminal nobody is watching', async () => {
    const result = await session(['12'], { interactive: false, seed: { code: 3 } });

    assert.equal(result.started.length, 0);
    assert.equal(result.asked.length, 0);
    assert.equal(result.homes, 0, 'a piped run ends exactly as it always did');
    assert.equal(result.code, 3);
  });

  it('draws the screen it was handed without asking for it again', async () => {
    const result = await session([''], { seed: { screen: { ready: true } } });
    assert.equal(result.homes, 0);
    assert.equal(result.asked.length, 1);
  });

  it('asks for nothing in a repository a run cannot start from', async () => {
    const result = await session(['12'], { ready: false });

    assert.equal(result.asked.length, 0, 'home has already said to run `relay start`');
    assert.equal(result.started.length, 0);
  });

  it('starts a run from plain words, with no ticket anywhere', async () => {
    const result = await session(['add a dark mode toggle to settings', '']);

    assert.equal(result.started.length, 1);
    assert.equal(result.started[0]?.issueRef, undefined, 'there is no issue to name');
    assert.equal(result.started[0]?.options.prompt, 'add a dark mode toggle to settings');
  });

  it('still reads an issue number and a path as what they are', async () => {
    const result = await session(['142', './spec.md', '']);

    assert.deepEqual(result.started.map(({ issueRef }) => issueRef), ['142', './spec.md']);
    for (const started of result.started) assert.equal(started.options.prompt, undefined);
  });

  it('keeps a task off the session flags, so the next run is not the same task', async () => {
    const result = await session(['fix the pager', '142', '']);

    assert.equal(result.started[0]?.options.prompt, 'fix the pager');
    assert.equal(result.started[1]?.options.prompt, undefined, 'the prompt belonged to one run');
  });

  it('applies a slash command to every run after it, without starting one itself', async () => {
    const result = await session(['/review thorough', '142', '']);

    assert.equal(result.started.length, 1, 'a command is not a run');
    assert.equal(result.started[0]?.options.review, 'thorough');
  });

  it('does not redraw the screen for a command that only printed something', async () => {
    const result = await session(['/help', ''], { seed: { screen: { ready: true } } });

    assert.equal(result.homes, 0, 'redrawing would push what /help said off the top');
    assert.equal(result.started.length, 0);
  });

  it('redraws the screen when a command changed what is on it', async () => {
    const result = await session(['/review light', ''], { seed: { screen: { ready: true } } });
    assert.equal(result.homes, 1);
  });

  it('leaves on /exit', async () => {
    const result = await session(['/exit', '142']);

    assert.equal(result.started.length, 0);
    assert.match(result.output, /`relay` opens this screen again/);
  });

  it('starts the run a command asks for, with the session flags on it', async () => {
    const result = await session(['/editor', ''], { options: { review: 'light' } });

    assert.equal(result.started.length, 1);
    assert.equal(result.started[0]?.issueRef, undefined);
    assert.equal(result.started[0]?.options.editor, true);
    assert.equal(result.started[0]?.options.review, 'light');
  });

  it('treats Ctrl-C at the prompt as leaving, not as an error', async () => {
    class Cancelling extends ScriptedPrompter {
      override async text(): Promise<string> {
        throw new RelayError('Cancelled.', { code: 'PROMPT_CANCELLED' });
      }
    }

    const result = await session([], { prompter: new Cancelling([], true), seed: { code: 2 } });
    assert.equal(result.code, 2);
    assert.equal(result.started.length, 0);
  });
});

it('rejects a malformed issue reference at the prompt but lets an empty answer through', () => {
  assert.equal(validateIssueRef(''), undefined);
  assert.equal(validateIssueRef('  '), undefined);
  assert.equal(validateIssueRef('142'), undefined);
  assert.equal(validateIssueRef('acme/widgets#142'), undefined);
  assert.match(validateIssueRef('not-an-issue') ?? '', /issue/i);
});
