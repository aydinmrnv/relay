/**
 * Retry with exponential backoff.
 *
 * Callers mark an error `retryable: false` when trying again cannot possibly
 * help — a bad credential, a missing binary, a rejected argument.
 */

export const DEFAULTS = { attempts: 3, baseMs: 100, maxMs: 2000, factor: 2 };

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** How long to wait before the retry that follows attempt `index`. */
export function delayFor(index, options = {}) {
  const { baseMs, maxMs, factor } = { ...DEFAULTS, ...options };
  return Math.min(baseMs * factor ** index, maxMs);
}

/** Runs `operation`, retrying transient failures with backoff. */
export async function retry(operation, options = {}) {
  const settings = { ...DEFAULTS, ...options };
  const sleep = settings.sleep ?? defaultSleep;

  let lastError;
  for (let attempt = 0; attempt <= settings.attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      await sleep(delayFor(attempt, settings));
    }
  }
  throw lastError;
}
