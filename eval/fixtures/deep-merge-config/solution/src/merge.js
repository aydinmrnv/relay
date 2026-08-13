/**
 * Reference solution. Never copied into a run — `relay eval --check-fixtures`
 * applies it to prove the hidden suite can be satisfied.
 */

const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

export function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Deep-copies plain objects and arrays; everything else rides along by reference. */
function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (!isPlainObject(value)) return value;

  const copy = {};
  for (const [key, inner] of Object.entries(value)) {
    if (FORBIDDEN.has(key)) continue;
    copy[key] = clone(inner);
  }
  return copy;
}

export function deepMerge(base, override) {
  const result = clone(base);

  for (const [key, value] of Object.entries(override)) {
    if (FORBIDDEN.has(key)) continue;
    // Absent and "explicitly nothing" are different; only null is the second.
    if (value === undefined) continue;

    const existing = Object.hasOwn(result, key) ? result[key] : undefined;
    result[key] = isPlainObject(value) && isPlainObject(existing) ? deepMerge(existing, value) : clone(value);
  }

  return result;
}
