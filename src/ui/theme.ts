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

/** Truncates to the terminal width so live redraws never wrap and smear. */
export function fitWidth(text: string, stream: NodeJS.WriteStream = process.stdout): string {
  const width = stream.columns ?? 80;
  if (text.length <= width) return text;
  return `${text.slice(0, Math.max(0, width - 1))}…`;
}
