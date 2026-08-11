import { ClaudeHarness } from '../../agents/claude.ts';
import { CodexHarness } from '../../agents/codex.ts';
import { GitHubIssueProvider } from '../../github/provider.ts';
import { discoverRepository } from '../../git/repository.ts';
import { resolveExecutable, runProcess } from '../../process/runner.ts';
import { glyphs } from '../../ui/theme.ts';
import { dim, failure, heading, out, success, theme, warning } from '../output.ts';

interface Check {
  label: string;
  status: 'ok' | 'fail' | 'warn';
  detail: string;
  hint?: string;
}

/**
 * Verifies everything a run depends on, without touching credentials: Relay
 * asks each CLI whether it is authenticated and never reads a token itself.
 */
export async function doctorCommand(): Promise<number> {
  const checks: Check[] = [];

  checks.push(await checkBinary('git', ['--version']));
  checks.push(await checkBinary('gh', ['--version']));

  const claude = await new ClaudeHarness().checkAvailability();
  checks.push({
    label: 'Claude Code',
    status: claude.available ? 'ok' : 'fail',
    detail: claude.detail,
    ...(claude.hint === undefined ? {} : { hint: claude.hint }),
  });

  const codex = await new CodexHarness().checkAvailability();
  checks.push({
    label: 'Codex',
    status: codex.available ? 'ok' : 'fail',
    detail: codex.detail,
    ...(codex.hint === undefined ? {} : { hint: codex.hint }),
  });

  let repoRoot: string | undefined;
  try {
    const repo = await discoverRepository(process.cwd());
    repoRoot = repo.root;
    const slug = repo.owner !== null && repo.name !== null ? ` (${repo.owner}/${repo.name})` : ' (no GitHub remote)';
    checks.push({
      label: 'Git repository',
      status: 'ok',
      detail: `${repo.root}${slug}, base ${repo.defaultBranch}`,
    });
    if (repo.isDirty) {
      checks.push({
        label: 'Working tree',
        status: 'warn',
        detail: `${repo.dirtyFiles.length} uncommitted change(s)`,
        hint: 'Relay works in a separate worktree, so these are safe — they just will not be part of a run.',
      });
    }
  } catch (error) {
    checks.push({
      label: 'Git repository',
      status: 'fail',
      detail: error instanceof Error ? error.message : 'not a git repository',
      hint: 'Run relay from inside a git repository.',
    });
  }

  const gh = await new GitHubIssueProvider({ cwd: repoRoot ?? process.cwd() }).checkAvailability();
  checks.push({
    label: 'GitHub authentication',
    status: gh.available ? 'ok' : 'fail',
    detail: gh.detail,
    ...(gh.hint === undefined ? {} : { hint: gh.hint }),
  });

  const marks = glyphs(theme());
  heading('relay doctor');
  out();

  for (const check of checks) {
    const mark =
      check.status === 'ok' ? success(marks.ok) : check.status === 'warn' ? warning('!') : failure(marks.failed);
    out(`  ${mark} ${check.label.padEnd(24)} ${dim(check.detail)}`);
  }

  const problems = checks.filter((check) => check.status !== 'ok' && check.hint !== undefined);
  if (problems.length > 0) {
    out();
    for (const problem of problems) {
      out(`${problem.label}:`);
      out(indentHint(problem.hint ?? ''));
      out();
    }
  }

  const failed = checks.some((check) => check.status === 'fail');
  out();
  out(failed ? failure('Some checks failed. Relay cannot run until they pass.') : success('All checks passed.'));
  return failed ? 1 : 0;
}

function indentHint(hint: string): string {
  return hint
    .split('\n')
    .map((line) => (line.length > 0 ? `  ${line}` : line))
    .join('\n');
}

async function checkBinary(name: string, versionArgs: string[]): Promise<Check> {
  const path = await resolveExecutable(name);
  if (path === null) {
    return { label: name, status: 'fail', detail: 'not found', hint: `Install ${name} and make sure it is on your PATH.` };
  }
  const result = await runProcess(name, versionArgs, { timeoutMs: 20_000 });
  const version = result.stdout.trim().split('\n')[0] ?? '';
  return result.ok
    ? { label: name, status: 'ok', detail: version }
    : { label: name, status: 'fail', detail: 'installed but not runnable' };
}
