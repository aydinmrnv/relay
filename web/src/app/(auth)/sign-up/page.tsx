import type { Metadata } from 'next';
import { AccountsUnavailable, SignUpForm } from '@/components/auth/auth-forms';
import { ACCOUNTS_ENABLED } from '@/server/env';
import { firstParam, redirectIfSignedIn } from '../session';

export const metadata: Metadata = { title: 'Create an account' };

export default async function SignUpPage({ searchParams }: PageProps<'/sign-up'>) {
  const params = await searchParams;
  const next = firstParam(params['next']);
  if (!ACCOUNTS_ENABLED) return <AccountsUnavailable />;
  await redirectIfSignedIn(next, '/dashboard');
  return <SignUpForm next={next} />;
}
