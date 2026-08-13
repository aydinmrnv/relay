/** Renders the markdown tables in generated reports. */

export function renderTable(columns, rows) {
  const headers = columns.map((column) => (typeof column === 'string' ? column : column.header));

  const widths = headers.map((header, index) =>
    Math.max(3, header.length, ...rows.map((row) => String(row[index] ?? '').length)),
  );

  const cell = (value, index) => String(value ?? '').padEnd(widths[index]);
  const line = (cells) => `| ${cells.join(' | ')} |`;

  return [
    line(headers.map(cell)),
    line(widths.map((width) => '-'.repeat(width))),
    ...rows.map((row) => line(row.map(cell))),
  ].join('\n');
}
