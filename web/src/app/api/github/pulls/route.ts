import * as z from 'zod';
import { isRepository } from '@/lib/workflow/schema';
import { ApiError, json, readJson, withUser } from '@/server/api';
import { connectedAccount, githubApp } from '@/server/github/account';
import { openSetupPullRequest, pullRequestState } from '@/server/github/setup-pr';
import { LIMITS } from '@/server/rate-limit';
import { describeZodError } from '@/server/validate';

const repository = z.string().max(200).refine((value) => isRepository(value), 'Not a repository: use owner/name.');

const body = z.object({
  repository,
  name: z.string().min(1).max(200),
  files: z.array(z.object({ path: z.string().min(1).max(200), content: z.string().max(300_000) })).min(1).max(8),
  label: z.string().max(100).optional(),
  secrets: z.array(z.string().max(100)).max(20).optional(),
});

/** Opens the setup pull request for a workflow, or brings the open one up to date. */
export async function POST(request: Request) {
  return withUser(
    request,
    async (user) => {
      const parsed = body.safeParse(await readJson(request, 1_500_000));
      if (!parsed.success) throw new ApiError(400, 'INVALID', describeZodError(parsed.error as z.ZodError));
      const app = githubApp();
      const account = await connectedAccount(user.id, app);
      return json(await openSetupPullRequest(app, account.tokens.accessToken, { ...parsed.data, repository: parsed.data.repository.trim() }));
    },
    { limit: LIMITS.github },
  );
}

/** Whether a setup pull request is still open, merged, or closed without merging. */
export async function GET(request: Request) {
  return withUser(
    request,
    async (user) => {
      const params = new URL(request.url).searchParams;
      const repo = repository.safeParse(params.get('repository') ?? '');
      const number = Number(params.get('number'));
      if (!repo.success || !Number.isInteger(number) || number <= 0) throw new ApiError(400, 'INVALID', 'Name a repository and a pull request number.');
      const app = githubApp();
      const account = await connectedAccount(user.id, app);
      return json(await pullRequestState(app, account.tokens.accessToken, repo.data.trim(), number));
    },
    { limit: LIMITS.github },
  );
}
