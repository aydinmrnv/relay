/**
 * Reference solution. Never copied into a run — `relay eval --check-fixtures`
 * applies it to prove the hidden suite can be satisfied.
 *
 * A Map iterates in insertion order, so "use" is modelled by deleting and
 * re-inserting: the used key moves to the end, and the head is always the
 * least recently used one.
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

  has(key) {
    return this.#entries.has(key);
  }

  get(key) {
    if (!this.#entries.has(key)) return undefined;
    const value = this.#entries.get(key);
    this.#entries.delete(key);
    this.#entries.set(key, value);
    return value;
  }

  set(key, value) {
    this.#entries.delete(key);
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

  keys() {
    return [...this.#entries.keys()];
  }
}
