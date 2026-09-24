/**
 * Only same-site paths, so `?next=` cannot send someone to another site after
 * signing in. Browsers drop tabs and newlines from URLs and treat a backslash
 * like a slash, so `/\t/evil.example` would become `//evil.example`: control
 * characters and backslashes are refused outright, and what is left must
 * resolve to this origin.
 */
export function safeNext(value: string | null | undefined, fallback: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return fallback;
  if (/[\u0000-\u001f\u007f\\]/.test(value) || !value.startsWith('/') || value.startsWith('//')) return fallback;
  try {
    const base = 'http://relay.invalid';
    const url = new URL(value, base);
    return url.origin === base ? `${url.pathname}${url.search}${url.hash}` : fallback;
  } catch {
    return fallback;
  }
}
