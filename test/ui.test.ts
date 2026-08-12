import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import { RunRenderer } from '../src/ui/renderer.ts';
import { Prompter, isPromptCancelled } from '../src/ui/prompt.ts';
import { asciiSafe, detectTheme, fitWidth, glyphs, type Theme } from '../src/ui/theme.ts';
import { DEFAULT_CONFIG } from '../src/storage/config.ts';
import { createRunId } from '../src/util/ids.ts';
import { createRunState, transition, type RunState } from '../src/workflow/state.ts';
import type { Phase } from '../src/workflow/phases.ts';
import { failedPhase, phaseTimings } from '../src/workflow/timeline.ts';

const ESC = '\u001B';
/** Every ANSI sequence: colour, cursor movement and erase alike. */
const ANSI = /\u001B\[[0-9;]*[A-Za-z]/g;

/** A writable that records everything, standing in for a terminal. */
class FakeStream extends PassThrough {
  readonly chunks: string[] = [];
  isTTY = true;
  columns = 100;

  constructor() {
    super();
    this.on('data', (chunk: Buffer) => this.chunks.push(chunk.toString('utf8')));
  }

  get text(): string {
    return this.chunks.join('');
  }

  /** Everything written, with the control sequences stripped. */
  get visible(): string {
    return this.text.replace(ANSI, '');
  }
}

const INTERACTIVE: Theme = { color: true, unicode: true, interactive: true };
const PIPED: Theme = { color: false, unicode: true, interactive: false };
const ASCII: Theme = { color: false, unicode: false, interactive: false };

/** A clock the test advances by hand, so elapsed times are exact rather than flaky. */
function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let current = 1_000_000;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

function renderer(theme: Theme, stream: FakeStream, now?: () => number): RunRenderer {
  return new RunRenderer({
    // Written the way `relay run` writes it: normal punctuation, downgraded by
    // the renderer rather than by the caller.
    title: 'Relay — Issue #142',
    subtitle: 'Add authentication rate limiting',
    agentNames: { planner: 'claude', planReviewer: 'codex', implementer: 'codex', codeReviewer: 'claude' },
    stream: stream as unknown as NodeJS.WriteStream,
    theme,
    ...(now === undefined ? {} : { now }),
  });
}

describe('theme detection', () => {
  function withEnv<T>(env: Record<string, string | undefined>, body: () => T): T {
    const saved: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(env)) {
      saved[key] = process.env[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      return body();
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  const tty = { isTTY: true } as NodeJS.WriteStream;
  const pipe = { isTTY: false } as NodeJS.WriteStream;
  const clean = { NO_COLOR: undefined, CI: undefined, TERM: 'xterm-256color', RELAY_ASCII: undefined };

  it('is fully featured on a plain TTY', () => {
    assert.deepEqual(withEnv(clean, () => detectTheme(tty)), { color: true, unicode: true, interactive: true });
  });

  it('never colours or redraws a pipe', () => {
    const theme = withEnv(clean, () => detectTheme(pipe));
    assert.equal(theme.color, false);
    assert.equal(theme.interactive, false);
  });

  it('respects NO_COLOR, CI, TERM=dumb and RELAY_ASCII', () => {
    assert.equal(withEnv({ ...clean, NO_COLOR: '1' }, () => detectTheme(tty)).color, false);
    const ci = withEnv({ ...clean, CI: 'true' }, () => detectTheme(tty));
    // CI turns off both the live redraw and the colour: its reader is a log.
    assert.equal(ci.interactive, false);
    assert.equal(ci.color, false);
    // CI=0 means "not CI" and must not disable the display.
    assert.equal(withEnv({ ...clean, CI: '0' }, () => detectTheme(tty)).interactive, true);
    assert.deepEqual(withEnv({ ...clean, TERM: 'dumb' }, () => detectTheme(tty)), {
      color: false,
      unicode: false,
      interactive: false,
    });
    assert.equal(withEnv({ ...clean, RELAY_ASCII: '1' }, () => detectTheme(tty)).unicode, false);
  });

  it('offers spinner frames in both alphabets', () => {
    assert.ok(glyphs(INTERACTIVE).spinner.length > 1);
    const ascii = glyphs(ASCII).spinner;
    assert.ok(ascii.length > 1);
    assert.ok(ascii.every((frame) => /^[\x20-\x7E]+$/.test(frame)), 'the ASCII spinner must stay ASCII');
  });

  it('clips to the terminal width so a redraw cannot wrap', () => {
    const narrow = { columns: 10 } as NodeJS.WriteStream;
    assert.equal(fitWidth('x'.repeat(40), narrow).length, 10);
    assert.equal(fitWidth('short', narrow), 'short');
  });
});

describe('ascii downgrade', () => {
  it('leaves prose alone when the terminal can show it', () => {
    const prose = 'A run takes 10–20 minutes — plan → review · done…';
    assert.equal(asciiSafe(prose, INTERACTIVE), prose);
  });

  it('rewrites every typographic character Relay uses', () => {
    const downgraded = asciiSafe('10–20 minutes — plan → review · ✓ ✗ +4 −1 …', ASCII);

    assert.equal(downgraded, '10-20 minutes - plan -> review - v x +4 -1 ...');
    assert.ok(/^[\x00-\x7F]*$/.test(downgraded));
  });

  it('covers the glyphs and the prose alike, so neither can leak', () => {
    // Whatever `glyphs()` produces for a unicode terminal must have an ASCII
    // answer here too, or a mixed line could still escape.
    const unicode = glyphs(INTERACTIVE);
    for (const glyph of [unicode.ok, unicode.failed, unicode.bullet, unicode.arrow, unicode.skipped]) {
      assert.ok(/^[\x00-\x7F]*$/.test(asciiSafe(glyph, ASCII)), `no ASCII form for ${JSON.stringify(glyph)}`);
    }
  });
});

describe('run renderer — interactive', () => {
  it('redraws in place and shows a spinner on the active phase', () => {
    const stream = new FakeStream();
    const view = renderer(INTERACTIVE, stream);

    view.start();
    view.phaseChanged('PLANNING');

    // A redraw moves the cursor up over exactly the region it last drew.
    assert.match(stream.text, new RegExp(`${ESC}\\[\\d+A${ESC}\\[0J`));
    const frames = glyphs(INTERACTIVE).spinner;
    assert.ok(frames.some((frame) => stream.text.includes(frame)), 'the active phase should carry a spinner frame');

    view.finish('COMPLETE');
  });

  it('shows elapsed time while a phase runs and freezes it once the phase ends', () => {
    const stream = new FakeStream();
    const clock = fakeClock();
    const view = renderer(INTERACTIVE, stream, clock.now);

    view.start();
    view.phaseChanged('PLANNING');
    clock.advance(64_000);
    view.roleStatus('planner', 'reading the codebase');
    assert.match(stream.visible, /Planning\s+1m 4s/);

    view.phaseChanged('REVIEWING_PLAN', 'round 1/3');
    clock.advance(5_000);
    view.roleStatus('planReviewer', 'reviewing');

    const lastDraw = lastRegion(stream);
    // Planning's clock stopped when the phase ended; it does not keep counting.
    assert.match(lastDraw, /Planning\s+1m 4s/);
    assert.match(lastDraw, /Plan review\s+5\.0s/);
    view.finish('COMPLETE');
  });

  it('shows the round being consumed, not just "revising"', () => {
    const stream = new FakeStream();
    const view = renderer(INTERACTIVE, stream);

    view.start();
    view.phaseChanged('REVIEWING_PLAN', 'round 1/3');
    view.phaseChanged('REVISING_PLAN', 'revising · round 1/3');
    assert.match(lastRegion(stream), /revising · round 1\/3/);

    view.phaseChanged('REVIEWING_PLAN', 'round 2/3');
    assert.match(lastRegion(stream), /round 2\/3/);
    view.finish('COMPLETE');
  });

  it('keeps a review phase clock running across its revision rounds', () => {
    const stream = new FakeStream();
    const clock = fakeClock();
    const view = renderer(INTERACTIVE, stream, clock.now);

    view.start();
    view.phaseChanged('REVIEWING_PLAN', 'round 1/3');
    clock.advance(30_000);
    view.phaseChanged('REVISING_PLAN', 'revising · round 1/3');
    clock.advance(30_000);
    view.phaseChanged('REVIEWING_PLAN', 'round 2/3');

    // 60s of plan review, not a clock restarted by re-entering the phase.
    assert.match(lastRegion(stream), /Plan review\s+1m 0s/);
    view.finish('COMPLETE');
  });

  it('marks the phase a failed run died in, and only that one', () => {
    const stream = new FakeStream();
    const view = renderer(INTERACTIVE, stream);

    view.start();
    view.phaseChanged('PLANNING');
    view.phaseChanged('IMPLEMENTING');
    view.finish('FAILED');

    const marks = glyphs(INTERACTIVE);
    const final = lastRegion(stream);
    assert.match(final, new RegExp(`${marks.failed} Implementation`));
    assert.match(final, new RegExp(`${marks.done} Planning`));
  });

  it('draws nothing more once the run has finished', () => {
    const stream = new FakeStream();
    const view = renderer(INTERACTIVE, stream);

    view.start();
    view.phaseChanged('PLANNING');
    view.finish('COMPLETE');

    const after = stream.chunks.length;
    view.agentEvent('planner', { type: 'command', agent: 'claude', at: '2026-08-11T10:00:00Z', command: 'rg TODO' });
    view.roleStatus('planner', 'still going');
    assert.equal(stream.chunks.length, after, 'a stopped renderer must not redraw');
  });
});

/** The most recent in-place draw: everything after the last erase. */
function lastRegion(stream: FakeStream): string {
  return (stream.text.split(`${ESC}[0J`).pop() ?? '').replace(ANSI, '');
}

describe('run renderer — non-interactive', () => {
  it('emits append-only text with no escape sequences at all', () => {
    const stream = new FakeStream();
    const view = renderer(PIPED, stream);

    view.start();
    view.phaseChanged('PLANNING');
    view.roleStatus('planner', 'reading');
    view.agentEvent('planner', { type: 'command', agent: 'claude', at: '2026-08-11T10:00:00Z', command: 'rg TODO' });
    view.note('Plan approved after 1 review round(s).');
    view.warn('Round limit reached.');
    view.phaseChanged('IMPLEMENTING');
    view.finish('COMPLETE');

    assert.ok(!stream.text.includes(ESC), 'a pipe must never receive control sequences');
    assert.equal(stream.text, stream.visible);
  });

  it('reports each phase as it starts and its duration as it ends', () => {
    const stream = new FakeStream();
    const clock = fakeClock();
    const view = renderer(PIPED, stream, clock.now);

    view.start();
    view.phaseChanged('PLANNING');
    clock.advance(12_000);
    view.phaseChanged('REVIEWING_PLAN', 'round 1/3');
    clock.advance(3_000);
    view.finish('COMPLETE');

    const lines = stream.text.trim().split('\n');
    assert.ok(lines.includes('Planning…'), stream.text);
    // The round limit is visible in a log too, not only on a TTY.
    assert.ok(lines.includes('Plan review (round 1/3)…'), stream.text);
    assert.ok(lines.some((line) => line.includes('Planning') && line.includes('12.0s')), stream.text);
    assert.ok(lines.some((line) => line.includes('Plan review') && line.includes('3.0s')), stream.text);
  });

  it('uses ASCII throughout when unicode is unavailable', () => {
    const stream = new FakeStream();
    const view = renderer(ASCII, stream, fakeClock().now);

    view.start();
    view.phaseChanged('PLANNING');
    view.phaseChanged('IMPLEMENTING');
    view.note('Implementation: 2 files');
    view.finish('COMPLETE');

    assert.ok(/^[\x00-\x7F]*$/.test(stream.text), `expected pure ASCII, got: ${JSON.stringify(stream.text)}`);
  });

  it('never writes a live region it would later have to erase', () => {
    const stream = new FakeStream();
    const view = renderer(PIPED, stream);

    view.start();
    view.phaseChanged('PLANNING');
    view.log('a durable line');
    view.finish('FAILED');

    assert.ok(!stream.text.includes(`${ESC}[0J`));
  });
});

describe('prompter', () => {
  /** Waits until the prompt has finished writing, so one answer feeds one question. */
  async function settled(output: FakeStream): Promise<void> {
    for (;;) {
      const before = output.chunks.length;
      await new Promise((resolve) => setImmediate(resolve));
      if (output.chunks.length === before) return;
    }
  }

  function fake(): { input: PassThrough; output: FakeStream; prompter: Prompter } {
    const input = new PassThrough();
    const output = new FakeStream();
    return { input, output, prompter: new Prompter({ input, output, interactive: true, theme: PIPED }) };
  }

  /** Runs a prompt, feeding one line each time it asks. */
  async function answering<T>(
    io: { input: PassThrough; output: FakeStream },
    run: () => Promise<T>,
    lines: readonly string[],
  ): Promise<T> {
    const result = run();
    for (const line of lines) {
      await settled(io.output);
      io.input.write(`${line}\n`);
    }
    return result;
  }

  it('returns every default without reading input when non-interactive', async () => {
    const input = new PassThrough();
    let read = false;
    input.on('data', () => {
      read = true;
    });

    const prompter = new Prompter({ input, output: new FakeStream(), interactive: false, theme: PIPED });
    assert.equal(prompter.interactive, false);
    assert.equal(await prompter.text('Base branch?', 'main'), 'main');
    assert.equal(await prompter.confirm('Proceed?', true), true);
    assert.equal(await prompter.choice('Planner?', [{ value: 'claude', label: 'Claude' }], 'claude'), 'claude');
    assert.equal(read, false, 'a non-interactive prompter must not consume stdin');
    prompter.close();
  });

  it('accepts a typed answer, and Enter takes the default', async () => {
    const io = fake();
    assert.equal(await answering(io, () => io.prompter.text('Base branch?', 'main'), ['develop']), 'develop');
    assert.equal(await answering(io, () => io.prompter.text('Base branch?', 'main'), ['']), 'main');
    io.prompter.close();
  });

  it('re-asks until the answer validates', async () => {
    const io = fake();
    const validate = (value: string): string | undefined =>
      value.trim().length === 0 ? 'Enter a branch name.' : undefined;

    // A blank answer takes the (empty) default, which the validator rejects, so
    // the prompt has to come back rather than accept it.
    const answer = await answering(io, () => io.prompter.text('Branch?', '', validate), ['', '   ', 'trunk']);
    assert.equal(answer, 'trunk');
    assert.match(io.output.text, /Enter a branch name\./);
    io.prompter.close();
  });

  it('reads y/n and re-asks on anything else', async () => {
    const io = fake();
    assert.equal(await answering(io, () => io.prompter.confirm('Re-check?', true), ['maybe', 'n']), false);
    assert.match(io.output.text, /Please answer y or n\./);
    assert.equal(await answering(io, () => io.prompter.confirm('Re-check?', false), ['YES']), true);
    assert.equal(await answering(io, () => io.prompter.confirm('Re-check?', false), ['']), false);
    io.prompter.close();
  });

  it('takes a choice by number or by name and re-asks when out of range', async () => {
    const choices = [
      { value: 'claude', label: 'Claude Code' },
      { value: 'codex', label: 'Codex' },
    ];
    const io = fake();
    const ask = (fallback: string, lines: string[]): Promise<string> =>
      answering(io, () => io.prompter.choice('Planner?', choices, fallback), lines);

    assert.equal(await ask('claude', ['2']), 'codex');
    assert.equal(await ask('codex', ['claude']), 'claude');
    // Enter takes the default wherever it sits in the list.
    assert.equal(await ask('codex', ['']), 'codex');
    assert.equal(await ask('claude', ['9', '1']), 'claude');
    assert.match(io.output.text, /Enter 1-2, or an agent name\./);
    io.prompter.close();
  });

  it('lists every option with its label', async () => {
    const io = fake();
    await answering(
      io,
      () =>
        io.prompter.choice(
          'Planner?',
          [
            { value: 'claude', label: 'Claude Code' },
            { value: 'codex', label: 'Codex', hint: 'unavailable' },
          ],
          'claude',
        ),
      [''],
    );

    assert.match(io.output.text, /1\) claude\s+Claude Code/);
    assert.match(io.output.text, /2\) codex\s+Codex — unavailable/);
    io.prompter.close();
  });

  it('takes the default when input ends instead of hanging', async () => {
    const io = fake();
    const answer = io.prompter.text('Base branch?', 'main');
    await settled(io.output);
    io.input.end();

    assert.equal(await answer, 'main');
    io.prompter.close();
  });

  it('reports Ctrl-C at a prompt as a cancellation rather than an accepted default', async () => {
    const io = fake();
    const answer = io.prompter.text('Base branch?', 'main');
    await settled(io.output);
    // readline turns Ctrl-C into a SIGINT event on the interface itself.
    io.input.write('\u0003');

    await assert.rejects(answer, (error: unknown) => {
      assert.ok(isPromptCancelled(error), `expected a cancellation, got ${String(error)}`);
      return true;
    });
    io.prompter.close();
  });
});

describe('phase timings', () => {
  function runThrough(phases: readonly Phase[], stepMs: number): RunState {
    const createdAt = new Date('2026-08-11T10:00:00Z');
    const state = createRunState({
      runId: createRunId(createdAt),
      shortId: 'aaa111',
      issueRef: '142',
      repository: { root: '/repo', owner: 'acme', name: 'widgets', defaultBranch: 'main' },
      config: structuredClone(DEFAULT_CONFIG),
      now: createdAt,
    });

    let at = createdAt.getTime();
    for (const phase of phases) {
      at += stepMs;
      transition(state, phase, { now: new Date(at) });
    }
    return state;
  }

  const HAPPY_PATH: readonly Phase[] = [
    'FETCHING_ISSUE',
    'CREATING_WORKSPACE',
    'PLANNING',
    'REVIEWING_PLAN',
    'IMPLEMENTING',
    'REVIEWING_CODE',
    'TESTING',
    'COMPLETE',
  ];

  it('reports each phase in workflow order with its duration', () => {
    const timings = phaseTimings(runThrough(HAPPY_PATH, 10_000));

    assert.deepEqual(
      timings.map((timing) => timing.phase),
      HAPPY_PATH.slice(0, -1),
    );
    assert.ok(timings.every((timing) => timing.ms === 10_000));
    assert.ok(timings.every((timing) => timing.visits === 1));
  });

  it('folds revision rounds into the review they belong to', () => {
    const state = runThrough(
      [
        'FETCHING_ISSUE',
        'CREATING_WORKSPACE',
        'PLANNING',
        'REVIEWING_PLAN',
        'REVISING_PLAN',
        'REVIEWING_PLAN',
        'IMPLEMENTING',
        'REVIEWING_CODE',
        'TESTING',
        'COMPLETE',
      ],
      5_000,
    );
    const timings = phaseTimings(state);

    // Two review entries plus the revision between them: 15s across 3 visits.
    const planReview = timings.find((timing) => timing.phase === 'REVIEWING_PLAN');
    assert.equal(planReview?.ms, 15_000);
    assert.equal(planReview?.visits, 3);
    // The revision never appears as a phase of its own.
    assert.ok(!timings.some((timing) => timing.phase === 'REVISING_PLAN'));
  });

  it('names the phase a failed run died in', () => {
    const state = runThrough(['FETCHING_ISSUE', 'CREATING_WORKSPACE', 'PLANNING'], 1_000);
    assert.equal(failedPhase(state), undefined, 'a running run has not failed anywhere');

    state.error = { message: 'claude (planner) failed', phase: 'PLANNING' };
    transition(state, 'FAILED');
    assert.equal(failedPhase(state), 'PLANNING');
  });

  it('falls back to the last non-terminal phase when no error was recorded', () => {
    const state = runThrough(['FETCHING_ISSUE', 'CREATING_WORKSPACE'], 1_000);
    transition(state, 'FAILED');
    assert.equal(failedPhase(state), 'CREATING_WORKSPACE');
  });
});
