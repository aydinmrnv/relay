import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { connection } from 'next/server';
import { OnboardingWizard } from '@/components/onboarding/onboarding-wizard';
import { getUserId } from '@/server/auth';
import { ACCOUNTS_ENABLED } from '@/server/env';

export const metadata: Metadata = { title: 'Set up your studio' };

/** Right after sign-up: a few questions, then a first workflow built from the answers. */
export default async function OnboardingPage() {
  // Per request, so a build without the database configured cannot bake in the redirect.
  await connection();
  if (!ACCOUNTS_ENABLED) redirect('/dashboard');
  if ((await getUserId()) === null) redirect('/sign-up?next=/onboarding');
  return <OnboardingWizard />;
}
