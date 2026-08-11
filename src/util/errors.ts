/**
 * Relay's error type. Every failure that a user can plausibly act on should be
 * a RelayError with a `hint` describing the next step.
 */
export class RelayError extends Error {
  readonly code: string;
  readonly hint: string | undefined;
  override readonly cause: unknown;

  constructor(message: string, options: { code?: string; hint?: string; cause?: unknown } = {}) {
    super(message);
    this.name = 'RelayError';
    this.code = options.code ?? 'RELAY_ERROR';
    this.hint = options.hint;
    this.cause = options.cause;
  }
}

export function isRelayError(value: unknown): value is RelayError {
  return value instanceof RelayError;
}

/** Normalizes anything thrown into a readable single-line message. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
