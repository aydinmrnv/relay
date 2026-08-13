/**
 * Reference solution. Never copied into a run — `relay eval --check-fixtures`
 * applies it to prove the hidden suite can be satisfied.
 */
export class RateLimiter {
  #limit;
  #windowMs;
  /** key → ascending timestamps of the requests that were allowed. */
  #hits = new Map();

  constructor({ limit, windowMs }) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError(`limit must be a positive integer, got ${limit}`);
    }
    if (!Number.isInteger(windowMs) || windowMs < 1) {
      throw new RangeError(`windowMs must be a positive integer, got ${windowMs}`);
    }
    this.#limit = limit;
    this.#windowMs = windowMs;
  }

  get limit() {
    return this.#limit;
  }

  get windowMs() {
    return this.#windowMs;
  }

  get size() {
    return this.#hits.size;
  }

  /** Timestamps still inside the half-open window `(now - windowMs, now]`. */
  #live(key, now) {
    const hits = this.#hits.get(key);
    if (hits === undefined) return [];
    const cutoff = now - this.#windowMs;
    // Ascending order, so dropping the head is enough.
    while (hits.length > 0 && hits[0] <= cutoff) hits.shift();
    return hits;
  }

  allow(key, now = Date.now()) {
    const hits = this.#live(key, now);
    if (hits.length >= this.#limit) return false;
    hits.push(now);
    this.#hits.set(key, hits);
    return true;
  }

  remaining(key, now = Date.now()) {
    return Math.max(0, this.#limit - this.#live(key, now).length);
  }

  retryAfter(key, now = Date.now()) {
    const hits = this.#live(key, now);
    if (hits.length < this.#limit) return 0;
    return Math.max(0, hits[0] + this.#windowMs - now);
  }

  prune(now = Date.now()) {
    let dropped = 0;
    for (const key of [...this.#hits.keys()]) {
      if (this.#live(key, now).length === 0) {
        this.#hits.delete(key);
        dropped += 1;
      }
    }
    return dropped;
  }
}
