/**
 * Reference solution. Never copied into a run — `relay eval --check-fixtures`
 * applies it to prove the hidden suite can be satisfied.
 */
import { isAbsolute, join, normalize } from 'node:path/posix';

export class PathEscapeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PathEscapeError';
  }
}

/** `/srv/data/` and `/srv/data` are the same directory; `/` stays `/`. */
function canonical(path) {
  const normalized = normalize(path).replace(/\/+$/, '');
  return normalized.length === 0 ? '/' : normalized;
}

export function safeJoin(root, ...segments) {
  const base = canonical(root);

  for (const segment of segments) {
    if (isAbsolute(segment)) {
      throw new PathEscapeError(`absolute segment is not allowed: ${segment}`);
    }
  }

  const wanted = segments.filter((segment) => segment.length > 0);
  const resolved = canonical(join(base, ...wanted));

  if (!isInside(base, resolved)) {
    throw new PathEscapeError(`${wanted.join('/')} escapes ${base}`);
  }
  return resolved;
}

export function isInside(root, candidate) {
  const base = canonical(root);
  const target = canonical(candidate);
  if (target === base) return true;
  // The separator is the point: without it `/srv/data-old` is "inside" `/srv/data`.
  return target.startsWith(base === '/' ? '/' : `${base}/`);
}
