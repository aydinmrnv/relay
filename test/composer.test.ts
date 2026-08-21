import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyKey,
  commonPrefix,
  composerFrame,
  composerTextWidth,
  readComposer,
  tokenizeKeys,
  type ComposerState,
} from '../src/ui/composer.ts';
import { stripAnsi, visibleWidth, type Theme } from '../src/ui/theme.ts';
import { isPromptCancelled } from '../src/ui/prompt.ts';

const UNICODE: Theme = { color: false, unicode: true, interactive: true };
const ASCII: Theme = { color: false, unicode: false, interactive: true };
const COLOR: Theme = { color: true, unicode: true, interactive: true };

const ESC = '\u001B';
const KEYS = {
  enter: '\r',
  backspace: '\u007F',
  left: `${ESC}[D`,
  right: `${ESC}[C`,
  up: `${ESC}[A`,
  down: `${ESC}[B`,
  home: '\u0001',
  end: '\u0005',
  killLine: '\u0015',
  killWord: '\u0017',
  cancel: '\u0003',
  eof: '\u0004',
  tab: '\t',
  del: `${ESC}[3~`,
};

function start(text = '', history: readonly string[] = []): ComposerState {
  return { text, cursor: text.length, historyIndex: history.length, parked: '' };
}

/** Feeds a sequence of keys and returns whatever the editor ended up with. */
function type(
  keys: readonly string[],
  options: { initial?: string; history?: readonly string[]; completions?: readonly string[] } = {},
): { state: ComposerState; submitted?: string; cancelled?: boolean } {
  const history = options.history ?? [];
  let state = start(options.initial ?? '', history);

  for (const key of keys) {
    const step = applyKey(state, key, { history, completions: options.completions ?? [] });
    if (step.kind === 'submit') return { state, submitted: step.value };
    if (step.kind === 'cancel') return { state, cancelled: true };
    state = step.state;
  }
  return { state };
}

describe('the composer frame', () => {
  it('draws a box the full width, whatever is in it', () => {
    for (const text of ['', 'add a dark mode toggle', 'x'.repeat(200)]) {
      const frame = composerFrame(UNICODE, 60, { text, cursor: text.length });
      for (const line of frame.lines.slice(0, -1)) {
        assert.equal(visibleWidth(line), 60, `"${text.slice(0, 12)}" line: ${line}`);
      }
    }
  });

  it('measures the frame by what is visible, not by the bytes colour adds', () => {
    const frame = composerFrame(COLOR, 60, { text: 'hello', cursor: 5 });
    assert.ok(frame.lines[0]?.includes(ESC), 'this case only means anything when colour is on');
    for (const line of frame.lines) assert.equal(visibleWidth(line), 60);
  });

  it('falls back to a box a dumb terminal can draw', () => {
    const frame = composerFrame(ASCII, 40, { text: 'hi', cursor: 2 });
    assert.match(frame.lines[0] ?? '', /^\+-+\+$/);
    assert.match(stripAnsi(frame.lines[1] ?? ''), /^\| > hi/);
  });

  it('shows the placeholder only while there is nothing to show', () => {
    const empty = composerFrame(UNICODE, 60, { text: '', cursor: 0, placeholder: 'Describe the work' });
    assert.match(stripAnsi(empty.lines[1] ?? ''), /Describe the work/);

    const typed = composerFrame(UNICODE, 60, { text: 'a', cursor: 1, placeholder: 'Describe the work' });
    assert.ok(!stripAnsi(typed.lines[1] ?? '').includes('Describe the work'));
  });

  it('wraps rather than scrolling, so what was typed stays readable', () => {
    const width = 40;
    const textWidth = composerTextWidth(width);
    const text = 'y'.repeat(textWidth + 5);
    const frame = composerFrame(UNICODE, width, { text, cursor: text.length });

    // Top border, two rows of text, bottom border.
    assert.equal(frame.lines.length, 4);
    assert.match(stripAnsi(frame.lines[2] ?? ''), /yyyyy/);
  });

  it('puts the cursor where the caret is, on the row the caret is on', () => {
    const width = 40;
    const textWidth = composerTextWidth(width);

    const home = composerFrame(UNICODE, width, { text: 'hello', cursor: 0 });
    assert.equal(home.cursorLine, 1);
    assert.equal(home.cursorColumn, 5, 'the text starts after `│ › `');

    const end = composerFrame(UNICODE, width, { text: 'hello', cursor: 5 });
    assert.equal(end.cursorColumn, 10);

    // Exactly on the wrap boundary the caret belongs on the next row, which is
    // why an exact multiple still gets a row of its own.
    const wrapped = composerFrame(UNICODE, width, { text: 'z'.repeat(textWidth), cursor: textWidth });
    assert.equal(wrapped.cursorLine, 2);
    assert.equal(wrapped.cursorColumn, 5);
  });

  it('stops growing at a cap and follows the caret instead', () => {
    // Pasting a spec in here is a legitimate thing to do; a box as tall as the
    // spec is not.
    const width = 40;
    const text = 'w'.repeat(composerTextWidth(width) * 30);
    const frame = composerFrame(UNICODE, width, { text, cursor: text.length });

    assert.equal(frame.lines.length, 10, 'two borders and eight rows of text');
    assert.ok(frame.cursorLine <= 8, 'the caret stays inside the window');
    // The window is marked, so nobody reads its first row as the start of what
    // they pasted.
    assert.match(stripAnsi(frame.lines[1] ?? ''), /^│ … /);

    // Sending the caret home scrolls the window back to the top.
    const home = composerFrame(UNICODE, width, { text, cursor: 0 });
    assert.equal(home.cursorLine, 1);
    assert.match(stripAnsi(home.lines[1] ?? ''), /^│ › /);
  });

  it('carries the caption and the keys under the box', () => {
    const frame = composerFrame(UNICODE, 60, {
      text: '142',
      cursor: 3,
      caption: 'issue #142',
      hint: 'Enter start',
    });
    const last = stripAnsi(frame.lines.at(-1) ?? '');
    assert.match(last, /issue #142/);
    assert.match(last, /Enter start$/);
  });
});

describe('the composer editor', () => {
  it('types, and puts each character where the caret is', () => {
    assert.equal(type([...'hello']).state.text, 'hello');
    assert.equal(type([KEYS.left, KEYS.left, 'X'], { initial: 'abcd' }).state.text, 'abXcd');
  });

  it('deletes backwards and forwards', () => {
    assert.equal(type([KEYS.backspace], { initial: 'abc' }).state.text, 'ab');
    assert.equal(type([KEYS.home, KEYS.del], { initial: 'abc' }).state.text, 'bc');
    // Backspace at the start of the line is not an error, it is nothing.
    assert.equal(type([KEYS.home, KEYS.backspace], { initial: 'abc' }).state.text, 'abc');
  });

  it('kills a word and a line the way a shell does', () => {
    assert.equal(type([KEYS.killWord], { initial: 'fix the pager bug' }).state.text, 'fix the pager ');
    assert.equal(type([KEYS.killLine], { initial: 'everything' }).state.text, '');
  });

  it('never moves the caret outside the text', () => {
    assert.equal(type([KEYS.left, KEYS.left], { initial: 'a' }).state.cursor, 0);
    assert.equal(type([KEYS.end, KEYS.right, KEYS.right], { initial: 'ab' }).state.cursor, 2);
  });

  it('submits on Enter and cancels on Ctrl-C', () => {
    assert.equal(type([KEYS.enter], { initial: '142' }).submitted, '142');
    assert.equal(type([KEYS.cancel], { initial: '142' }).cancelled, true);
  });

  it('reads Ctrl-D on an empty line as leaving, and as delete on a full one', () => {
    assert.equal(type([KEYS.eof]).submitted, '');
    assert.equal(type([KEYS.home, KEYS.eof], { initial: 'abc' }).state.text, 'bc');
  });

  it('walks the history and gives back the line it parked', () => {
    const history = ['142', 'fix the pager'];
    const back = type([KEYS.up], { initial: 'half typed', history });
    assert.equal(back.state.text, 'fix the pager');

    const further = type([KEYS.up, KEYS.up], { initial: 'half typed', history });
    assert.equal(further.state.text, '142');

    // Down again past the newest entry restores what was being typed, rather
    // than the empty line a naive implementation leaves behind.
    const forward = type([KEYS.up, KEYS.up, KEYS.down, KEYS.down], { initial: 'half typed', history });
    assert.equal(forward.state.text, 'half typed');
  });

  it('completes a command to the longest prefix every match shares', () => {
    const completions = ['/review', '/run', '/status'];
    assert.equal(type([KEYS.tab], { initial: '/r', completions }).state.text, '/r');
    assert.equal(type([KEYS.tab], { initial: '/re', completions }).state.text, '/review');
    // Nothing matches, so nothing happens — not an error and not a deletion.
    assert.equal(type([KEYS.tab], { initial: '/zz', completions }).state.text, '/zz');
  });

  it('treats a newline inside a paste as content, not as Enter', () => {
    const state = start('');
    const step = applyKey(state, '\n', { history: [], pasted: true });
    assert.equal(step.kind, 'update');
    assert.equal(step.kind === 'update' ? step.state.text : '', ' ');

    // The same key typed by a person still submits.
    assert.equal(applyKey(state, '\n', { history: [] }).kind, 'submit');
  });

  it('ignores a key it does not know rather than printing its bytes', () => {
    assert.equal(type([`${ESC}[15~`], { initial: 'abc' }).state.text, 'abc');
  });
});

describe('reading keys off the wire', () => {
  it('keeps an escape sequence together, and splits plain characters apart', () => {
    assert.deepEqual(tokenizeKeys(`ab${ESC}[Dc`), ['a', 'b', `${ESC}[D`, 'c']);
    assert.deepEqual(tokenizeKeys(`${ESC}[3~`), [`${ESC}[3~`]);
    assert.deepEqual(tokenizeKeys(`${ESC}b`), [`${ESC}b`]);
  });

  it('finds the prefix a set of candidates shares', () => {
    assert.equal(commonPrefix(['/review', '/revert']), '/rev');
    assert.equal(commonPrefix(['/help']), '/help');
    assert.equal(commonPrefix([]), '');
    assert.equal(commonPrefix(['/a', '/b']), '/');
  });
});

/** A terminal that can be typed into, for the two things only the loop does. */
function fakeTerminal(): {
  input: Parameters<typeof readComposer>[0]['input'] & { send(chunk: string): void };
  output: NodeJS.WriteStream;
  written: string[];
  raw: boolean[];
} {
  const listeners: Array<(chunk: Buffer | string) => void> = [];
  const written: string[] = [];
  const raw: boolean[] = [];

  const input = {
    isTTY: true,
    isRaw: false,
    setRawMode(mode: boolean) {
      raw.push(mode);
    },
    on(_event: 'data', listener: (chunk: Buffer | string) => void) {
      listeners.push(listener);
      return this;
    },
    off(_event: 'data', listener: (chunk: Buffer | string) => void) {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
      return this;
    },
    pause() {
      return this;
    },
    resume() {
      return this;
    },
    send(chunk: string) {
      for (const listener of [...listeners]) listener(chunk);
    },
  };

  const output = {
    isTTY: true,
    columns: 60,
    write(chunk: string): boolean {
      written.push(chunk);
      return true;
    },
  } as unknown as NodeJS.WriteStream;

  return { input, output, written, raw };
}

describe('reading a composed line', () => {
  it('returns what was typed, and leaves the terminal as it found it', async () => {
    const terminal = fakeTerminal();
    const pending = readComposer({ theme: UNICODE, width: 60, input: terminal.input, output: terminal.output });

    terminal.input.send('142');
    terminal.input.send('\r');

    assert.equal(await pending, '142');
    assert.deepEqual(terminal.raw, [true, false], 'raw mode is turned on for the read and handed back after');
    // The frame is erased on the way out, so what happens next starts on a
    // clean line rather than under an abandoned box.
    assert.match(terminal.written.at(-1) ?? '', /\[0J/);
  });

  it('rejects Ctrl-C as a cancellation, the way every other prompt does', async () => {
    const terminal = fakeTerminal();
    const pending = readComposer({ theme: UNICODE, width: 60, input: terminal.input, output: terminal.output });

    terminal.input.send('\u0003');

    await assert.rejects(pending, (error: unknown) => isPromptCancelled(error));
  });
});
