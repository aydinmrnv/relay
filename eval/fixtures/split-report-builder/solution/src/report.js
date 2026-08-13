/**
 * Reference solution. Never copied into a run — `relay eval --check-fixtures`
 * applies it to prove the hidden suite can be satisfied.
 */

export function summarize(runs) {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let totalMs = 0;
  let slowest = null;

  for (const run of runs) {
    if (run.status === 'passed') passed += 1;
    else if (run.status === 'failed') failed += 1;
    else skipped += 1;

    totalMs += run.durationMs;
    // Strictly greater, so the earliest run wins a tie.
    if (slowest === null || run.durationMs > slowest.durationMs) slowest = run;
  }

  const decided = passed + failed;
  return {
    total: runs.length,
    passed,
    failed,
    skipped,
    // Null rather than NaN: "no runs were decided" is not a rate of zero.
    passRate: decided === 0 ? null : (passed / decided) * 100,
    totalMs,
    slowest,
  };
}

export function renderReport(summary) {
  const rate = summary.passRate === null ? 'n/a' : `${summary.passRate.toFixed(1)}%`;
  const seconds = (summary.totalMs / 1000).toFixed(1);
  const slowest =
    summary.slowest === null ? 'none' : `${summary.slowest.name} (${summary.slowest.durationMs}ms)`;

  return [
    `${summary.total} runs · ${summary.passed} passed · ${summary.failed} failed · ${summary.skipped} skipped`,
    `pass rate ${rate}`,
    `total ${seconds}s · slowest ${slowest}`,
  ].join('\n');
}

export function buildReport(runs) {
  return renderReport(summarize(runs));
}
