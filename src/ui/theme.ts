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
    color: !noColor && !isDumb && isTTY,
    unicode: env['RELAY_ASCII'] === undefined && !isDumb,
    interactive: isTTY && !isCI && !isDumb,
  };
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
}

export function glyphs(theme: Theme): Glyphs {
  return theme.unicode
    ? { pending: '○', active: '●', done: '●', ok: '✓', failed: '✗', skipped: '·', bullet: '•', arrow: '→' }
    : { pending: 'o', active: '*', done: '*', ok: 'v', failed: 'x', skipped: '-', bullet: '-', arrow: '->' };
}

/** Truncates to the terminal width so live redraws never wrap and smear. */
export function fitWidth(text: string, stream: NodeJS.WriteStream = process.stdout): string {
  const width = stream.columns ?? 80;
  if (text.length <= width) return text;
  return `${text.slice(0, Math.max(0, width - 1))}…`;
}
