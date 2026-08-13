/**
 * Reference solution. Never copied into a run — `relay eval --check-fixtures`
 * applies it to prove the hidden suite can be satisfied.
 */

const MIN_WIDTH = 3;

/** Escaping happens before measuring, so the padded text is the rendered text. */
function escapeCell(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\|/g, '\\|').replace(/\r\n|\r|\n/g, '<br>');
}

function pad(text, width, align) {
  const room = Math.max(0, width - text.length);
  if (align === 'right') return ' '.repeat(room) + text;
  if (align === 'center') {
    const left = Math.floor(room / 2);
    return ' '.repeat(left) + text + ' '.repeat(room - left);
  }
  return text + ' '.repeat(room);
}

function marker(width, align) {
  if (align === 'left') return `:${'-'.repeat(width - 1)}`;
  if (align === 'right') return `${'-'.repeat(width - 1)}:`;
  if (align === 'center') return `:${'-'.repeat(width - 2)}:`;
  return '-'.repeat(width);
}

export function renderTable(columns, rows) {
  if (columns.length === 0) return '';

  const specs = columns.map((column) =>
    typeof column === 'string' ? { header: column, align: undefined } : { header: column.header, align: column.align },
  );

  const cells = rows.map((row) => specs.map((_, index) => escapeCell(row[index])));
  const headers = specs.map((spec) => escapeCell(spec.header));

  const widths = specs.map((_, index) =>
    Math.max(MIN_WIDTH, headers[index].length, ...cells.map((row) => row[index].length)),
  );

  const line = (values) =>
    `| ${values.map((value, index) => pad(value, widths[index], specs[index].align)).join(' | ')} |`;

  return [
    line(headers),
    `| ${widths.map((width, index) => marker(width, specs[index].align)).join(' | ')} |`,
    ...cells.map(line),
  ].join('\n');
}
