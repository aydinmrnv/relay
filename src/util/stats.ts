/**
 * The two order statistics Relay reports about its own runs.
 *
 * Nearest-rank rather than interpolated, and median rather than mean, so every
 * number Relay prints is a number some run actually produced: "half the runs
 * came in under this" is a claim a user can check against `relay status`,
 * where "$1.37" averaged out of a sample of four is not.
 */
export function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.ceil(fraction * sorted.length);
  const index = Math.min(sorted.length, Math.max(1, rank)) - 1;
  return sorted[index]!;
}

export function median(values: readonly number[]): number {
  return percentile(values, 0.5);
}
