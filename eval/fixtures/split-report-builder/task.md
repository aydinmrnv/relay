`src/report.js` counts, totals, formats and renders in one loop. Nothing else can
reach the numbers — the dashboard wants the counts and gets a string — and the
one case the loop does not handle, an empty run list, crashes on
`slowest.name` rather than rendering anything.

Split it in two, and keep the rendered output identical for every input that
works today.

**`summarize(runs)`** — the numbers, and nothing about presentation:

```js
{ total, passed, failed, skipped, passRate, totalMs, slowest }
```

- `passed` and `failed` count the runs whose `status` is exactly `'passed'` and
  `'failed'`; **every other status counts as `skipped`**, which is what the
  current `else` branch does.
- `totalMs` is the sum of `durationMs`.
- `passRate` is `passed / (passed + failed) * 100` as an unrounded number, or
  `null` when no run either passed or failed.
- `slowest` is the run with the greatest `durationMs` — the **same object**, not
  a copy — with the earliest one winning a tie. It is `null` when there are no
  runs.
- `runs` is not mutated.

**`renderReport(summary)`** — the three lines, joined with `\n`, no trailing
newline:

```
3 runs · 2 passed · 1 failed · 0 skipped
pass rate 66.7%
total 1.5s · slowest build (900ms)
```

- The pass rate is shown to one decimal place, and is `pass rate n/a` when
  `passRate` is `null`.
- The total is seconds to one decimal place.
- With no slowest run the third line ends `slowest none`.

**`buildReport(runs)`** stays exported and becomes
`renderReport(summarize(runs))`.

All three are exported.
