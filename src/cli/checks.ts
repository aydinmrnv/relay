import { AGENT_REGISTRY, type HarnessRegistration } from '../agents/index.ts';
import { discoverRepository } from '../git/repository.ts';
import { GitHubIssueProvider } from '../github/provider.ts';
import { resolveExecutable, runProcess } from '../process/runner.ts';

export interface Check {
  label: string;
  status: 'ok' | 'fail' | 'warn';
  detail: string;
  hint?: string;
}

export interface AgentCheck {
  entry: HarnessRegistration;
  check: Check;
}

/**
 * The environment checks `relay doctor` reports.
 *
 * They live here rather than inside the doctor command because `relay init`
 * needs the same answers during onboarding: a second implementation would
 * eventually disagree with this one about whether a CLI is usable.
 */
export async function checkBinary(name: string, versionArgs: readonly string[]): Promise<Check> {
  const path = await resolveExecutable(name);
  if (path === null) {
    return {
      label: name,
      status: 'fail',
      detail: 'not found',
      hint: `Install ${name} and make sure it is on your PATH.`,
    };
  }

  const result = await runProcess(name, [...versionArgs], { timeoutMs: 20_000 });
  const version = result.stdout.trim().split('\n')[0] ?? '';
  return result.ok
    ? { label: name, status: 'ok', detail: version }
    : { label: name, status: 'fail', detail: 'installed but not runnable' };
}

/**
 * Every registered CLI, in registry order, so a newly added harness is checked
 * without doctor or init knowing its name.
 */
export async function agentChecks(): Promise<AgentCheck[]> {
  return Promise.all(
    AGENT_REGISTRY.map(async (entry) => {
      const result = await entry.create({}).checkAvailability();
      return {
        entry,
        check: {
          label: entry.label,
          status: result.available ? ('ok' as const) : ('fail' as const),
          detail: result.detail,
          ...(result.hint === undefined ? {} : { hint: result.hint }),
        },
      };
    }),
  );
}

export async function githubCheck(cwd: string): Promise<Check> {
  const result = await new GitHubIssueProvider({ cwd }).checkAvailability();
  return {
    label: 'GitHub authentication',
    status: result.available ? 'ok' : 'fail',
    detail: result.detail,
    ...(result.hint === undefined ? {} : { hint: result.hint }),
  };
}

/** Repository checks, plus the root they were resolved against when there is one. */
export async function repositoryChecks(cwd: string): Promise<{ root?: string; checks: Check[] }> {
  try {
    const repo = await discoverRepository(cwd);
    const slug = repo.owner !== null && repo.name !== null ? ` (${repo.owner}/${repo.name})` : ' (no GitHub remote)';
    const checks: Check[] = [
      { label: 'Git repository', status: 'ok', detail: `${repo.root}${slug}, base ${repo.defaultBranch}` },
    ];

    if (repo.isDirty) {
      checks.push({
        label: 'Working tree',
        status: 'warn',
        detail: `${repo.dirtyFiles.length} uncommitted change(s)`,
        hint: 'Relay works in a separate worktree, so these are safe — they just will not be part of a run.',
      });
    }
    return { root: repo.root, checks };
  } catch (error) {
    return {
      checks: [
        {
          label: 'Git repository',
          status: 'fail',
          detail: error instanceof Error ? error.message : 'not a git repository',
          hint: 'Run relay from inside a git repository.',
        },
      ],
    };
  }
}

/** Everything a run depends on, in the order `relay doctor` reports it. */
export async function collectChecks(cwd: string): Promise<Check[]> {
  const checks: Check[] = [await checkBinary('git', ['--version']), await checkBinary('gh', ['--version'])];

  for (const { check } of await agentChecks()) checks.push(check);

  const repository = await repositoryChecks(cwd);
  checks.push(...repository.checks);
  checks.push(await githubCheck(repository.root ?? cwd));

  return checks;
}
