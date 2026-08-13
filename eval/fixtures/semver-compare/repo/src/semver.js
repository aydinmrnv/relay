/**
 * Semantic version parsing and ordering, used by the release channel to pick
 * the newest published version.
 */

const PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

/** Splits a version string into its parts, or throws if it is not one. */
export function parse(version) {
  const match = PATTERN.exec(String(version).trim());
  if (match === null) throw new TypeError(`not a semantic version: ${version}`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? '',
    build: match[5] ?? '',
  };
}

/** Orders two versions. Negative, zero or positive, for `Array#sort`. */
export function compare(a, b) {
  const left = parse(a);
  const right = parse(b);

  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  if (left.patch !== right.patch) return left.patch - right.patch;

  if (left.prerelease === right.prerelease) return 0;
  return left.prerelease < right.prerelease ? -1 : 1;
}

/** A new array, oldest version first. */
export function sort(versions) {
  return [...versions].sort(compare);
}
