import { ApiError, json, withUser } from '@/server/api';
import { GITHUB_ENABLED } from '@/server/env';
import { connectedAccount, disconnectGitHub, githubApp } from '@/server/github/account';
import { listReachable } from '@/server/github/repositories';
import { LIMITS } from '@/server/rate-limit';
import type { GitHubStatus } from '@/lib/github-types';

/** Whether GitHub is connected, and the repositories it reaches. */
export async function GET(request: Request) {
  return withUser(
    request,
    async (user) => {
      if (!GITHUB_ENABLED) return json({ connected: false } satisfies GitHubStatus);
      const app = githubApp();
      try {
        const account = await connectedAccount(user.id, app);
        return json(await listReachable(app, account.tokens.accessToken, account.login));
      } catch (error) {
        // Not connected, or a sign-in GitHub no longer takes: either way the answer is "connect GitHub".
        if (error instanceof ApiError && (error.code === 'GITHUB_NOT_CONNECTED' || error.code === 'GITHUB_RECONNECT')) return json({ connected: false } satisfies GitHubStatus);
        throw error;
      }
    },
    { limit: LIMITS.github },
  );
}

/** Forgets the connected account and ends its token. The app stays installed on GitHub until it is uninstalled there. */
export async function DELETE(request: Request) {
  return withUser(request, async (user) => {
    await disconnectGitHub(user.id);
    return json({ ok: true });
  });
}
