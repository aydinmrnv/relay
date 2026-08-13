`src/table.js` renders the markdown tables in generated reports. It pads columns
correctly and does nothing else: a cell containing a `|` splits the row, a row
with a missing trailing cell renders a short row that no reader will parse, and
there is no way to right-align a column of numbers.

Extend `renderTable(columns, rows)`.

**Columns.** An entry may be a string (the header, with no declared alignment)
or `{ header, align }` where `align` is `'left'`, `'right'` or `'center'`.

**The separator row** encodes the alignment, filling the column's width:

| align | width 3 | width 6 |
|---|---|---|
| *(none)* | `---` | `------` |
| `left` | `:--` | `:-----` |
| `right` | `--:` | `-----:` |
| `center` | `:-:` | `:----:` |

**Cells.**

- `null` and `undefined` render as an empty cell; everything else is `String(value)`.
- A `|` in a cell or a header becomes `\|`. A line break becomes `<br>`. Both
  happen before the width is measured, so the escaped text is what gets padded.
- Column width is the widest escaped cell or header, and never less than 3.
- Content is padded to the column width according to the alignment: `left` and
  *(none)* pad on the right, `right` pads on the left, and `center` splits the
  padding with the extra space going on the right when it does not divide evenly.
  Headers are aligned the same way as their column.

**Rows.**

- A row with fewer cells than there are columns is padded with empty cells.
- A row with more cells than there are columns has the extras dropped.
- With no rows, the header and separator are still rendered.
- With no columns the result is the empty string.

Rows are joined with `\n` and there is no trailing newline.

Do not change the shape of the export or the module's public names.
