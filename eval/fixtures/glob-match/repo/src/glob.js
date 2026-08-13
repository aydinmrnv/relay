/** Path matching for the file filters. Paths always use `/`. */

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function matches(pattern, path) {
  const expression = new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`);
  return expression.test(path);
}
