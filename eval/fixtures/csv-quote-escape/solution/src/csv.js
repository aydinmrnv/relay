/**
 * Reference solution. Never copied into a run — `relay eval --check-fixtures`
 * applies it to prove the hidden suite can be satisfied.
 */

const DELIMITER = ',';
const NEEDS_QUOTING = /[",\r\n]/;

export function formatValue(value) {
  const text = value === null || value === undefined ? '' : String(value);
  if (text.length === 0) return '';
  // Trimmable whitespace is significant and readers strip it, so quote it too.
  const padded = text !== text.trim();
  if (NEEDS_QUOTING.test(text) || padded) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function formatRow(values) {
  return values.map(formatValue).join(DELIMITER);
}

export function formatCsv(rows) {
  return rows.map(formatRow).join('\r\n');
}

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let open = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
        continue;
      }
      if (char === '"') {
        quoted = false;
        continue;
      }
      field += char;
      continue;
    }

    if (char === '"' && field === '') {
      quoted = true;
      open = true;
      continue;
    }
    if (char === DELIMITER) {
      row.push(field);
      field = '';
      open = true;
      continue;
    }
    if (char === '\r' || char === '\n') {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
      open = false;
      continue;
    }

    field += char;
    open = true;
  }

  if (open || field.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
