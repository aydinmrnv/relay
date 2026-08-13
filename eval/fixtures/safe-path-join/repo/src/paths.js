import { join, normalize } from 'node:path/posix';

/** Thrown when a join would leave the directory it was confined to. */
export class PathEscapeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PathEscapeError';
  }
}

/** Joins request-supplied segments under `root`. */
export function safeJoin(root, ...segments) {
  return join(root, ...segments);
}

/** Whether `candidate` is `root` itself or something beneath it. */
export function isInside(root, candidate) {
  return normalize(candidate).startsWith(normalize(root));
}
