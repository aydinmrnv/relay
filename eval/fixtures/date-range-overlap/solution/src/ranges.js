/**
 * Reference solution. Never copied into a run — `relay eval --check-fixtures`
 * applies it to prove the hidden suite can be satisfied.
 */

/** A range with no instants in it. */
export function isEmpty(range) {
  return range.start >= range.end;
}

/** True when the two ranges share at least one instant. */
export function overlaps(a, b) {
  if (isEmpty(a) || isEmpty(b)) return false;
  return a.start < b.end && b.start < a.end;
}

/** True when every instant of `inner` is also in `outer`. */
export function contains(outer, inner) {
  if (isEmpty(inner)) return false;
  return outer.start <= inner.start && inner.end <= outer.end;
}

/** The span the two ranges share, or null when they share none. */
export function intersect(a, b) {
  if (!overlaps(a, b)) return null;
  return { start: Math.max(a.start, b.start), end: Math.min(a.end, b.end) };
}
