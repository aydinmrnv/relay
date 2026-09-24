import type { Metadata } from 'next';
import { connection } from 'next/server';
import { AccountsUnavailable, ClerkSignIn } from '@/components/auth/clerk-forms';
import { safeNext } from '@/lib/safe-next';
import { ACCOUNTS_ENABLED } from '@/server/env';
import { firstParam, redirectIfSignedIn } from '../../session';

export const metadata: Metadata = { title: 'Sign in' };

export default async function SignInPage({ searchParams }: PageProps<'/sign-in/[[...sign-in]]'>) {
  await connection();
  if (!ACCOUNTS_ENABLED) return <AccountsUnavailable />;
  const next = firstParam((await searchParams)['next']);
  await redirectIfSignedIn(next, '/dashboard');
  return <ClerkSignIn next={safeNext(next, '/dashboard')} />;
}
