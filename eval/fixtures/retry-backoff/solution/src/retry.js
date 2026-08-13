/**
 * Reference solution. Never copied into a run — `relay eval --check-fixtures`
 * applies it to prove the hidden suite can be satisfied.
 */

export const DEFAULTS = { attempts: 3, baseMs: 100, maxMs: 2000, factor: 2 };

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function delayFor(index, options = {}) {
  const { baseMs, maxMs, factor } = { ...DEFAULTS, ...options };
  return Math.min(baseMs * factor ** index, maxMs);
}

export async function retry(operation, options = {}) {
  const settings = { ...DEFAULTS, ...options };
  const sleep = settings.sleep ?? defaultSleep;

  let lastError;
  for (let attempt = 0; attempt < settings.attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      // Retrying something that cannot succeed only spends time to reach the
      // same error, so it is rethrown as it is, without a further sleep.
      if (error !== null && typeof error === 'object' && error.retryable === false) throw error;
      // Sleeps go between attempts: after the last one there is nothing to wait for.
      if (attempt < settings.attempts - 1) await sleep(delayFor(attempt, settings));
    }
  }
  throw lastError;
}
