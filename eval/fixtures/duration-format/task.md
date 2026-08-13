`src/duration.js` formats milliseconds for the run report. It handles seconds and
minutes and nothing else: a four-hour run reads as `247m 12s`, and a 300ms one
reads as `0s`.

**`formatDuration(ms, { units = 2 } = {})`**

- Units are `d`, `h`, `m`, `s`, `ms`, largest first.
- At most `units` components are shown, and only non-zero ones. A zero component
  in the middle is skipped and does not use up a slot: `3605000` with the
  default `units` is `1h 5s`, not `1h 0m`.
- Anything below the last shown component is **truncated, never rounded**, so a
  duration never displays as longer than it is. `1999` with `units: 1` is `1s`.
- Components are joined with a single space: `1d 4h`.
- Zero is `0ms`.
- A negative duration is formatted by magnitude with a leading `-`: `-1m 5s`.
- A value that is not a finite number throws `TypeError`.

**`parseDuration(text)`** — new — reads back anything `formatDuration` writes.

- Accepts the same `<number><unit>` components separated by whitespace, in any
  order of appearance, and sums them: `1h 30m` is `5400000`.
- Accepts a bare integer as milliseconds: `1500` is `1500`.
- Accepts a leading `-`.
- Tolerates surrounding whitespace and whitespace between the number and its
  unit.
- Throws `TypeError` on anything else, including `''`, `'soon'` and `'1x'`.
- Also accepts a finite number, which it returns unchanged.

`parseDuration(formatDuration(ms, { units: 5 }))` must equal `Math.trunc(ms)` for
every finite `ms`.

Do not change the shape of the existing export or the module's public names.
