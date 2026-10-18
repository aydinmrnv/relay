import type { NextRequest } from 'next/server';
import { backTo, clearCookie, readCookie, RETURN_COOKIE, type ReturnCookie } from '@/server/github/flow';

/**
 * The app's setup URL: where GitHub sends the person after installing it or
 * changing its repositories. GitHub adds an `installation_id`, which is not
 * read: anyone can put one in a link. The studio asks GitHub again, with the
 * person's own token, what they can reach.
 */
export async function GET(request: NextRequest) {
  const saved = readCookie<ReturnCookie>(request, RETURN_COOKIE, ['next', 'user']);
  const response = backTo(request, saved?.next ?? '/projects', 'installed');
  clearCookie(response, RETURN_COOKIE);
  return response;
}
