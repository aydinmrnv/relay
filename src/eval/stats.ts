/**
 * The small amount of statistics an honest result needs.
 *
 * A pipeline built on model calls is stochastic, so every number this harness
 * reports is an estimate from a sample. A rate with no interval and a mean with
 * no spread are both claims the data does not support, which is why nothing
 * here returns a bare number.
 */

export interface Summary {
  n: number;
  mean: number;
  /** Sample standard deviation. Zero for n < 2, where spread is unmeasured. */
  stdDev: number;
  min: number;
  max: number;
  total: number;
}

export function summarize(values: readonly number[]): Summary {
  if (values.length === 0) return { n: 0, mean: 0, stdDev: 0, min: 0, max: 0, total: 0 };

  const total = values.reduce((sum, value) => sum + value, 0);
  const mean = total / values.length;
  const variance =
    values.length < 2
      ? 0
      : values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);

  return {
    n: values.length,
    mean,
    stdDev: Math.sqrt(variance),
    min: Math.min(...values),
    max: Math.max(...values),
    total,
  };
}

export interface Proportion {
  n: number;
  successes: number;
  rate: number;
  /** Wilson score interval, 95%. Behaves at n = 3 and at rate = 0 or 1. */
  low: number;
  high: number;
}

/** 95% two-sided normal quantile. */
const Z = 1.959963984540054;

/**
 * Wilson score interval rather than the normal approximation.
 *
 * The eval runs each task a handful of times, and the normal approximation is
 * wrong exactly there: at n = 5 with 5 successes it reports ±0, which would
 * publish "100% solve rate" as if it were established.
 */
export function proportion(successes: number, n: number): Proportion {
  if (n === 0) return { n: 0, successes: 0, rate: 0, low: 0, high: 0 };

  const rate = successes / n;
  const denominator = 1 + (Z * Z) / n;
  const centre = (rate + (Z * Z) / (2 * n)) / denominator;
  const margin = (Z * Math.sqrt((rate * (1 - rate)) / n + (Z * Z) / (4 * n * n))) / denominator;

  return {
    n,
    successes,
    rate,
    low: Math.max(0, centre - margin),
    high: Math.min(1, centre + margin),
  };
}

export function formatPercent(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

/** `65% (13/20, 95% CI 43–82%)` — the rate, the sample, and the honesty. */
export function formatProportion(value: Proportion): string {
  if (value.n === 0) return '—';
  return (
    `${formatPercent(value.rate)} (${value.successes}/${value.n}, ` +
    `95% CI ${formatPercent(value.low)}–${formatPercent(value.high)})`
  );
}

/** `4.2 ± 1.1` — a mean is not a result without the spread beside it. */
export function formatSummary(value: Summary, digits = 1): string {
  if (value.n === 0) return '—';
  if (value.n === 1) return `${value.mean.toFixed(digits)} (n=1)`;
  return `${value.mean.toFixed(digits)} ± ${value.stdDev.toFixed(digits)}`;
}

/**
 * Whether two proportions differ by more than sampling noise, judged by
 * non-overlapping Wilson intervals.
 *
 * This is deliberately conservative: non-overlapping intervals imply a
 * significant difference, but overlapping ones do not imply the absence of one.
 * A harness whose whole point is not overclaiming should err this way, and the
 * word it returns for the middle case is "inconclusive", not "no effect".
 */
export function compareProportions(a: Proportion, b: Proportion): 'a' | 'b' | 'inconclusive' {
  if (a.n === 0 || b.n === 0) return 'inconclusive';
  if (a.low > b.high) return 'a';
  if (b.low > a.high) return 'b';
  return 'inconclusive';
}
