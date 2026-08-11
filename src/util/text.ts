/** Collapses whitespace and clips to `max` characters for single-line display. */
export function oneLine(text: string, max = 120): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Clips large captured output, keeping the head and tail. Test failures and
 * stack traces live at the end, so a tail-only or head-only clip loses the
 * part the user actually needs.
 */
export function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor((maxChars - 80) / 2);
  if (half <= 0) return text.slice(0, maxChars);
  const omitted = text.length - half * 2;
  return `${text.slice(0, half)}\n\n… [${omitted} characters omitted by relay] …\n\n${text.slice(-half)}`;
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function indent(text: string, prefix = '  '): string {
  return text
    .split('\n')
    .map((line) => (line.length > 0 ? prefix + line : line))
    .join('\n');
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  if (minutes < 60) return `${minutes}m ${rest}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
