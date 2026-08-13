import { AGENT_REGISTRY, type HarnessRegistration } from '../agents/index.ts';
import { describeCommand, probeAuth, type AuthState, type AuthSupport } from '../auth/delegated.ts';
import { discoverRepository } from '../git/repository.ts';
import { ISSUE_TRACKER_REGISTRY } from '../issues/registry.ts';
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

/**
 * Sign-in state for one delegated tool.
 *
 * Being installed is not being usable: a CLI that is present but signed out
 * fails at the first agent turn, ten minutes into a run, which is exactly the
 * failure onboarding exists to move forward to here.
 */
export async function authCheck(label: string, support: AuthSupport, cwd: string): Promise<Check> {
  return authStateCheck(label, support, await probeAuth(support, { cwd }));
}

/** The reporting half of `authCheck`, kept pure so a flow can probe once and print twice. */
export function authStateCheck(label: string, support: AuthSupport, state: AuthState): Check {
  const login = describeCommand(support.login);

  if (state === 'authenticated') return { label, status: 'ok', detail: 'signed in' };
  if (state === 'unknown') {
    return {
      label,
      status: 'warn',
      detail: 'sign-in state unknown',
      hint: `Relay could not ask. If a run fails to start, run \`${login}\`.`,
    };
  }
  return { label, status: 'fail', detail: 'not signed in', hint: `Run \`${login}\`.` };
}

/**
 * Sign-in state for every registered coding CLI that is actually installed.
 * A missing CLI has already reported the more useful problem.
 */
export async function agentAuthChecks(cwd: string, agents?: readonly AgentCheck[]): Promise<Check[]> {
  const installed = (agents ?? (await agentChecks())).filter(({ check }) => check.status === 'ok');
  return Promise.all(installed.map(({ entry }) => authCheck(`${entry.label} sign-in`, entry.auth, cwd)));
}

export async function githubCheck(cwd: string): Promise<Check> {
  const registration = ISSUE_TRACKER_REGISTRY[0]!;
  const result = await registration.create({ cwd }).checkAvailability();
  return {
    label: `${registration.label} authentication`,
    status: result.available ? 'ok' : 'fail',
    detail: result.detail,
    ...(result.hint === undefined ? {} : { hint: result.hint }),
  };
}

/**
 * Downgrades a failure to a warning, with the alternative attached.
 *
 * A tracker is how most runs find their issue and no longer how every run finds
 * one: `relay run ./spec.md` and `--prompt` need nothing installed. Reporting a
 * missing `gh` as fatal would have doctor say Relay cannot run when it can.
 */
function softenToWarning(check: Check, alternative: string): Check {
  if (check.status !== 'fail') return check;
  return {
    ...check,
    status: 'warn',
    hint: check.hint === undefined ? alternative : `${check.hint}\n${alternative}`,
  };
}

const WITHOUT_A_TRACKER =
  'Work that has no ticket needs none of this: `relay run ./spec.md`, `relay run --prompt "…"`.';

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
  const checks: Check[] = [
    await checkBinary('git', ['--version']),
    softenToWarning(await checkBinary('gh', ['--version']), WITHOUT_A_TRACKER),
  ];

  const agents = await agentChecks();
  for (const { check } of agents) checks.push(check);

  const repository = await repositoryChecks(cwd);
  checks.push(...(await agentAuthChecks(repository.root ?? cwd, agents)));
  checks.push(...repository.checks);
  checks.push(softenToWarning(await githubCheck(repository.root ?? cwd), WITHOUT_A_TRACKER));

  return checks;
}
