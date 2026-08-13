/**
 * Reference solution. Never copied into a run — `relay eval --check-fixtures`
 * applies it to prove the hidden suite can be satisfied.
 */

export async function mapPool(items, mapper, { concurrency = 4 } = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError(`concurrency must be a positive integer, got ${concurrency}`);
  }
  if (items.length === 0) return [];

  const results = new Array(items.length);
  // Sparse by index rather than appended, so the order of failures is the order
  // of the items and not the order the clock happened to produce them in.
  const failures = new Array(items.length);
  let failed = false;
  let next = 0;

  const worker = async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;

      try {
        results[index] = await mapper(items[index], index);
      } catch (error) {
        failures[index] = error;
        failed = true;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));

  if (failed) {
    throw new AggregateError(
      failures.filter((_, index) => index in failures && failures[index] !== undefined),
      'one or more tasks failed',
    );
  }
  return results;
}

export function runPool(tasks, concurrency = 4) {
  return mapPool(tasks, (task) => task(), { concurrency });
}
