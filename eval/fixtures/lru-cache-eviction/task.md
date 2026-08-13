`src/lru.js` calls itself an LRU cache and evicts the least *recently inserted*
entry, not the least recently *used* one.

The session store keeps the 500 hottest sessions in it. Because reading an entry
does not move it, a session that is read on every request is still evicted 500
requests after it was created, and the cache misses on exactly the keys it
exists to hold.

Make the cache actually least-recently-used:

- `get(key)` counts as a use: the entry becomes the most recent, and the next
  eviction takes something else. A `get` for a key that is not there changes
  nothing and returns `undefined`.
- `set(key, value)` counts as a use whether the key is new or already present,
  so overwriting a value refreshes it.
- `has(key)` does **not** count as a use. It is a question about the cache, not
  a read of the value.
- `delete(key)` frees a slot and returns whether anything was removed.
- The cache never holds more than `max` entries. When a `set` would exceed
  `max`, exactly one entry — the least recently used — is evicted first.
- `keys()` returns the keys in use order, least recently used first, which is
  the order they would be evicted in.

The constructor already rejects a `max` that is not a positive integer.

Do not change the shape of the exports or the class's public names.
