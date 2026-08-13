import type { Check } from './checks.ts';

/**
 * The machine-readable shape of a readiness report, for `relay doctor --json`
 * and `relay start --json`.
 *
 * A check is three facts and a remedy: what was inspected, how it came out,
 * what was found, and — when something is wrong — the command that fixes it.
 * `hint` is `null` rather than an omitted key on the checks that passed, so a
 * consumer can read `.hint` off every row without guarding.
 */
export interface CheckJson {
  label: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
  hint: string | null;
}

export interface DoctorJson {
  /** False when anything failed. Warnings do not make a report not-ok. */
  ok: boolean;
  counts: { ok: number; warn: number; fail: number };
  checks: CheckJson[];
}

/** Projects the checks onto the public JSON contract, colour and marks stripped. */
export function checksToJson(checks: readonly Check[]): DoctorJson {
  const count = (status: Check['status']): number => checks.filter((check) => check.status === status).length;

  return {
    ok: !checks.some((check) => check.status === 'fail'),
    counts: { ok: count('ok'), warn: count('warn'), fail: count('fail') },
    checks: checks.map((check) => ({
      label: check.label,
      status: check.status,
      detail: check.detail,
      hint: check.hint ?? null,
    })),
  };
}
