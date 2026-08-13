/**
 * Reference solution. Never copied into a run — `relay eval --check-fixtures`
 * applies it to prove the hidden suite can be satisfied.
 */

const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

/** `+` first, then percent-escapes, so `%2B` survives as a literal plus. */
function decode(text) {
  const spaced = text.replace(/\+/g, ' ');
  try {
    return decodeURIComponent(spaced);
  } catch {
    return spaced;
  }
}

export function parseQuery(input) {
  const result = {};
  const text = String(input).replace(/^[?#]/, '');
  if (text.length === 0) return result;

  for (const pair of text.split('&')) {
    if (pair.length === 0) continue;

    const separator = pair.indexOf('=');
    const rawKey = separator === -1 ? pair : pair.slice(0, separator);
    const rawValue = separator === -1 ? '' : pair.slice(separator + 1);

    let key = decode(rawKey);
    const alwaysArray = key.endsWith('[]');
    if (alwaysArray) key = key.slice(0, -2);
    if (key.length === 0 || FORBIDDEN.has(key)) continue;

    const value = decode(rawValue);
    // `Object.hasOwn`, not `result[key] === undefined`: `toString` is a real
    // key a query string can carry, and it is inherited on every object.
    const existing = Object.hasOwn(result, key) ? result[key] : undefined;

    if (existing === undefined) result[key] = alwaysArray ? [value] : value;
    else if (Array.isArray(existing)) existing.push(value);
    else result[key] = [existing, value];
  }

  return result;
}

export function formatQuery(params) {
  const parts = [];

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    const encodedKey = encodeURIComponent(key);

    if (Array.isArray(value)) {
      for (const item of value) parts.push(`${encodedKey}[]=${encodeURIComponent(item)}`);
      continue;
    }
    parts.push(`${encodedKey}=${value === null ? '' : encodeURIComponent(value)}`);
  }

  return parts.join('&');
}
