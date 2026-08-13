`src/ranges.js` implements half-open time ranges and gets the boundaries wrong.

A range is `{ start, end }` in epoch milliseconds and covers **`[start, end)`** — the
`start` instant is inside the range and the `end` instant is not. A range with
`start >= end` is **empty** and contains no instants at all.

Booking slots that merely touch are currently reported as clashing: a meeting
that ends at 10:00 and one that starts at 10:00 do not overlap, but `overlaps()`
says they do.

Fix `overlaps`, `contains` and `intersect` so they all follow the half-open
convention consistently:

- `overlaps(a, b)` — true only when the two ranges share at least one instant.
  An empty range shares no instants with anything, including itself.
- `contains(outer, inner)` — true only when every instant of `inner` is also in
  `outer`. An empty `inner` has no instants to cover, so `contains` is false for
  it: this function answers "is this range inside that one", and an empty range
  is not a range that is anywhere.
- `intersect(a, b)` — the shared span, or `null` when there is none. It must
  never return an empty range: if the overlap has zero width the answer is
  `null`.

`isEmpty` is already correct. All three functions must be symmetric where the
maths is symmetric — `overlaps(a, b)` and `overlaps(b, a)` always agree.

Do not change the shape of the exports or the module's public names.
