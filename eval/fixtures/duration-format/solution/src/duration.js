/**
 * Reference solution. Never copied into a run — `relay eval --check-fixtures`
 * applies it to prove the hidden suite can be satisfied.
 */

const UNITS = [
  { suffix: 'd', ms: 86400000 },
  { suffix: 'h', ms: 3600000 },
  { suffix: 'm', ms: 60000 },
  { suffix: 's', ms: 1000 },
  { suffix: 'ms', ms: 1 },
];

const BY_SUFFIX = new Map(UNITS.map((unit) => [unit.suffix, unit.ms]));

export function formatDuration(ms, { units = 2 } = {}) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) {
    throw new TypeError(`duration must be a finite number, got ${String(ms)}`);
  }

  const sign = ms < 0 ? '-' : '';
  let rest = Math.floor(Math.abs(ms));
  const parts = [];

  for (const unit of UNITS) {
    const count = Math.floor(rest / unit.ms);
    rest -= count * unit.ms;
    // A zero component is skipped and does not use up one of the slots.
    if (count === 0) continue;
    parts.push(`${count}${unit.suffix}`);
    if (parts.length === units) break;
  }

  return parts.length === 0 ? '0ms' : `${sign}${parts.join(' ')}`;
}

export function parseDuration(text) {
  if (typeof text === 'number') {
    if (!Number.isFinite(text)) throw new TypeError(`duration must be finite, got ${text}`);
    return text;
  }
  if (typeof text !== 'string') throw new TypeError(`duration must be a string or number, got ${typeof text}`);

  const trimmed = text.trim();
  if (trimmed.length === 0) throw new TypeError('duration is empty');

  const negative = trimmed.startsWith('-');
  const body = (negative ? trimmed.slice(1) : trimmed).trim();
  const sign = negative ? -1 : 1;

  if (/^\d+$/.test(body)) return sign * Number(body);

  const tokens = body.match(/\d+\s*(?:ms|[dhms])/g) ?? [];
  // Every character has to belong to a token, or `1h x` would silently be `1h`.
  const consumed = tokens.join('').replace(/\s+/g, '');
  if (tokens.length === 0 || consumed !== body.replace(/\s+/g, '')) {
    throw new TypeError(`not a duration: ${text}`);
  }

  let total = 0;
  for (const token of tokens) {
    const match = /^(\d+)\s*(ms|[dhms])$/.exec(token.trim());
    total += Number(match[1]) * BY_SUFFIX.get(match[2]);
  }
  return sign * total;
}
