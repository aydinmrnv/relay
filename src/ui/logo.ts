/**
 * Relay's wordmark, drawn from a pixel font rather than pasted as art.
 *
 * The glyphs below are a 5×5 grid per character, written with `#` for ink and a
 * space for paper so a letter can be read — and corrected — in the source. The
 * ink character is chosen at render time, which is what makes one table serve
 * both alphabets: a unicode terminal gets a solid block, `RELAY_ASCII=1` and
 * `TERM=dumb` get `#`, and neither is a second drawing that can drift from the
 * first.
 */
import { paint, visibleWidth, type ColorName, type Theme } from './theme.ts';

const GLYPH_HEIGHT = 5;
const GLYPH_WIDTH = 5;
/** Blank columns between two letters. */
const TRACKING = 1;

const INK = '#';

/**
 * The font. Every glyph is exactly `GLYPH_HEIGHT` rows of `GLYPH_WIDTH`
 * characters — a test asserts it, because a glyph one column short shears
 * every letter after it on that row.
 */
const FONT: Readonly<Record<string, readonly string[]>> = {
  A: [' ### ', '#   #', '#####', '#   #', '#   #'],
  B: ['#### ', '#   #', '#### ', '#   #', '#### '],
  C: [' ####', '#    ', '#    ', '#    ', ' ####'],
  D: ['#### ', '#   #', '#   #', '#   #', '#### '],
  E: ['#####', '#    ', '#### ', '#    ', '#####'],
  F: ['#####', '#    ', '#### ', '#    ', '#    '],
  G: [' ####', '#    ', '#  ##', '#   #', ' ####'],
  H: ['#   #', '#   #', '#####', '#   #', '#   #'],
  I: ['#####', '  #  ', '  #  ', '  #  ', '#####'],
  J: ['#####', '   # ', '   # ', '#  # ', ' ##  '],
  K: ['#   #', '#  # ', '###  ', '#  # ', '#   #'],
  L: ['#    ', '#    ', '#    ', '#    ', '#####'],
  M: ['#   #', '## ##', '# # #', '#   #', '#   #'],
  N: ['#   #', '##  #', '# # #', '#  ##', '#   #'],
  O: [' ### ', '#   #', '#   #', '#   #', ' ### '],
  P: ['#### ', '#   #', '#### ', '#    ', '#    '],
  Q: [' ### ', '#   #', '#   #', '#  # ', ' ## #'],
  R: ['#### ', '#   #', '#### ', '#  # ', '#   #'],
  S: [' ####', '#    ', ' ### ', '    #', '#### '],
  T: ['#####', '  #  ', '  #  ', '  #  ', '  #  '],
  U: ['#   #', '#   #', '#   #', '#   #', ' ### '],
  V: ['#   #', '#   #', '#   #', ' # # ', '  #  '],
  W: ['#   #', '#   #', '# # #', '## ##', '#   #'],
  X: ['#   #', ' # # ', '  #  ', ' # # ', '#   #'],
  Y: ['#   #', ' # # ', '  #  ', '  #  ', '  #  '],
  Z: ['#####', '   # ', '  #  ', ' #   ', '#####'],
  '0': [' ### ', '#  ##', '# # #', '##  #', ' ### '],
  '1': ['  #  ', ' ##  ', '  #  ', '  #  ', '#####'],
  '2': [' ### ', '#   #', '   # ', '  #  ', '#####'],
  '3': ['#### ', '    #', ' ### ', '    #', '#### '],
  '4': ['#   #', '#   #', '#####', '    #', '    #'],
  '5': ['#####', '#    ', '#### ', '    #', '#### '],
  '6': [' ### ', '#    ', '#### ', '#   #', ' ### '],
  '7': ['#####', '    #', '   # ', '  #  ', '  #  '],
  '8': [' ### ', '#   #', ' ### ', '#   #', ' ### '],
  '9': [' ### ', '#   #', ' ####', '    #', ' ### '],
  '-': ['     ', '     ', ' ### ', '     ', '     '],
  '.': ['     ', '     ', '     ', '     ', '  #  '],
  ' ': ['     ', '     ', '     ', '     ', '     '],
};

/** Anything the font has no glyph for is drawn as a blank rather than dropped. */
const FALLBACK = FONT[' ']!;

export const LOGO_TEXT = 'RELAY';

/** Columns `bigText` needs for `text`, so a caller can pick a size that fits. */
export function bigTextWidth(text: string): number {
  if (text.length === 0) return 0;
  return text.length * GLYPH_WIDTH + (text.length - 1) * TRACKING;
}

/**
 * Renders `text` in the pixel font, one string per row. Unknown characters
 * become blanks: a wordmark is decoration, and decoration must never be able to
 * throw on the way to a command the user actually asked for.
 */
export function bigText(text: string, theme: Theme): string[] {
  const ink = theme.unicode ? '█' : INK;
  const letters = [...text.toUpperCase()].map((character) => FONT[character] ?? FALLBACK);

  const rows: string[] = [];
  for (let row = 0; row < GLYPH_HEIGHT; row += 1) {
    const cells = letters.map((letter) => (letter[row] ?? '').replaceAll(INK, ink));
    // Trailing paper is trimmed: it is invisible, and keeping it would pad every
    // logo line to the same width and defeat centring.
    rows.push(cells.join(' '.repeat(TRACKING)).trimEnd());
  }
  return rows;
}

/**
 * A vertical two-tone wash over the wordmark. Cheap, and it reads as a designed
 * mark rather than as output — which is the whole point of showing one.
 */
const WORDMARK_COLORS: readonly ColorName[] = ['cyan', 'cyan', 'cyan', 'blue', 'blue'];

export interface LogoOptions {
  theme: Theme;
  /** Columns available. The full wordmark is dropped when it will not fit. */
  width?: number;
  /** One dim line under the mark, e.g. what the command is about to do. */
  tagline?: string;
  /** Forces a size instead of choosing one from `width`. */
  size?: LogoSize;
}

export type LogoSize = 'full' | 'compact';

/** The inline badge: a mark and the name, for headers with one line to spend. */
export function logoMark(theme: Theme): string {
  const diamond = theme.unicode ? '◆' : '*';
  return `${paint(theme, 'cyan', diamond)} ${paint(theme, 'bold', LOGO_TEXT)}`;
}

/**
 * The banner Relay's entry points open with. `full` is the pixel wordmark;
 * `compact` is the badge with letter-spacing, for a terminal too narrow to hold
 * the other. The choice is made from the width rather than left to the caller,
 * so no command has to know how wide its own logo is.
 */
export function relayLogo(options: LogoOptions): string[] {
  const { theme, tagline } = options;
  const width = options.width ?? 80;
  const size = options.size ?? (width >= bigTextWidth(LOGO_TEXT) + 4 ? 'full' : 'compact');

  const lines =
    size === 'full'
      ? bigText(LOGO_TEXT, theme).map((row, index) =>
          paint(theme, WORDMARK_COLORS[index] ?? 'cyan', row),
        )
      : [`${logoMark(theme)}  ${paint(theme, 'gray', [...LOGO_TEXT].join(' ').toLowerCase())}`];

  if (tagline !== undefined && tagline.length > 0) {
    // A rule as wide as the mark ties the tagline to it instead of leaving it
    // floating under a shape it has nothing to do with.
    const rule = (theme.unicode ? '─' : '-').repeat(
      Math.min(width, Math.max(...lines.map(visibleWidth))),
    );
    lines.push(paint(theme, 'gray', rule));
    lines.push(paint(theme, 'gray', tagline));
  }

  return lines;
}

/**
 * A one-line separator carrying the mark, for the top of a run rather than the
 * top of a session: `◆ RELAY ─── Issue #142`.
 */
export function logoBar(theme: Theme, text: string, width: number): string {
  const mark = logoMark(theme);
  const label = text.length === 0 ? '' : ` ${text}`;
  const dash = theme.unicode ? '─' : '-';
  // The mark, the single space after it, and the label: everything the fill is
  // not. Miscounting here leaves the bar a column short of every frame under it.
  const used = visibleWidth(mark) + 1 + visibleWidth(label);
  const fill = paint(theme, 'gray', dash.repeat(Math.max(0, width - used)));
  return `${mark} ${fill}${label}`;
}
