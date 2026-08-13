/**
 * Reference solution. Never copied into a run — `relay eval --check-fixtures`
 * applies it to prove the hidden suite can be satisfied.
 */

function assertInteger(value, name, min) {
  if (!Number.isInteger(value) || value < min) {
    throw new RangeError(`${name} must be an integer of at least ${min}, got ${value}`);
  }
}

export function paginate({ total, page, perPage }) {
  assertInteger(total, 'total', 0);
  assertInteger(page, 'page', 1);
  assertInteger(perPage, 'perPage', 1);

  // An empty collection still has one page, and it is empty.
  const pageCount = Math.max(1, Math.ceil(total / perPage));
  const current = Math.min(page, pageCount);
  const offset = (current - 1) * perPage;

  return {
    page: current,
    perPage,
    total,
    pageCount,
    offset,
    limit: Math.max(0, Math.min(perPage, total - offset)),
    hasPrevious: current > 1,
    hasNext: current < pageCount,
  };
}

export function pageNumbers(page, pageCount, window = 5) {
  const size = Math.min(window, pageCount);
  // An even window has one more number after the current page than before it.
  const before = Math.floor((window - 1) / 2);
  const start = Math.min(Math.max(1, page - before), Math.max(1, pageCount - size + 1));

  const numbers = [];
  for (let offset = 0; offset < size; offset += 1) numbers.push(start + offset);
  return numbers;
}
