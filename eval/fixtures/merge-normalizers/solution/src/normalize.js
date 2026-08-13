/**
 * Reference solution. Never copied into a run — `relay eval --check-fixtures`
 * applies it to prove the hidden suite can be satisfied.
 */

const unicode = (text) => text.normalize('NFKC');
const trim = (text) => text.trim();
const lower = (text) => text.toLowerCase();

const shared = [unicode, trim, lower];

/** The same three steps for any separator, which is all the copies differed in. */
function separated(separator, allowed, limit) {
  const escaped = separator === '-' ? '\\-' : separator;
  return [
    ...shared,
    (text) => text.replace(/\s+/g, separator),
    (text) => text.replace(new RegExp(`[^${allowed}]`, 'g'), ''),
    (text) => text.replace(new RegExp(`${escaped}{2,}`, 'g'), separator),
    (text) => text.replace(new RegExp(`^${escaped}+|${escaped}+$`, 'g'), ''),
    (text) => text.slice(0, limit),
  ];
}

export const NORMALIZERS = {
  email: [...shared],
  username: separated('_', 'a-z0-9_', 32),
  slug: separated('-', 'a-z0-9\\-', 60),
};

export function normalize(value, steps) {
  if (typeof value !== 'string') return '';
  return steps.reduce((text, step) => step(text), value);
}

export function normalizeEmail(value) {
  return normalize(value, NORMALIZERS.email);
}

export function normalizeUsername(value) {
  return normalize(value, NORMALIZERS.username);
}

export function normalizeSlug(value) {
  return normalize(value, NORMALIZERS.slug);
}
