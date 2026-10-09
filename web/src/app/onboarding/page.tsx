import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { connection } from 'next/server';
import { SetupWizard } from '@/components/onboarding/setup-wizard';
import { getUserId } from '@/server/auth';
import { ACCOUNTS_ENABLED, GUEST_STUDIO } from '@/server/env';

export const metadata: Metadata = { title: 'Set up your first project', robots: { index: false } };

/** Right after sign-up: connect a repository, choose where it runs and what it does, then install it there. */
export default async function OnboardingPage() {
  // Per request, so a build without the database configured cannot bake in the redirect.
  await connection();
  // A development copy without accounts keeps its work in the browser, and sets a project up the same way.
  if (!ACCOUNTS_ENABLED) {
    if (!GUEST_STUDIO) redirect('/sign-in?next=/onboarding');
    return <SetupWizard mode="first" />;
  }
  if ((await getUserId()) === null) redirect('/sign-up?next=/onboarding');
  return <SetupWizard mode="first" />;
}
