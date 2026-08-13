`src/pool.js` runs an array of thunks with bounded concurrency. Every caller
wraps it the same way — build an array of closures over the real inputs, call
`runPool`, throw the closures away — because the general operation it is really
doing has never been extracted.

Restructure the module around that operation, and write it with `async`/`await`
rather than nested `.then` chains.

**`mapPool(items, mapper, { concurrency = 4 } = {})`** — new, and where the work
now lives.

- Resolves to an array of results in **item order**, whatever order the mappers
  finished in.
- `mapper` is called as `mapper(item, index)`.
- Never more than `concurrency` mappers are in flight at once.
- An empty `items` resolves to `[]` without calling the mapper.
- A `concurrency` larger than `items.length` is fine.
- `concurrency` must be an integer of at least 1; anything else is a
  `RangeError`, thrown before any mapper runs.
- If any mapper rejects, **every item is still attempted** and the returned
  promise rejects with an `AggregateError` whose `errors` are in **item order** —
  not in the order the failures happened, which is what the current
  implementation reports and what makes a failing batch so hard to read.

**`runPool(tasks, concurrency = 4)`** keeps its signature and becomes a thin
wrapper: it is `mapPool` with a mapper that calls the thunk.

Both are exported.
