/** Only same-site paths, so `?next=` cannot send someone to another site after signing in. */
export function safeNext(value: string | null | undefined, fallback: string): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return fallback;
  return value;
}
