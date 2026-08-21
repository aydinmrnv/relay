import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyReviewLevel,
  describeReview,
  levelOf,
  profileFor,
  REVIEW_LEVELS,
  REVIEW_PROFILES,
  reviewLevelName,
  type ReviewLevel,
} from '../src/reviews/level.ts';
import { DEFAULT_CONFIG, mergeConfig, reviewLevelOf, reviewProfileOf } from '../src/storage/config.ts';
import { applyOverrides, parseReviewLevel, resolveReviewLevel } from '../src/cli/commands/run.ts';
import { buildCodeReviewPrompt, buildPlanReviewPrompt } from '../src/agents/prompts.ts';
import { setTheme } from '../src/cli/output.ts';
import { RelayError } from '../src/util/errors.ts';
import type { Theme } from '../src/ui/theme.ts';

const PIPED: Theme = { color: false, unicode: true, interactive: false };

beforeEach(() => setTheme(PIPED));
afterEach(() => setTheme(undefined));

/** Silences the lines `applyOverrides` prints about what it just changed. */
function quietly<T>(work: () => T): T {
  const original = process.stdout.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    return work();
  } finally {
    process.stdout.write = original;
  }
}

describe('review levels', () => {
  it('ranks: every step up reviews at least as hard as the one below', () => {
    let previousRounds = -1;
    for (const level of REVIEW_LEVELS) {
      const profile = REVIEW_PROFILES[level];
      const rounds = profile.maxPlanReviewRounds + profile.maxCodeReviewRounds;
      assert.ok(rounds >= previousRounds, `${level} takes fewer rounds than the level below it`);
      previousRounds = rounds;
    }
  });

  it('reproduces exactly what Relay did before levels existed, at standard', () => {
    const standard = REVIEW_PROFILES.standard;
    assert.equal(standard.plan, DEFAULT_CONFIG.workflow.plan);
    assert.equal(standard.reviewCode, DEFAULT_CONFIG.workflow.reviewCode);
    assert.equal(standard.maxPlanReviewRounds, DEFAULT_CONFIG.workflow.maxPlanReviewRounds);
    assert.equal(standard.maxCodeReviewRounds, DEFAULT_CONFIG.workflow.maxCodeReviewRounds);
    assert.equal(DEFAULT_CONFIG.workflow.review, 'standard');
  });

  it('turns everything off at none, which is what --fast has always meant', () => {
    const workflow = applyReviewLevel(structuredClone(DEFAULT_CONFIG.workflow), 'none');
    assert.equal(workflow.plan, 'inline');
    assert.equal(workflow.reviewCode, false);
    assert.match(describeReview({ ...workflow, review: 'none' }), /nothing reviews this run/);
  });

  it('reads a level back off the knobs, for runs recorded before levels existed', () => {
    assert.equal(levelOf({ plan: 'review', reviewCode: true, maxPlanReviewRounds: 2, maxCodeReviewRounds: 2 }), 'standard');
    assert.equal(levelOf({ plan: 'inline', reviewCode: false, maxPlanReviewRounds: 0, maxCodeReviewRounds: 0 }), 'none');
    // A hand-tuned config is at no level at all, and saying so beats inventing one.
    assert.equal(levelOf({ plan: 'review', reviewCode: true, maxPlanReviewRounds: 2, maxCodeReviewRounds: 7 }), null);
  });

  it('lets the declared level decide the bars, not a round count somebody tuned', () => {
    // Asking for one more round is not asking for a lower severity bar, and
    // inferring the second from the first would change what comes back to the
    // implementer without anyone having asked for it.
    const tuned = { review: 'standard' as ReviewLevel, plan: 'review' as const, reviewCode: true, maxPlanReviewRounds: 2, maxCodeReviewRounds: 3 };
    assert.equal(profileFor(tuned).returnsAt, REVIEW_PROFILES.standard.returnsAt);
    assert.equal(reviewLevelName(tuned), 'standard (tuned)');
  });

  it('describes what a run will really do, rather than what the level says alone', () => {
    const description = describeReview({
      review: 'standard',
      plan: 'review',
      reviewCode: true,
      maxPlanReviewRounds: 2,
      maxCodeReviewRounds: 4,
    });
    assert.match(description, /code 4/, 'the tuned round count is the one that will happen');
  });
});

describe('review level in the config file', () => {
  it('sets all four keys from one word', () => {
    const config = mergeConfig(DEFAULT_CONFIG, { workflow: { review: 'thorough' } });

    assert.equal(config.workflow.review, 'thorough');
    assert.equal(config.workflow.maxPlanReviewRounds, 3);
    assert.equal(config.workflow.maxCodeReviewRounds, 3);
    assert.equal(reviewLevelOf(config), 'thorough');
  });

  it('lets a key written by hand win over the level that seeded it', () => {
    const config = mergeConfig(DEFAULT_CONFIG, {
      workflow: { review: 'thorough', maxCodeReviewRounds: 1 },
    });

    assert.equal(config.workflow.maxPlanReviewRounds, 3, 'still the level\'s');
    assert.equal(config.workflow.maxCodeReviewRounds, 1, 'but not this one');
    // The severity bars still come from the level that was asked for.
    assert.equal(reviewProfileOf(config).returnsAt, REVIEW_PROFILES.thorough.returnsAt);
  });

  it('rejects a level that does not exist rather than ignoring it', () => {
    assert.throws(
      () => mergeConfig(DEFAULT_CONFIG, { workflow: { review: 'paranoid' } }),
      (error: unknown) => error instanceof RelayError && error.code === 'BAD_CONFIG',
    );
  });

  it('reads a run recorded before the key existed as the level its rounds describe', () => {
    const workflow = structuredClone(DEFAULT_CONFIG.workflow) as Partial<typeof DEFAULT_CONFIG.workflow>;
    delete workflow.review;
    assert.equal(profileFor(workflow).level, 'standard');
  });
});

describe('--review', () => {
  it('applies the level to the run', () => {
    const config = quietly(() => applyOverrides(DEFAULT_CONFIG, { review: 'exhaustive' }));

    assert.equal(config.workflow.review, 'exhaustive');
    assert.equal(config.workflow.maxCodeReviewRounds, 4);
  });

  it('lets an explicit round count override the level, the way the config file does', () => {
    const config = quietly(() => applyOverrides(DEFAULT_CONFIG, { review: 'exhaustive', maxCodeRounds: '1' }));

    assert.equal(config.workflow.maxPlanReviewRounds, 4);
    assert.equal(config.workflow.maxCodeReviewRounds, 1);
  });

  it('treats --fast as the bottom of the same scale', () => {
    const config = quietly(() => applyOverrides(DEFAULT_CONFIG, { fast: true }));

    assert.equal(config.workflow.review, 'none');
    assert.equal(config.workflow.plan, 'inline');
    assert.equal(config.workflow.reviewCode, false);
  });

  it('refuses two flags that point the same dial in different directions', () => {
    assert.throws(
      () => resolveReviewLevel({ fast: true, review: 'thorough' }),
      (error: unknown) => error instanceof RelayError && error.code === 'BAD_FLAG',
    );
    // Saying the same thing twice is not a contradiction.
    assert.equal(resolveReviewLevel({ fast: true, review: 'none' }), 'none');
  });

  it('rejects a level nobody defined, naming the ones that exist', () => {
    assert.throws(
      () => parseReviewLevel('paranoid'),
      (error: unknown) => error instanceof RelayError && /exhaustive/.test(error.message),
    );
  });

  it('says out loud when a run is reviewed less than the default', () => {
    let output = '';
    const original = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      output += chunk.toString();
      return true;
    }) as typeof process.stdout.write;
    try {
      applyOverrides(DEFAULT_CONFIG, { review: 'none' });
    } finally {
      process.stdout.write = original;
    }
    assert.match(output, /the tests are the only check/i);
  });
});

describe('what the reviewers are told', () => {
  const context = {
    worktreePath: '/tmp/wt',
    branch: 'relay/142',
    issueMarkdown: '# Add rate limiting',
    plan: 'Do the thing.',
  };

  it('names the bar a code reviewer is classifying against', () => {
    const prompt = buildCodeReviewPrompt({
      ...context,
      diff: '--- a\n+++ b',
      diffStat: '1 file',
      round: 1,
      maxRounds: 3,
      profile: REVIEW_PROFILES.thorough,
    });

    assert.match(prompt, /review depth is "thorough"/);
    assert.match(prompt, /medium severity or above goes back to the implementer/);
    assert.match(prompt, /at most 15 findings/);
  });

  it('asks a light review for less, in as many words', () => {
    const prompt = buildCodeReviewPrompt({
      ...context,
      diff: '',
      diffStat: '1 file',
      round: 1,
      maxRounds: 1,
      profile: REVIEW_PROFILES.light,
    });

    assert.match(prompt, /at most 5 findings/);
    assert.match(prompt, /Style, naming, structure and ideas for/);
  });

  it('tells the plan reviewer which findings the planner has to answer', () => {
    const prompt = buildPlanReviewPrompt({
      ...context,
      round: 1,
      maxRounds: 4,
      profile: REVIEW_PROFILES.exhaustive,
    });

    assert.match(prompt, /low severity or above/);
    assert.match(prompt, /Use "approve" only if you found nothing of low severity or above/);
  });

  it('reviews at the standard level when a caller says nothing', () => {
    const prompt = buildPlanReviewPrompt({ ...context, round: 1, maxRounds: 2 });
    assert.match(prompt, /review depth is "standard"/);
    assert.match(prompt, /at most 10 findings/);
  });
});
