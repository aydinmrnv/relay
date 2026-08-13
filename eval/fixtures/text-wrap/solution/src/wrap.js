/**
 * Reference solution. Never copied into a run — `relay eval --check-fixtures`
 * applies it to prove the hidden suite can be satisfied.
 */

export function wrap(text, width = 80, options = {}) {
  if (!Number.isInteger(width) || width < 1) {
    throw new RangeError(`width must be a positive integer, got ${width}`);
  }

  const indent = options.indent ?? '';
  const hangingIndent = options.hangingIndent ?? indent;
  const lines = [];

  for (const paragraph of String(text).split(/\r\n|\r|\n/)) {
    const words = paragraph
      .replace(/[\t ]+/g, ' ')
      .trim()
      .split(' ')
      .filter((word) => word.length > 0);

    if (words.length === 0) {
      lines.push('');
      continue;
    }

    let prefix = indent;
    let current = '';
    const flush = () => {
      lines.push(prefix + current);
      prefix = hangingIndent;
      current = '';
    };

    const queue = [...words];
    while (queue.length > 0) {
      // At least one column of text, however wide the prefix is.
      const room = Math.max(1, width - prefix.length);
      const word = queue.shift();

      if (word.length > room) {
        // Finish the line in progress first; the long word starts a fresh one.
        if (current.length > 0) {
          queue.unshift(word);
          flush();
          continue;
        }
        current = word.slice(0, room);
        queue.unshift(word.slice(room));
        flush();
        continue;
      }

      if (current.length === 0) current = word;
      else if (current.length + 1 + word.length <= room) current += ` ${word}`;
      else {
        queue.unshift(word);
        flush();
      }
    }

    if (current.length > 0) flush();
  }

  return lines;
}
