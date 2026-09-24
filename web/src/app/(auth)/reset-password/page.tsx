import type { Metadata } from 'next';
import { connection } from 'next/server';
import { AccountsUnavailable, ResetPasswordForm } from '@/components/auth/auth-forms';
import { ACCOUNTS_ENABLED } from '@/server/env';
import { firstParam } from '../session';

export const metadata: Metadata = { title: 'Choose a new password' };

export default async function ResetPasswordPage({ searchParams }: PageProps<'/reset-password'>) {
  await connection();
  if (!ACCOUNTS_ENABLED) return <AccountsUnavailable />;
  const params = await searchParams;
  const error = firstParam(params['error']);
  return <ResetPasswordForm token={firstParam(params['token'])} initialError={error === null ? null : 'This link has expired or was already used. Ask for a new one.'} />;
}
