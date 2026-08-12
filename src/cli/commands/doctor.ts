import { glyphs } from '../../ui/theme.ts';
import { collectChecks, type Check } from '../checks.ts';
import { banner, box, dim, failure, gridLines, out, success, theme, warning } from '../output.ts';

/**
 * Verifies everything a run depends on, without touching credentials: Relay
 * asks each CLI whether it is authenticated and never reads a token itself.
 */
export async function doctorCommand(): Promise<number> {
  const checks = await collectChecks(process.cwd());
  const failed = checks.some((check) => check.status === 'fail');

  banner('Preflight for everything a run depends on.');

  box({
    title: 'relay doctor',
    badge: tally(checks),
    // Three unlabelled columns: the mark, what was checked, and what was found.
    // The header would only repeat what each row already says.
    body: gridLines(
      [{ header: '' }, { header: '' }, { header: '' }],
      checks.map((check) => [statusMark(check), check.label, dim(check.detail)]),
    ),
    footer: [failed ? failure('Relay cannot run until these pass.') : success('All checks passed.')],
    accent: failed ? 'red' : 'gray',
  });

  // Hints are multi-line prose with commands to copy, so they are printed under
  // the panel rather than inside it: a frame around a command makes it harder
  // to select, which is the one thing the reader is here to do with it.
  const problems = checks.filter((check) => check.status !== 'ok' && check.hint !== undefined);
  for (const problem of problems) {
    out();
    out(`${problem.label}:`);
    out(indentHint(problem.hint ?? ''));
  }
  if (problems.length > 0) out();

  return failed ? 1 : 0;
}

/** `5 ok · 1 warning · 1 failed`, naming only the categories that occurred. */
function tally(checks: readonly Check[]): string {
  const count = (status: Check['status']): number => checks.filter((check) => check.status === status).length;
  const warned = count('warn');
  const broken = count('fail');

  return [
    `${count('ok')} ok`,
    warned > 0 ? warning(`${warned} warning${warned === 1 ? '' : 's'}`) : undefined,
    broken > 0 ? failure(`${broken} failed`) : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(dim(' · '));
}

/** Shared with `relay init`, which lists the same agent checks during onboarding. */
export function statusMark(check: Check): string {
  const marks = glyphs(theme());
  if (check.status === 'ok') return success(marks.ok);
  return check.status === 'warn' ? warning('!') : failure(marks.failed);
}

function indentHint(hint: string): string {
  return hint
    .split('\n')
    .map((line) => (line.length > 0 ? `  ${line}` : line))
    .join('\n');
}
