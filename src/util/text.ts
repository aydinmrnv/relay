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

/**
 * Reduces arbitrary text to something safe as both a path component and a git
 * ref component: lowercase, no spaces, no `..`, and no leading or trailing
 * punctuation. Empty input — or input with nothing left after stripping — falls
 * back rather than producing a nameless directory or a bare `relay/`.
 */
export function slugify(value: string, fallback: string, maxLength = 40): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .slice(0, maxLength)
    .replace(/^[-.]+|[-.]+$/g, '');
  return slug.length > 0 ? slug : fallback;
}

export function indent(text: string, prefix = '  '): string {
  return text
    .split('\n')
    .map((line) => (line.length > 0 ? prefix + line : line))
    .join('\n');
}

/** Edits (insert, delete, substitute) that turn `a` into `b`. */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, substitution);
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/**
 * The candidate a mistyped word most plausibly meant, or undefined when none
 * is close enough to be worth suggesting.
 *
 * Case is ignored, because `maxCostUSD` for `maxCostUsd` is the commonest
 * mistake there is. The cut-off scales with the word: two edits in a long key
 * is a typo, two edits in `run` is a different word — and a suggestion that is
 * wrong is worse than none, since it reads as an instruction.
 */
export function closestMatch(word: string, candidates: readonly string[]): string | undefined {
  const typed = word.toLowerCase();
  const limit = Math.max(1, Math.floor(typed.length / 3));
  let best: { candidate: string; distance: number } | undefined;
  for (const candidate of candidates) {
    const distance = editDistance(typed, candidate.toLowerCase());
    if (distance <= limit && (best === undefined || distance < best.distance)) best = { candidate, distance };
  }
  return best?.candidate;
}

/**
 * `412ms`, `21.0s`, `1m 4s`, `1h 20m`.
 *
 * Each unit is chosen from the value *as it will be printed*, not from the raw
 * one. Rounding after the unit is picked is how 59.96 seconds became `60.0s`
 * and 119.6 seconds became `1m 60s`: the remainder rounded up into a number its
 * own unit cannot hold. Rounding first carries it into the next unit instead.
 */
export function formatDuration(ms: number): string {
  const whole = Math.round(ms);
  if (whole < 1000) return `${whole}ms`;
  const tenths = Math.round(ms / 100);
  if (tenths < 600) return `${(tenths / 10).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
