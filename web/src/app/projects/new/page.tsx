import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { connection } from 'next/server';
import { SetupWizard } from '@/components/onboarding/setup-wizard';
import { getUserId } from '@/server/auth';
import { ACCOUNTS_ENABLED, GUEST_STUDIO } from '@/server/env';

export const metadata: Metadata = { title: 'Add a project', robots: { index: false } };

/**
 * The same questions as onboarding, for another repository. Outside the
 * studio's frame on purpose: setup is one thing at a time, with no sidebar to
 * wander off into.
 */
export default async function NewProjectPage() {
  await connection();
  if (!ACCOUNTS_ENABLED) {
    if (!GUEST_STUDIO) redirect('/sign-in?next=/projects/new');
    return <SetupWizard mode="add" />;
  }
  if ((await getUserId()) === null) redirect('/sign-in?next=/projects/new');
  return <SetupWizard mode="add" />;
}
