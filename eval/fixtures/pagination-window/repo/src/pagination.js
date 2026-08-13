/** Pager metadata for the list endpoints. */

function assertInteger(value, name, min) {
  if (!Number.isInteger(value) || value < min) {
    throw new RangeError(`${name} must be an integer of at least ${min}, got ${value}`);
  }
}

export function paginate({ total, page, perPage }) {
  assertInteger(total, 'total', 0);
  assertInteger(page, 'page', 1);
  assertInteger(perPage, 'perPage', 1);

  const pageCount = Math.floor(total / perPage) + 1;
  const current = page;
  const offset = current * perPage;

  return {
    page: current,
    perPage,
    total,
    pageCount,
    offset,
    limit: perPage,
    hasPrevious: current > 1,
    hasNext: current < pageCount,
  };
}

/** The consecutive page numbers the pager draws around the current one. */
export function pageNumbers(page, pageCount, window = 5) {
  const half = Math.floor(window / 2);
  const start = Math.max(1, page - half);
  const end = Math.min(pageCount, start + window - 1);

  const numbers = [];
  for (let number = start; number <= end; number += 1) numbers.push(number);
  return numbers;
}
