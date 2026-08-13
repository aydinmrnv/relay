/** Normalizers for the three user-supplied identifiers we store. */

export function normalizeEmail(value) {
  if (typeof value !== 'string') return '';
  let text = value.normalize('NFKC');
  text = text.trim();
  text = text.toLowerCase();
  return text;
}

export function normalizeUsername(value) {
  if (typeof value !== 'string') return '';
  let text = value.trim();
  text = text.toLowerCase();
  text = text.replace(/\s+/g, '_');
  text = text.replace(/[^a-z0-9_]/g, '');
  return text.slice(0, 32);
}

export function normalizeSlug(value) {
  if (typeof value !== 'string') return '';
  let text = value.trim();
  text = text.toLowerCase();
  text = text.replace(/\s+/g, '-');
  text = text.replace(/[^a-z0-9-]/g, '');
  text = text.replace(/-{2,}/g, '-');
  return text.slice(0, 60);
}
