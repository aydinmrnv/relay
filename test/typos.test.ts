import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { typoize } from '../src/util/typos.ts';

const PROSE = [
  'This change adds rate limiting to the authentication handler, because the issue asks for it.',
  'The reviewer checked the diff against the plan and found nothing that would block a merge.',
  'Everything here is ordinary prose that a person would have typed themselves in a hurry.',
].join('\n');

describe('typoize', () => {
  it('actually mistypes prose', () => {
    const written = typoize(PROSE, { seed: 'run-1' });

    assert.notEqual(written, PROSE);
    // Structure survives: only the letters inside words move.
    assert.equal(written.split('\n').length, PROSE.split('\n').length);
  });

  it('is deterministic, so re-delivering a run does not rewrite its pull request', () => {
    assert.equal(typoize(PROSE, { seed: 'run-1' }), typoize(PROSE, { seed: 'run-1' }));
    assert.notEqual(typoize(PROSE, { seed: 'run-1' }), typoize(PROSE, { seed: 'run-2' }));
  });

  it('leaves the text alone when nothing is eligible', () => {
    const machine = ['```text', 'src/app.ts', '```', '', 'Closes #142'].join('\n');
    assert.equal(typoize(machine, { seed: 'run-1' }), machine);
  });

  it('never touches what a machine reads back', () => {
    const body = [
      'Implemented by Relay run `relay-20260812-abc` against the issue below.',
      '',
      '### Diff stat',
      '',
      '```text',
      'src/workflow/delivery.ts',
      'test/delivery.test.ts',
      '```',
      '',
      'The reviewer raised findings about the delivery phase and the implementer accepted them.',
      '',
      'See https://github.com/acme/widgets/pull/21 for the discussion of that decision.',
      '',
      'Issue: https://github.com/acme/widgets/issues/142',
      'Co-Authored-By: Claude <noreply@anthropic.com>',
      '',
      'Closes #142',
    ].join('\n');

    // Every seed, not one lucky one: this is the property the flag lives or
    // dies on, and a mistyped `Closes` silently stops closing the issue.
    for (let seed = 0; seed < 40; seed += 1) {
      const written = typoize(body, { seed: `run-${seed}`, rate: 2 });

      assert.match(written, /^Closes #142$/m, `seed ${seed} broke the issue reference`);
      assert.match(written, /^Co-Authored-By: Claude <noreply@anthropic\.com>$/m, `seed ${seed} broke a trailer`);
      assert.match(written, /^Issue: https:\/\/github\.com\/acme\/widgets\/issues\/142$/m, `seed ${seed} broke a trailer`);
      assert.match(written, /https:\/\/github\.com\/acme\/widgets\/pull\/21/, `seed ${seed} broke a URL`);
      assert.match(written, /^src\/workflow\/delivery\.ts$/m, `seed ${seed} broke a fenced path`);
      assert.match(written, /^test\/delivery\.test\.ts$/m, `seed ${seed} broke a fenced path`);
      assert.match(written, /`relay-20260812-abc`/, `seed ${seed} broke an inline code span`);
      assert.match(written, /^### /m, `seed ${seed} broke a heading`);
    }
  });

  it('keeps identifiers and short words intact', () => {
    const written = typoize('The runId and the BLOCKING findings are on the pull request.', {
      seed: 'run-1',
      rate: 2,
    });

    assert.match(written, /runId/);
    assert.match(written, /BLOCKING/);
  });

  it('mistypes at roughly the rate it is given', () => {
    const words = Array.from({ length: 200 }, () => 'sentence word number here').join(' ');
    const heavy = differences(words, typoize(words, { seed: 'x', rate: 2 }));
    const light = differences(words, typoize(words, { seed: 'x', rate: 20 }));

    assert.ok(heavy > light, `expected a lower rate to mistype more (${heavy} vs ${light})`);
    assert.ok(light > 0, 'even a light rate should leave some typos');
  });
});

/** How many whitespace-separated atoms the transform changed. */
function differences(before: string, after: string): number {
  const original = before.split(/\s+/);
  return after.split(/\s+/).filter((word, index) => word !== original[index]).length;
}
