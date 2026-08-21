/**
 * The composer: a framed, live-edited input line.
 *
 * `node:readline` can already read a line, and for a question with one right
 * answer that is enough. This is for the other kind of input — the one where
 * the user is composing rather than answering, and where what they have typed
 * so far changes what Relay is about to do. A frame that stays put, a caption
 * that reads back the interpretation as it changes, and a cursor that can be
 * moved through the text are what make that legible, and none of the three
 * survive being handed to readline's line discipline.
 *
 * The drawing is separated from the reading on purpose: `composerFrame` is a
 * pure function of the text and the cursor, so the layout is asserted in tests
 * against a string, and only `readComposer` needs a terminal.
 */
import { RelayError } from '../util/errors.ts';
import { borders, statusBar } from './box.ts';
import { padVisible, paint, truncateVisible, visibleWidth, type ColorName, type Theme } from './theme.ts';

/** Columns of chrome around the text: `│ › ` on the left, ` │` on the right. */
const GUTTER = 4;
const MARGIN = 2;
/** Below this there is no room to type in, and the caller should use a plain prompt. */
const MIN_COMPOSER_WIDTH = 24;
/** The widest a composer gets, matching the panels it sits under. */
const MAX_COMPOSER_WIDTH = 92;
/** The tallest the box grows before it starts scrolling instead. */
const MAX_ROWS = 8;

const ESC = '\u001B';

/**
 * The keys this editor understands, by the bytes a terminal actually sends.
 * Named here rather than inline: `'\u0017'` in a condition is unreadable, and
 * a wrong one is a key that silently does nothing.
 */
const KEY = {
  ctrlA: '\u0001',
  ctrlC: '\u0003',
  ctrlD: '\u0004',
  ctrlE: '\u0005',
  ctrlK: '\u000B',
  ctrlU: '\u0015',
  ctrlW: '\u0017',
  backspace: '\u007F',
  backspaceAlt: '\b',
  tab: '\t',
  enter: '\r',
  newline: '\n',
  up: `${ESC}[A`,
  down: `${ESC}[B`,
  right: `${ESC}[C`,
  left: `${ESC}[D`,
  home: `${ESC}[H`,
  homeAlt: `${ESC}OH`,
  end: `${ESC}[F`,
  endAlt: `${ESC}OF`,
  del: `${ESC}[3~`,
  wordLeft: `${ESC}b`,
  wordRight: `${ESC}f`,
  ctrlLeft: `${ESC}[1;5D`,
  ctrlRight: `${ESC}[1;5C`,
} as const;

export interface ComposerView {
  text: string;
  /** Index into `text`, from 0 to `text.length`. */
  cursor: number;
  /** Shown dim when the text is empty. */
  placeholder?: string;
  /** Reads back what the current text will do: `issue #142`, `new task`. */
  caption?: string;
  /** Key reminders, pinned to the right under the frame. */
  hint?: string;
  /** Painted around the frame. */
  accent?: ColorName;
}

export interface ComposerFrame {
  lines: string[];
  /** Where the cursor belongs: an index into `lines`, and a 1-based column. */
  cursorLine: number;
  cursorColumn: number;
}

/** Columns of text one row of the frame holds. */
export function composerTextWidth(width: number): number {
  return Math.max(8, width - GUTTER - MARGIN);
}

/**
 * The frame, its contents, and where the cursor goes.
 *
 * Long input wraps inside the frame rather than scrolling horizontally: a task
 * description is usually a sentence or two, and a reader who cannot see the
 * beginning of what they typed cannot check it before pressing Enter.
 */
export function composerFrame(theme: Theme, width: number, view: ComposerView): ComposerFrame {
  const marks = borders(theme);
  const accent: ColorName = view.accent ?? 'cyan';
  const textWidth = composerTextWidth(width);
  const edge = (text: string): string => paint(theme, accent, text);
  const arrow = theme.unicode ? '›' : '>';
  const ellipsis = theme.unicode ? '…' : ':';

  // One row per wrapped chunk, and always at least one — plus a trailing row
  // when the text ends exactly on a boundary, so the cursor has somewhere to be.
  const rowCount = Math.floor(view.text.length / textWidth) + 1;
  const cursorRow = Math.min(Math.floor(view.cursor / textWidth), rowCount - 1);

  // A pasted spec is a legitimate thing to type here, and a box as tall as the
  // paste is not. Past the cap the frame becomes a window that follows the
  // caret, with the top row marked so nobody reads it as the whole of what they
  // pasted.
  const visibleRows = Math.min(rowCount, MAX_ROWS);
  const firstRow = Math.max(0, Math.min(cursorRow - visibleRows + 1, rowCount - visibleRows));

  const rows: string[] = [];
  for (let offset = 0; offset < visibleRows; offset += 1) {
    const row = firstRow + offset;
    const chunk = view.text.slice(row * textWidth, (row + 1) * textWidth);
    const body =
      row === 0 && view.text.length === 0 && view.placeholder !== undefined
        ? paint(theme, 'gray', truncateVisible(view.placeholder, textWidth))
        : chunk;
    const marker = offset === 0 && firstRow > 0 ? `${paint(theme, 'gray', ellipsis)} ` : row === 0 ? `${edge(arrow)} ` : '  ';
    rows.push(`${edge(marks.vertical)} ${marker}${padVisible(body, textWidth)} ${edge(marks.vertical)}`);
  }

  const rule = marks.horizontal.repeat(Math.max(0, width - 2));
  const lines = [
    edge(`${marks.topLeft}${rule}${marks.topRight}`),
    ...rows,
    edge(`${marks.bottomLeft}${rule}${marks.bottomRight}`),
  ];

  if (view.caption !== undefined || view.hint !== undefined) {
    const hint = view.hint ?? '';
    // The caption is derived from whatever was typed, so it has no natural
    // length. Clipping it to the room the keys leave keeps this line one line —
    // a caption that wraps would push the frame's own geometry off by a row.
    const room = Math.max(0, width - MARGIN - visibleWidth(hint) - 2);
    lines.push(
      `  ${statusBar(
        paint(theme, 'gray', truncateVisible(view.caption ?? '', room)),
        paint(theme, 'gray', hint),
        Math.max(0, width - MARGIN),
      )}`,
    );
  }

  return {
    lines,
    // Line 0 is the top border, so the first visible row of text is line 1.
    cursorLine: 1 + (cursorRow - firstRow),
    cursorColumn: GUTTER + (view.cursor - cursorRow * textWidth) + 1,
  };
}

/**
 * The slice of stdin a composer touches. Structural rather than
 * `NodeJS.ReadStream` for the same reason the renderer's is: a test hands this
 * a plain stream, and a pipe has no raw mode to set.
 */
export interface ComposerInput {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?: (mode: boolean) => void;
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  off(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  pause(): unknown;
  resume(): unknown;
}

/** Whether this terminal can host a composer, or whether to fall back to a prompt. */
export function composerSupported(
  input: ComposerInput = process.stdin,
  output: NodeJS.WriteStream = process.stdout,
): boolean {
  return (
    input.isTTY === true &&
    typeof input.setRawMode === 'function' &&
    output.isTTY === true &&
    (output.columns ?? 0) >= MIN_COMPOSER_WIDTH
  );
}

export interface ComposerOptions {
  theme: Theme;
  width: number;
  placeholder?: string;
  hint?: string;
  accent?: ColorName;
  /** Prefilled text, e.g. when the composer re-opens on a line that was refused. */
  initial?: string;
  /**
   * Re-read after every keystroke, so the line under the frame can describe
   * what the text means before it is submitted.
   */
  describe?: (value: string) => string;
  /** Offered on Tab. The longest shared prefix of the matches is completed. */
  completions?: readonly string[];
  /** Previous entries, oldest first. Walked with the up and down arrows. */
  history?: readonly string[];
  input?: ComposerInput;
  output?: NodeJS.WriteStream;
}

/** One key, as a token: a single character, or a whole escape sequence. */
export function tokenizeKeys(chunk: string): string[] {
  const keys: string[] = [];
  for (let index = 0; index < chunk.length; index += 1) {
    const char = chunk[index]!;
    if (char !== ESC || index + 1 >= chunk.length) {
      keys.push(char);
      continue;
    }
    const next = chunk[index + 1]!;
    if (next !== '[' && next !== 'O') {
      // Alt-<key> arrives as ESC followed by the key itself.
      keys.push(chunk.slice(index, index + 2));
      index += 1;
      continue;
    }
    let end = index + 2;
    while (end < chunk.length && !/[A-Za-z~]/.test(chunk[end]!)) end += 1;
    keys.push(chunk.slice(index, end + 1));
    index = end;
  }
  return keys;
}

function isPrintable(key: string): boolean {
  return key.length === 1 && key >= ' ' && key !== KEY.backspace;
}

/** Where the word before `cursor` starts. */
function wordStart(text: string, cursor: number): number {
  let index = cursor;
  while (index > 0 && /\s/.test(text[index - 1]!)) index -= 1;
  while (index > 0 && !/\s/.test(text[index - 1]!)) index -= 1;
  return index;
}

function wordEnd(text: string, cursor: number): number {
  let index = cursor;
  while (index < text.length && /\s/.test(text[index]!)) index += 1;
  while (index < text.length && !/\s/.test(text[index]!)) index += 1;
  return index;
}

/** The longest string every candidate starts with, for Tab completion. */
export function commonPrefix(values: readonly string[]): string {
  const [first, ...rest] = values;
  if (first === undefined) return '';
  let prefix = first;
  for (const value of rest) {
    while (prefix.length > 0 && !value.startsWith(prefix)) prefix = prefix.slice(0, -1);
  }
  return prefix;
}

/**
 * The editor, as a pure step: a key and a state in, the next state out.
 *
 * Every key Relay's composer understands is decided here, so the behaviour can
 * be tested by feeding it keystrokes — no pseudo-terminal, no timing, and no
 * chance of the test asserting something the real editor does not do.
 */
export interface ComposerState {
  text: string;
  cursor: number;
  /** Index into the history; its length means "the line being typed". */
  historyIndex: number;
  /** The live line, parked while the arrows walk the history. */
  parked: string;
}

export type ComposerStep =
  | { kind: 'update'; state: ComposerState }
  | { kind: 'submit'; value: string }
  | { kind: 'cancel' };

export interface EditorContext {
  history: readonly string[];
  completions?: readonly string[];
  /** True when the key arrived inside a paste, where a newline is content. */
  pasted?: boolean;
}

export function applyKey(state: ComposerState, key: string, context: EditorContext): ComposerStep {
  const { text, cursor } = state;
  const update = (next: Partial<ComposerState>): ComposerStep => ({ kind: 'update', state: { ...state, ...next } });

  if (key === KEY.ctrlC) return { kind: 'cancel' };

  if (key === KEY.enter || key === KEY.newline) {
    // A newline inside a paste is part of what was pasted, and submitting on it
    // would run the first line and leave the rest in the next prompt.
    if (context.pasted !== true) return { kind: 'submit', value: text };
    return update({ text: `${text.slice(0, cursor)} ${text.slice(cursor)}`, cursor: cursor + 1 });
  }

  // Ctrl-D on an empty line is end of input, which every shell reads as "I am
  // done here" — the same answer Enter on an empty line gives.
  if (key === KEY.ctrlD) {
    if (text.length === 0) return { kind: 'submit', value: '' };
    return update({ text: text.slice(0, cursor) + text.slice(cursor + 1) });
  }

  if (key === KEY.backspace || key === KEY.backspaceAlt) {
    if (cursor === 0) return update({});
    return update({ text: text.slice(0, cursor - 1) + text.slice(cursor), cursor: cursor - 1 });
  }
  if (key === KEY.del) return update({ text: text.slice(0, cursor) + text.slice(cursor + 1) });
  if (key === KEY.ctrlU) return update({ text: text.slice(cursor), cursor: 0 });
  if (key === KEY.ctrlK) return update({ text: text.slice(0, cursor) });
  if (key === KEY.ctrlW) {
    const start = wordStart(text, cursor);
    return update({ text: text.slice(0, start) + text.slice(cursor), cursor: start });
  }

  if (key === KEY.left) return update({ cursor: Math.max(0, cursor - 1) });
  if (key === KEY.right) return update({ cursor: Math.min(text.length, cursor + 1) });
  if (key === KEY.wordLeft || key === KEY.ctrlLeft) return update({ cursor: wordStart(text, cursor) });
  if (key === KEY.wordRight || key === KEY.ctrlRight) return update({ cursor: wordEnd(text, cursor) });
  if (key === KEY.ctrlA || key === KEY.home || key === KEY.homeAlt) return update({ cursor: 0 });
  if (key === KEY.ctrlE || key === KEY.end || key === KEY.endAlt) return update({ cursor: text.length });

  // The arrows walk what was typed here before, the way a shell does. The live
  // line is parked on the way up and restored on the way back down.
  if (key === KEY.up || key === KEY.down) {
    const history = context.history;
    if (history.length === 0) return update({});
    if (key === KEY.up) {
      if (state.historyIndex === 0) return update({});
      const index = state.historyIndex - 1;
      const next = history[index] ?? '';
      return update({
        text: next,
        cursor: next.length,
        historyIndex: index,
        parked: state.historyIndex === history.length ? text : state.parked,
      });
    }
    if (state.historyIndex >= history.length) return update({});
    const index = state.historyIndex + 1;
    const next = index === history.length ? state.parked : history[index] ?? '';
    return update({ text: next, cursor: next.length, historyIndex: index });
  }

  if (key === KEY.tab) {
    const matches = (context.completions ?? []).filter((candidate) => candidate.startsWith(text));
    if (matches.length === 0) return update({});
    const completed = commonPrefix(matches);
    return update({ text: completed, cursor: completed.length });
  }

  if (isPrintable(key)) {
    return update({ text: text.slice(0, cursor) + key + text.slice(cursor), cursor: cursor + 1 });
  }
  return update({});
}

/**
 * Reads one composed line.
 *
 * Resolves with the text on Enter — including the empty string, which is how
 * every flow in Relay says "nothing, thanks". Ctrl-C rejects with the same
 * cancellation the prompter throws, so a caller handles one kind of quit.
 */
export async function readComposer(options: ComposerOptions): Promise<string> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const history = [...(options.history ?? [])];

  let state: ComposerState = {
    text: options.initial ?? '',
    cursor: (options.initial ?? '').length,
    historyIndex: history.length,
    parked: '',
  };

  let drawnCursorLine = 0;
  let drawn = false;

  const view = (): ComposerView => {
    const caption = options.describe?.(state.text);
    return {
      text: state.text,
      cursor: state.cursor,
      ...(options.placeholder === undefined ? {} : { placeholder: options.placeholder }),
      ...(options.hint === undefined ? {} : { hint: options.hint }),
      ...(caption === undefined ? {} : { caption }),
      ...(options.accent === undefined ? {} : { accent: options.accent }),
    };
  };

  const clear = (): void => {
    if (!drawn) return;
    // The cursor sits inside the frame; walk it back to the top-left of the
    // region before erasing, or the erase takes the lines above it too.
    if (drawnCursorLine > 0) output.write(`${ESC}[${drawnCursorLine}A`);
    output.write(`\r${ESC}[0J`);
    drawn = false;
  };

  const draw = (): void => {
    // Re-read the width on every frame rather than freezing it at open: a
    // terminal resized mid-sentence would otherwise wrap the text at the old
    // width for as long as the prompt stayed open.
    const width = output.columns === undefined ? options.width : composerWidth(output);
    const frame = composerFrame(options.theme, width, view());
    output.write(`${frame.lines.join('\n')}\n`);
    // The cursor is now one line past the frame; walk it back to the caret's
    // row and put it in the right column.
    const up = frame.lines.length - frame.cursorLine;
    if (up > 0) output.write(`${ESC}[${up}A`);
    output.write(`${ESC}[${frame.cursorColumn}G`);
    drawnCursorLine = frame.cursorLine;
    drawn = true;
  };

  const priorRaw = input.isRaw === true;
  input.setRawMode?.(true);
  input.resume();
  draw();

  try {
    return await new Promise<string>((resolve, reject) => {
      const onData = (chunk: Buffer | string): void => {
        const keys = tokenizeKeys(chunk.toString());
        // A multi-key chunk carrying text is a paste, not typing: its newlines
        // are part of the pasted content and must not submit half of it.
        const pasted = keys.length > 1 && keys.some(isPrintable);

        for (const key of keys) {
          const step = applyKey(state, key, { history, completions: options.completions ?? [], pasted });
          if (step.kind === 'update') {
            state = step.state;
            continue;
          }
          input.off('data', onData);
          clear();
          if (step.kind === 'submit') resolve(step.value);
          else reject(new RelayError('Cancelled.', { code: 'PROMPT_CANCELLED' }));
          return;
        }

        clear();
        draw();
      };

      input.on('data', onData);
    });
  } finally {
    input.setRawMode?.(priorRaw);
    input.pause();
  }
}

/** The width a composer lays out to, given the terminal. */
export function composerWidth(output: NodeJS.WriteStream = process.stdout): number {
  return Math.max(MIN_COMPOSER_WIDTH, Math.min(MAX_COMPOSER_WIDTH, (output.columns ?? 80) - 1));
}
