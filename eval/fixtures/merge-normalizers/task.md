`src/normalize.js` has three normalizers that were copied from each other and
have since drifted. Only one of them applies Unicode normalization, only one
collapses repeated separators, and none of them trims separators off the ends —
so `Ｈｅｌｌｏ` becomes an empty slug and `_ada_` stays a leading-underscore
username.

Give them one implementation, and settle the drift in favour of the behaviour
below.

**Export `normalize(value, steps)`** — returns `''` when `value` is not a
string, and otherwise pipes it through `steps`, an array of `(text) => text`
functions, in order.

**Export `NORMALIZERS`** — an object with the keys `email`, `username` and
`slug`, each holding the `steps` array for that kind.

The three existing functions stay exported and become one-liners:
`normalizeEmail(value)` is `normalize(value, NORMALIZERS.email)`, and likewise
for the others.

**The behaviour all three share**, in this order: Unicode NFKC normalization,
then trim, then lowercase.

**Then, per kind:**

| | |
|---|---|
| `email` | nothing further, and no length limit |
| `username` | runs of whitespace become `_`; every character outside `a-z`, `0-9` and `_` is dropped; runs of `_` collapse to one; leading and trailing `_` are trimmed; the result is cut to 32 characters |
| `slug` | runs of whitespace become `-`; every character outside `a-z`, `0-9` and `-` is dropped; runs of `-` collapse to one; leading and trailing `-` are trimmed; the result is cut to 60 characters |

The length cut happens last, and a value that is cut may end on a separator —
that is fine and is not trimmed again.
