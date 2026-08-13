/**
 * Per-key request limiting for the public API.
 *
 * The clock is a parameter rather than a global so the behaviour is testable
 * without waiting for real time to pass.
 */
export class RateLimiter {
  #limit;
  #windowMs;
  #buckets = new Map();

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

  /** How many keys are being tracked. */
  get size() {
    return this.#buckets.size;
  }

  allow(key, now = Date.now()) {
    const bucket = this.#buckets.get(key) ?? { start: now, count: 0 };
    if (now - bucket.start >= this.#windowMs) {
      bucket.start = now;
      bucket.count = 0;
    }
    bucket.count += 1;
    this.#buckets.set(key, bucket);
    return bucket.count <= this.#limit;
  }
}
