import type { Metadata } from 'next';
import Link from 'next/link';
import { connection } from 'next/server';
import { AccountsUnavailable, ForgotPasswordForm } from '@/components/auth/auth-forms';
import { ACCOUNTS_ENABLED, EMAIL_ENABLED } from '@/server/env';

export const metadata: Metadata = { title: 'Reset your password' };

export default async function ForgotPasswordPage() {
  await connection();
  if (!ACCOUNTS_ENABLED) return <AccountsUnavailable />;
  if (!EMAIL_ENABLED) {
    return (
      <div className="flex flex-col gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Password reset is not set up here</h1>
        <p className="text-sm text-muted-foreground">This server cannot send email yet, so it cannot send a reset link. If you signed up with GitHub, sign in with GitHub instead.</p>
        <Link href="/sign-in" className="text-sm font-medium underline-offset-4 hover:underline">
          Back to sign in
        </Link>
      </div>
    );
  }
  return <ForgotPasswordForm />;
}
