import type { Metadata } from 'next';
import { connection } from 'next/server';
import { AccountsUnavailable, ClerkSignUp } from '@/components/auth/clerk-forms';
import { safeNext } from '@/lib/safe-next';
import { ACCOUNTS_ENABLED } from '@/server/env';
import { firstParam, redirectIfSignedIn } from '../../session';

export const metadata: Metadata = { title: 'Create an account' };

export default async function SignUpPage({ searchParams }: PageProps<'/sign-up/[[...sign-up]]'>) {
  await connection();
  if (!ACCOUNTS_ENABLED) return <AccountsUnavailable />;
  const next = firstParam((await searchParams)['next']);
  await redirectIfSignedIn(next, '/dashboard');
  return <ClerkSignUp next={safeNext(next, '/onboarding')} />;
}
