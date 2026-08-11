import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ALLOWED_TRANSITIONS,
  PHASES,
  canTransition,
  displayPhaseFor,
  isTerminal,
  phaseLabel,
  type Phase,
} from '../src/workflow/phases.ts';
import { createRunState, transition, validateRunState, providerFor, recordAgentSession } from '../src/workflow/state.ts';
import { DEFAULT_CONFIG } from '../src/storage/config.ts';
import { RelayError } from '../src/util/errors.ts';

function newState() {
  return createRunState({
    runId: '20260811T120000-abc123',
    shortId: 'abc123',
    issueRef: '142',
    repository: { root: '/repo', owner: 'acme', name: 'widgets', defaultBranch: 'main' },
    config: structuredClone(DEFAULT_CONFIG),
    now: new Date('2026-08-11T12:00:00Z'),
  });
}

describe('phase machine', () => {
  it('every phase has a transition entry', () => {
    for (const phase of PHASES) {
      assert.ok(Array.isArray(ALLOWED_TRANSITIONS[phase]), `${phase} missing`);
    }
  });

  it('terminal phases have no outgoing transitions', () => {
    for (const phase of ['COMPLETE', 'FAILED', 'CANCELLED'] as const) {
      assert.equal(isTerminal(phase), true);
      assert.deepEqual(ALLOWED_TRANSITIONS[phase], []);
    }
  });

  it('every non-terminal phase can fail or be cancelled', () => {
    for (const phase of PHASES.filter((candidate) => !isTerminal(candidate))) {
      assert.ok(canTransition(phase, 'FAILED'), `${phase} cannot fail`);
      assert.ok(canTransition(phase, 'CANCELLED'), `${phase} cannot be cancelled`);
    }
  });

  it('models the happy path exactly', () => {
    const path: Phase[] = [
      'INITIALIZING',
      'FETCHING_ISSUE',
      'CREATING_WORKSPACE',
      'PLANNING',
      'REVIEWING_PLAN',
      'IMPLEMENTING',
      'REVIEWING_CODE',
      'TESTING',
      'COMPLETE',
    ];
    for (let i = 0; i < path.length - 1; i += 1) {
      assert.ok(canTransition(path[i]!, path[i + 1]!), `${path[i]} → ${path[i + 1]}`);
    }
  });

  it('allows the review loops in both directions', () => {
    assert.ok(canTransition('REVIEWING_PLAN', 'REVISING_PLAN'));
    assert.ok(canTransition('REVISING_PLAN', 'REVIEWING_PLAN'));
    assert.ok(canTransition('REVIEWING_CODE', 'REVISING_CODE'));
    assert.ok(canTransition('REVISING_CODE', 'REVIEWING_CODE'));
  });

  it('forbids skipping the work', () => {
    assert.equal(canTransition('PLANNING', 'COMPLETE'), false);
    assert.equal(canTransition('PLANNING', 'IMPLEMENTING'), false);
    assert.equal(canTransition('IMPLEMENTING', 'TESTING'), false);
    assert.equal(canTransition('COMPLETE', 'PLANNING'), false);
  });

  it('folds revision phases into the review step for display', () => {
    assert.equal(displayPhaseFor('REVISING_PLAN'), 'REVIEWING_PLAN');
    assert.equal(displayPhaseFor('REVISING_CODE'), 'REVIEWING_CODE');
    assert.equal(displayPhaseFor('FAILED'), undefined);
  });

  it('labels every phase', () => {
    for (const phase of PHASES) assert.ok(phaseLabel(phase).length > 0);
  });
});

describe('run state', () => {
  it('starts in INITIALIZING with roles bound from config', () => {
    const state = newState();
    assert.equal(state.phase, 'INITIALIZING');
    assert.equal(providerFor(state, 'planner'), 'claude');
    assert.equal(providerFor(state, 'implementer'), 'codex');
    assert.equal(state.rounds.planReview, 0);
    assert.equal(state.history.length, 1);
  });

  it('records each transition in history', () => {
    const state = newState();
    transition(state, 'FETCHING_ISSUE', { note: 'fetching' });
    transition(state, 'CREATING_WORKSPACE');

    assert.equal(state.phase, 'CREATING_WORKSPACE');
    assert.deepEqual(
      state.history.map((entry) => entry.phase),
      ['INITIALIZING', 'FETCHING_ISSUE', 'CREATING_WORKSPACE'],
    );
    assert.equal(state.history[1]?.note, 'fetching');
  });

  it('rejects an illegal transition and leaves state untouched', () => {
    const state = newState();
    assert.throws(() => transition(state, 'COMPLETE'), RelayError);
    assert.equal(state.phase, 'INITIALIZING');
    assert.equal(state.history.length, 1);
  });

  it('stamps finishedAt when reaching a terminal phase', () => {
    const state = newState();
    transition(state, 'FAILED', { note: 'boom' });
    assert.ok(state.finishedAt !== undefined);
  });

  it('is a no-op when transitioning to the current phase', () => {
    const state = newState();
    transition(state, 'INITIALIZING');
    assert.equal(state.history.length, 1);
  });

  it('stores session ids for resume and ignores undefined ones', () => {
    const state = newState();
    recordAgentSession(state, 'planner', 'sess-1');
    assert.equal(state.agents.planner?.sessionId, 'sess-1');
    recordAgentSession(state, 'planner', undefined);
    assert.equal(state.agents.planner?.sessionId, 'sess-1');
  });

  it('validates a persisted state and rejects a corrupted one', () => {
    const state = newState();
    assert.equal(validateRunState(JSON.parse(JSON.stringify(state))).runId, state.runId);

    assert.throws(() => validateRunState({ version: 2 }), RelayError);
    assert.throws(() => validateRunState({ version: 1 }), RelayError);
    assert.throws(() => validateRunState(null), RelayError);
  });
});
