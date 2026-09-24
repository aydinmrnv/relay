import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getSessionUser } from '@/server/auth';
import { safeNext } from '@/lib/safe-next';

/** Someone already signed in has no business on a sign-in form: send them on. */
export async function redirectIfSignedIn(next: string | null, fallback: string): Promise<void> {
  const user = await getSessionUser(await headers());
  if (user !== null) redirect(safeNext(next, fallback));
}

export function firstParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}
