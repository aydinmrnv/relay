/** Wraps help text to the terminal width. */

export function wrap(text, width = 80) {
  const words = String(text).split(' ');
  const lines = [];
  let current = '';

  for (const word of words) {
    if (current.length === 0) current = word;
    else if (current.length + 1 + word.length <= width) current += ` ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }

  if (current.length > 0) lines.push(current);
  return lines;
}
