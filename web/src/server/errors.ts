/**
 * An error a route answers with: an HTTP status, a code the studio can act
 * on, and a sentence it can show. Kept apart from `api.ts`, which needs
 * Clerk and the database, so modules that only throw one can be tested on
 * their own.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** Extra fields for the client, e.g. the server's copy on a conflict. */
  readonly data?: Record<string, unknown>;

  constructor(status: number, code: string, message: string, data?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.data = data;
  }
}
