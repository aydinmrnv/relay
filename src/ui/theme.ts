/**
 * Colour and glyph support, resolved once from the environment.
 * NO_COLOR, CI, dumb terminals and pipes are all respected: Relay must be
 * readable when its output is redirected to a file or a log collector.
 */
export interface Theme {
  color: boolean;
  unicode: boolean;
  /** True when a live-redrawing progress display is appropriate. */
  interactive: boolean;
}

export function detectTheme(stream: NodeJS.WriteStream = process.stdout): Theme {
  const env = process.env;
  const noColor = env['NO_COLOR'] !== undefined && env['NO_COLOR'] !== '';
  const isCI = env['CI'] !== undefined && env['CI'] !== '' && env['CI'] !== '0' && env['CI'] !== 'false';
  const isDumb = env['TERM'] === 'dumb';
  const isTTY = stream.isTTY === true;

  return {
    // CI turns colour off even on an allocated TTY: the output's real reader is
    // a stored log, and an escape sequence in a log is noise nobody asked for.
    color: !noColor && !isDumb && !isCI && isTTY,
    unicode: env['RELAY_ASCII'] === undefined && !isDumb,
    interactive: isTTY && !isCI && !isDumb,
  };
}

/**
 * Typographic characters Relay uses in its own chrome, and the ASCII that
 * replaces them when the terminal cannot show them.
 */
const DOWNGRADES: ReadonlyArray<readonly [RegExp, string]> = [
  [/[—–]/g, '-'],
  [/→/g, '->'],
  [/[•·]/g, '-'],
  [/−/g, '-'],
  [/…/g, '...'],
  [/✓/g, 'v'],
  [/✗/g, 'x'],
];

/**
 * Downgrades a line of Relay's own output for `RELAY_ASCII=1` and `TERM=dumb`.
 *
 * This is the safety net behind `glyphs()`: prose is written in normal English
 * punctuation and made safe once, here, rather than by every sentence
 * remembering to look up a glyph. It must never touch content Relay is only
 * passing through — a patch, a JSON document, an agent's plan — because a
 * rewritten patch does not apply and rewritten JSON does not parse.
 */
export function asciiSafe(text: string, theme: Theme): string {
  if (theme.unicode) return text;
  return DOWNGRADES.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), text);
}

const CODES = {
  reset: '\u001B[0m',
  bold: '\u001B[1m',
  dim: '\u001B[2m',
  red: '\u001B[31m',
  green: '\u001B[32m',
  yellow: '\u001B[33m',
  blue: '\u001B[34m',
  magenta: '\u001B[35m',
  cyan: '\u001B[36m',
  gray: '\u001B[90m',
} as const;

export type ColorName = Exclude<keyof typeof CODES, 'reset'>;

export function paint(theme: Theme, color: ColorName, text: string): string {
  return theme.color ? `${CODES[color]}${text}${CODES.reset}` : text;
}

export interface Glyphs {
  pending: string;
  active: string;
  done: string;
  ok: string;
  failed: string;
  skipped: string;
  bullet: string;
  arrow: string;
  /** Frames for the active-phase spinner, cycled by the renderer. */
  spinner: readonly string[];
}

const UNICODE_SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;
const ASCII_SPINNER = ['|', '/', '-', '\\'] as const;

export function glyphs(theme: Theme): Glyphs {
  return theme.unicode
    ? {
        pending: '○',
        active: '●',
        done: '●',
        ok: '✓',
        failed: '✗',
        skipped: '·',
        bullet: '•',
        arrow: '→',
        spinner: UNICODE_SPINNER,
      }
    : {
        pending: 'o',
        active: '*',
        done: '*',
        ok: 'v',
        failed: 'x',
        skipped: '-',
        bullet: '-',
        arrow: '->',
        spinner: ASCII_SPINNER,
      };
}

// ---------------------------------------------------------------------------
// Measuring painted text.
//
// `paint()` puts bytes in a string that occupy no columns, so `.length` is not
// a width once anything is coloured — and a frame padded by `.length` has a
// ragged right edge exactly when colour is on. Everything that aligns, pads or
// clips Relay's chrome measures through here instead.
//
// These count UTF-16 code units, which is the true column count for the
// characters Relay's own chrome is made of: box drawing, block letters, ASCII
// and Latin punctuation are all one column and one unit. Content Relay merely
// passes through never reaches this code, so a wide CJK character or an emoji
// in an issue title is clipped by `oneLine()` long before a frame sees it.
// ---------------------------------------------------------------------------

/** One ANSI sequence: colour, cursor movement and erase alike. */
const ANSI = /\u001B\[[0-9;]*[A-Za-z]/;
/** The same, as a splitter that keeps the sequences as their own tokens. */
const ANSI_TOKENS = /(\u001B\[[0-9;]*[A-Za-z])/;

export function stripAnsi(text: string): string {
  return text.split(ANSI_TOKENS).filter((part) => !ANSI.test(part)).join('');
}

/** Columns `text` will occupy, ignoring the escape sequences that occupy none. */
export function visibleWidth(text: string): number {
  return stripAnsi(text).length;
}

/**
 * Clips to `width` columns, counting only what is visible and never cutting an
 * escape sequence in half — a severed sequence bleeds its colour into the rest
 * of the screen. Styling that survived the cut is closed with a reset.
 */
export function truncateVisible(text: string, width: number, ellipsis = '…'): string {
  if (width <= 0) return '';
  if (visibleWidth(text) <= width) return text;

  const budget = Math.max(0, width - ellipsis.length);
  let kept = '';
  let used = 0;
  let styled = false;

  for (const part of text.split(ANSI_TOKENS)) {
    if (part.length === 0) continue;
    if (ANSI.test(part)) {
      // Escapes cost no columns, so they are kept in full: dropping the opening
      // sequence of a colour whose text survives would render it unpainted.
      kept += part;
      styled = true;
      continue;
    }
    if (used >= budget) continue;
    const take = part.slice(0, budget - used);
    kept += take;
    used += take.length;
  }

  return `${kept}${ellipsis}${styled ? CODES.reset : ''}`;
}

/** Pads to exactly `width` visible columns, clipping anything longer. */
export function padVisible(text: string, width: number, align: 'left' | 'right' = 'left'): string {
  const clipped = truncateVisible(text, width);
  const padding = ' '.repeat(Math.max(0, width - visibleWidth(clipped)));
  return align === 'right' ? `${padding}${clipped}` : `${clipped}${padding}`;
}

/** Truncates to the terminal width so live redraws never wrap and smear. */
export function fitWidth(text: string, stream: NodeJS.WriteStream = process.stdout): string {
  return truncateVisible(text, stream.columns ?? 80);
}
