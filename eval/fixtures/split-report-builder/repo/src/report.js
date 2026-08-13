/** The three-line summary printed at the end of a batch. */

export function buildReport(runs) {
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
    if (slowest === null || run.durationMs > slowest.durationMs) slowest = run;
  }

  const passRate = ((passed / (passed + failed)) * 100).toFixed(1);
  const seconds = (totalMs / 1000).toFixed(1);

  return [
    `${runs.length} runs · ${passed} passed · ${failed} failed · ${skipped} skipped`,
    `pass rate ${passRate}%`,
    `total ${seconds}s · slowest ${slowest.name} (${slowest.durationMs}ms)`,
  ].join('\n');
}
