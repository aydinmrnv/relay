`src/wrap.js` wraps help text to the terminal width. It splits on single spaces
and nothing else, so a URL longer than the width runs off the edge, an existing
line break is treated as part of a word, and double spaces become empty "words".

Finish it. `wrap(text, width = 80, options = {})` returns an array of lines.

**Whitespace**

- Existing line breaks are boundaries and are kept: `\n`, `\r\n` and `\r` each
  end a line. A blank input line stays a blank output line — the empty string.
- Within a line, runs of spaces and tabs collapse to one space, and leading and
  trailing whitespace is dropped.
- Empty input gives `['']`, not `[]`.

**Breaking**

- Words are moved to the next line rather than split, as now.
- A word that cannot fit on a line of its own is hard-broken at exactly the
  available width, as many times as it takes. `wrap('abcdefghij', 4)` is
  `['abcd', 'efgh', 'ij']`.

**Indentation** — `options.indent` and `options.hangingIndent`

- `indent` prefixes the first output line of each input line; `hangingIndent`
  prefixes every continuation, and defaults to `indent`.
- Both count towards `width`, so the text on a line is at most
  `width - prefix.length` characters, and never fewer than 1 however wide the
  prefix is.

**Width** must be an integer of at least 1; anything else is a `RangeError`.

No output line is ever longer than `width`.

Do not change the shape of the existing export or the module's public names.
