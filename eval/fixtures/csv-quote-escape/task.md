`src/csv.js` writes CSV that other tools cannot read back.

An export containing a value like `He said "no"` currently comes out as
`He said "no"`, which shifts every following column when the file is parsed. A
value containing a newline breaks the row in half.

Make `formatValue`, `formatRow` and `formatCsv` follow RFC 4180:

- A field is quoted when it contains a comma, a double quote, a carriage return
  or a line feed. Otherwise it is written bare.
- Inside a quoted field, each double quote is doubled.
- Leading or trailing whitespace is significant, so a field with either must be
  quoted — otherwise readers that trim will silently change the value.
- `null` and `undefined` are written as an empty field, unquoted.
- Rows are joined with CRLF (`\r\n`), which is what the format specifies.
  `formatCsv` does not add a trailing line break.

The reader in `parseCsv` is already correct and must keep working: for every
row, `parseCsv(formatCsv(rows))` must return exactly the values that went in,
with numbers and other non-strings coming back as their string form.

Do not change the shape of the exports or the module's public names.
