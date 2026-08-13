/**
 * A bounded cache that keeps the hottest entries and drops the coldest.
 */
export class LruCache {
  #max;
  #entries = new Map();

  constructor(max) {
    if (!Number.isInteger(max) || max < 1) {
      throw new RangeError(`max must be a positive integer, got ${max}`);
    }
    this.#max = max;
  }

  get max() {
    return this.#max;
  }

  get size() {
    return this.#entries.size;
  }

  /** Whether the key is cached. Asking is not using. */
  has(key) {
    return this.#entries.has(key);
  }

  get(key) {
    return this.#entries.get(key);
  }

  set(key, value) {
    this.#entries.set(key, value);
    if (this.#entries.size > this.#max) {
      const coldest = this.#entries.keys().next().value;
      this.#entries.delete(coldest);
    }
    return this;
  }

  delete(key) {
    return this.#entries.delete(key);
  }

  clear() {
    this.#entries.clear();
  }

  /** Keys in eviction order: the next one to go comes first. */
  keys() {
    return [...this.#entries.keys()];
  }
}
