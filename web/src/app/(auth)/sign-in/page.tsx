import type { Metadata } from 'next';
import { AccountsUnavailable, SignInForm } from '@/components/auth/auth-forms';
import { ACCOUNTS_ENABLED } from '@/server/env';
import { firstParam, redirectIfSignedIn } from '../session';

export const metadata: Metadata = { title: 'Sign in' };

const ERRORS: Record<string, string> = {
  github: 'GitHub sign-in did not finish. Try again, or use your email and password.',
  account_not_linked: 'This email already has an account. Sign in with your password, then link GitHub from Settings.',
  access_denied: 'GitHub sign-in was cancelled.',
};

export default async function SignInPage({ searchParams }: PageProps<'/sign-in'>) {
  const params = await searchParams;
  const next = firstParam(params['next']);
  if (!ACCOUNTS_ENABLED) return <AccountsUnavailable />;
  await redirectIfSignedIn(next, '/dashboard');
  const error = firstParam(params['error']);
  return <SignInForm next={next} initialError={error === null ? null : (ERRORS[error] ?? 'Sign-in did not finish. Try again.')} />;
}
