/**
 * Frames, tables, gauges and status bars: the chrome that makes a terminal read
 * like a panelled interface instead of a scroll of sentences.
 *
 * Two rules hold throughout. Every border character is chosen from the theme
 * rather than written literally, so `RELAY_ASCII=1` and `TERM=dumb` get a frame
 * made of `+-|` instead of a row of question marks. And every width is measured
 * with `visibleWidth`, never `.length`, because a coloured cell carries bytes
 * that occupy no columns — padding by `.length` puts the right-hand border in a
 * different place on every row exactly when colour is on.
 *
 * These return `string[]` rather than printing, so the same panel can be pushed
 * into a live redraw region, written to a pipe, or asserted in a test.
 */
import { padVisible, paint, truncateVisible, visibleWidth, type ColorName, type Theme } from './theme.ts';

export interface BorderSet {
  topLeft: string;
  topRight: string;
  bottomLeft: string;
  bottomRight: string;
  horizontal: string;
  vertical: string;
  teeLeft: string;
  teeRight: string;
}

const UNICODE_BORDERS: BorderSet = {
  topLeft: '╭',
  topRight: '╮',
  bottomLeft: '╰',
  bottomRight: '╯',
  horizontal: '─',
  vertical: '│',
  teeLeft: '├',
  teeRight: '┤',
};

const ASCII_BORDERS: BorderSet = {
  topLeft: '+',
  topRight: '+',
  bottomLeft: '+',
  bottomRight: '+',
  horizontal: '-',
  vertical: '|',
  teeLeft: '+',
  teeRight: '+',
};

export function borders(theme: Theme): BorderSet {
  return theme.unicode ? UNICODE_BORDERS : ASCII_BORDERS;
}

/** The widest a panel may be, however wide the terminal is. */
const MAX_LAYOUT_WIDTH = 92;
/** Below this, a frame costs more columns than it earns; callers fall back to plain lines. */
export const MIN_LAYOUT_WIDTH = 36;

/**
 * The width Relay lays out to: the terminal, minus a column so a full-width
 * line cannot wrap, clamped to something readable. Long measures are hard to
 * read, so a 200-column terminal gets a 92-column panel rather than a 199-column
 * one.
 */
export function layoutWidth(stream: NodeJS.WriteStream = process.stdout): number {
  const columns = stream.columns ?? 80;
  return Math.max(MIN_LAYOUT_WIDTH, Math.min(MAX_LAYOUT_WIDTH, columns - 1));
}

export interface PanelOptions {
  theme: Theme;
  width: number;
  /** Shown in the top border, on the left. */
  title?: string;
  /** Shown in the top border, on the right: a count, a verdict, a duration. */
  badge?: string;
  /** Omitted for a header strip: a titled border with nothing under it. */
  body?: readonly string[];
  /** Shown under a divider, for totals or the command to run next. */
  footer?: readonly string[];
  /** Colour of the frame itself. Dim by default, so content outranks chrome. */
  accent?: ColorName;
}

/** Columns available to a panel's content at a given outer width. */
export function panelInnerWidth(width: number): number {
  return Math.max(1, width - 4);
}

/**
 * A framed block with an optional titled top border and a divided footer.
 *
 * ```
 * ╭─ System check ──────────────── 6 ok ─╮
 * │ ✓ git                        2.43.0  │
 * ├──────────────────────────────────────┤
 * │ All checks passed.                   │
 * ╰──────────────────────────────────────╯
 * ```
 */
export function panel(options: PanelOptions): string[] {
  const { theme, width, title, badge, body = [], footer } = options;
  const accent: ColorName = options.accent ?? 'gray';
  const marks = borders(theme);
  const inner = panelInnerWidth(width);

  const edge = (text: string): string => paint(theme, accent, text);
  const line = (content: string): string =>
    `${edge(marks.vertical)} ${padVisible(content, inner)} ${edge(marks.vertical)}`;

  const lines: string[] = [topBorder(theme, accent, width, title, badge)];
  for (const content of body) lines.push(line(content));

  if (footer !== undefined && footer.length > 0) {
    lines.push(edge(`${marks.teeLeft}${marks.horizontal.repeat(Math.max(0, width - 2))}${marks.teeRight}`));
    for (const content of footer) lines.push(line(content));
  }

  lines.push(edge(`${marks.bottomLeft}${marks.horizontal.repeat(Math.max(0, width - 2))}${marks.bottomRight}`));
  return lines;
}

/**
 * `╭─ Title ─────── badge ─╮`. The title and badge are clipped before the fill
 * is computed, so a long repository path shortens the label rather than pushing
 * the corner off the end of the line.
 */
function topBorder(
  theme: Theme,
  accent: ColorName,
  width: number,
  title: string | undefined,
  badge: string | undefined,
): string {
  const marks = borders(theme);
  const edge = (text: string): string => paint(theme, accent, text);

  // Two corners, the two dashes flanking them, and a space either side of each
  // label: the most a title and badge can occupy before they must be clipped.
  const overhead = 4 + (title === undefined ? 0 : 2) + (badge === undefined ? 0 : 2);
  const room = Math.max(0, width - overhead - 1);

  // `visibleWidth`, not `.length`: a painted badge carries escape bytes, and
  // counting those against the title's room silently deletes the title.
  const titleText =
    title === undefined ? '' : truncateVisible(title, Math.max(0, room - visibleWidth(badge ?? '')));
  const badgeText = badge === undefined ? '' : truncateVisible(badge, Math.max(0, room - visibleWidth(titleText)));

  const head = `${edge(marks.topLeft + marks.horizontal)}${titleText.length === 0 ? '' : ` ${paint(theme, 'bold', titleText)} `}`;
  const tail = `${badgeText.length === 0 ? '' : ` ${badgeText} `}${edge(marks.horizontal + marks.topRight)}`;
  const fill = Math.max(0, width - visibleWidth(head) - visibleWidth(tail));

  return `${head}${edge(marks.horizontal.repeat(fill))}${tail}`;
}

export interface Column {
  header: string;
  align?: 'left' | 'right';
  /** Caps the column; content longer than this is clipped, not wrapped. */
  max?: number;
}

/**
 * Aligned columns with a dim header row. Widths come from the content, so a
 * table never pads to a width nothing in it needs — the same rule `rows()` in
 * the CLI's output layer follows for key/value pairs.
 *
 * The last column is deliberately not padded: trailing spaces are invisible,
 * and they make a copied line longer than what was displayed.
 */
export function table(theme: Theme, columns: readonly Column[], data: ReadonlyArray<readonly string[]>): string[] {
  if (columns.length === 0) return [];

  const widths = columns.map((column, index) => {
    const longest = Math.max(
      visibleWidth(column.header),
      ...data.map((row) => visibleWidth(row[index] ?? '')),
      0,
    );
    return column.max === undefined ? longest : Math.min(longest, column.max);
  });

  const render = (cells: readonly string[]): string =>
    columns
      .map((column, index) => {
        const cell = cells[index] ?? '';
        // Padding the final cell would only add trailing whitespace.
        if (index === columns.length - 1) return truncateVisible(cell, widths[index] ?? 0);
        return padVisible(cell, widths[index] ?? 0, column.align ?? 'left');
      })
      .join('  ')
      .trimEnd();

  const body = data.map(render);
  // Columns with nothing to announce get no header row: the alignment is the
  // point there, and a blank dim line above it is just an empty line.
  if (columns.every((column) => column.header.length === 0)) return body;
  return [paint(theme, 'gray', render(columns.map((column) => column.header))), ...body];
}

/**
 * A proportion as a bar: `████████░░░░`. Used for rounds consumed and for how
 * far through a budget a run is — a number a reader has to compare against
 * another number, which a bar answers at a glance.
 */
export function gauge(theme: Theme, ratio: number, width: number, color: ColorName = 'cyan'): string {
  const clamped = Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0;
  const cells = Math.max(0, width);
  const filled = Math.round(clamped * cells);

  if (!theme.unicode) {
    return `[${'#'.repeat(filled)}${'-'.repeat(Math.max(0, cells - filled))}]`;
  }
  return `${paint(theme, color, '█'.repeat(filled))}${paint(theme, 'gray', '░'.repeat(Math.max(0, cells - filled)))}`;
}

/**
 * One line with content pinned to both margins — the footer of a screen, where
 * the state sits on the left and what to do about it sits on the right. Both
 * sides arrive already painted, so this is pure layout and takes no theme.
 */
export function statusBar(left: string, right: string, width: number): string {
  const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
  return `${left}${' '.repeat(gap)}${right}`;
}
