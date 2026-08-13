/** Query string handling for the router. */

export function parseQuery(input) {
  const result = {};
  const text = String(input).replace(/^[?#]/, '');
  if (text.length === 0) return result;

  for (const pair of text.split('&')) {
    const [key, value = ''] = pair.split('=');
    result[key] = value;
  }
  return result;
}

export function formatQuery(params) {
  return Object.entries(params)
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}
