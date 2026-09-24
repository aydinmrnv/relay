import { redirect } from 'next/navigation';
import { getUserId } from '@/server/auth';
import { safeNext } from '@/lib/safe-next';

/** Someone already signed in has no business on a sign-in form: send them on. */
export async function redirectIfSignedIn(next: string | null, fallback: string): Promise<void> {
  let signedIn = false;
  try {
    signedIn = (await getUserId()) !== null;
  } catch (error) {
    // Show the form; Clerk will report the problem properly.
    console.error('[auth] could not check the session', error);
  }
  if (signedIn) redirect(safeNext(next, fallback));
}

export function firstParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}
