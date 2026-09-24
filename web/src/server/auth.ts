/**
 * Who is asking, from Clerk. Sign-up, sign-in, sessions, passwords, social
 * sign-in, email verification and bot protection are all Clerk's; the
 * studio's own database only ever sees a Clerk user id.
 */
import { auth, clerkClient, currentUser } from '@clerk/nextjs/server';
import { ACCOUNTS_ENABLED } from './env';

/** The signed-in user's id, or `null`. Verifies the session token locally: no network call. */
export async function getUserId(): Promise<string | null> {
  if (!ACCOUNTS_ENABLED) return null;
  const { userId } = await auth();
  return userId ?? null;
}

/** A name to show next to things a person publishes, like a shared workflow. One Clerk API call. */
export async function displayName(): Promise<string> {
  const user = await currentUser();
  if (user === null) return 'Someone';
  const full = [user.firstName, user.lastName].filter((part) => typeof part === 'string' && part.trim().length > 0).join(' ');
  return full.length > 0 ? full : (user.username ?? user.primaryEmailAddress?.emailAddress.split('@')[0] ?? 'Someone');
}

/** Removes the person from Clerk. Their studio data is deleted by the caller first. */
export async function deleteClerkUser(userId: string): Promise<void> {
  const client = await clerkClient();
  await client.users.deleteUser(userId);
}
