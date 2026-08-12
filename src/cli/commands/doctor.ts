import { glyphs } from '../../ui/theme.ts';
import { collectChecks, type Check } from '../checks.ts';
import { dim, failure, heading, out, success, theme, warning } from '../output.ts';

/**
 * Verifies everything a run depends on, without touching credentials: Relay
 * asks each CLI whether it is authenticated and never reads a token itself.
 */
export async function doctorCommand(): Promise<number> {
  const checks = await collectChecks(process.cwd());

  heading('relay doctor');
  out();
  for (const check of checks) out(`  ${statusMark(check)} ${check.label.padEnd(24)} ${dim(check.detail)}`);

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
