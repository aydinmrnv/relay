/**
 * Reference solution. Never copied into a run — `relay eval --check-fixtures`
 * applies it to prove the hidden suite can be satisfied.
 */

function escapeChar(char) {
  return char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Compiles a glob into an anchored regular expression, one token at a time. */
function compile(pattern) {
  let source = '';
  let index = 0;

  while (index < pattern.length) {
    const char = pattern[index];

    if (char === '*') {
      if (pattern[index + 1] === '*') {
        // `**/` spans whole segments, and none is a legal number of them.
        if (pattern[index + 2] === '/') {
          source += '(?:[^/]*\\/)*';
          index += 3;
          continue;
        }
        source += '.*';
        index += 2;
        continue;
      }
      source += '[^/]*';
      index += 1;
      continue;
    }

    if (char === '?') {
      source += '[^/]';
      index += 1;
      continue;
    }

    if (char === '[') {
      const close = pattern.indexOf(']', index + 1);
      if (close === -1) {
        source += '\\[';
        index += 1;
        continue;
      }
      let body = pattern.slice(index + 1, close);
      let negated = false;
      if (body.startsWith('!') || body.startsWith('^')) {
        negated = true;
        body = body.slice(1);
      }
      source += `[${negated ? '^' : ''}${body.replace(/\\/g, '\\\\').replace(/\]/g, '\\]')}]`;
      index = close + 1;
      continue;
    }

    source += escapeChar(char);
    index += 1;
  }

  return new RegExp(`^${source}$`);
}

export function matches(pattern, path) {
  return compile(pattern).test(path);
}

export function matchesAny(patterns, path) {
  let included = false;
  for (const pattern of patterns) {
    if (pattern.startsWith('!')) {
      // An exclusion wins outright, so its position in the list cannot matter.
      if (matches(pattern.slice(1), path)) return false;
    } else if (matches(pattern, path)) {
      included = true;
    }
  }
  return included;
}
