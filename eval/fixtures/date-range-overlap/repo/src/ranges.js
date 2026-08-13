/**
 * Half-open time ranges.
 *
 * A range is `{ start, end }` in epoch milliseconds and covers `[start, end)`:
 * the start instant is inside it, the end instant is not.
 */

/** A range with no instants in it. */
export function isEmpty(range) {
  return range.start >= range.end;
}

/** True when the two ranges share at least one instant. */
export function overlaps(a, b) {
  return a.start <= b.end && b.start <= a.end;
}

/** True when every instant of `inner` is also in `outer`. */
export function contains(outer, inner) {
  return outer.start <= inner.start && inner.end <= outer.end;
}

/** The span the two ranges share, or null when they share none. */
export function intersect(a, b) {
  if (!overlaps(a, b)) return null;
  return { start: Math.max(a.start, b.start), end: Math.min(a.end, b.end) };
}
