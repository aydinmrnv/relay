'use client';

import { createAuthClient } from 'better-auth/react';

/** Better Auth's browser client, pointed at this site's `/api/auth`. */
export const authClient = createAuthClient();

/** Better Auth answers failures as `{ code, message }`; this turns one into a sentence for a form. */
export function authErrorMessage(error: { code?: string | undefined; message?: string | undefined; status?: number } | null | undefined, fallback = 'Something went wrong. Try again.'): string {
  if (error === null || error === undefined) return fallback;
  switch (error.code) {
    case 'INVALID_EMAIL_OR_PASSWORD':
      return 'That email and password do not match an account.';
    case 'USER_ALREADY_EXISTS':
    case 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL':
      return 'An account with this email already exists. Sign in instead, or reset the password.';
    case 'PASSWORD_TOO_SHORT':
      return 'Use at least 8 characters.';
    case 'PASSWORD_TOO_LONG':
      return 'Use at most 128 characters.';
    case 'INVALID_EMAIL':
      return 'That does not look like an email address.';
    case 'INVALID_PASSWORD':
      return 'That password is not right.';
    case 'INVALID_TOKEN':
      return 'This link has expired or was already used. Ask for a new one.';
    case 'ACCOUNTS_DISABLED':
      return 'Accounts are not enabled on this server. You can still use the studio without one.';
    default:
      break;
  }
  if (error.status === 429) return 'Too many attempts. Wait a minute and try again.';
  return error.message !== undefined && error.message.length > 0 ? error.message : fallback;
}
