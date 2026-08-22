import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONFORMANCE_CLAUSES, checkConformanceClause } from './helpers/conformance.ts';
import { brokenSubject } from './helpers/brokenHarness.ts';

const FIXTURES = fileURLToPath(new URL('./fixtures/harness', import.meta.url));

/**
 * The suite is only worth trusting if it catches a harness doing the wrong
 * thing. This runs a deliberately broken harness — it lies about crashes,
 * leaks throws, re-sends context, hangs through cancel, puts prompts on argv
 * and misclassifies its failures — through every clause, and requires every
 * clause to reject it.
 */
describe('the conformance suite catches a deliberately broken harness', () => {
  const subject = brokenSubject(join(FIXTURES, 'mytool'));

  for (const clause of CONFORMANCE_CLAUSES) {
    it(`rejects: ${clause}`, async () => {
      await assert.rejects(
        checkConformanceClause(subject, clause),
        `the broken harness passed "${clause}" — the suite has lost its teeth`,
      );
    });
  }
});
