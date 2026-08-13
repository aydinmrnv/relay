import { test } from 'node:test';
import assert from 'node:assert/strict';

import { STATES, TRANSITIONS, canTransition, eventsFrom, transition } from '../src/machine.js';

const EXPECTED = {
  draft: { submit: 'review', discard: 'discarded' },
  review: { approve: 'approved', reject: 'draft', discard: 'discarded' },
  approved: { publish: 'published', reject: 'draft' },
  published: { archive: 'archived' },
  discarded: {},
  archived: {},
};

test('STATES lists every state, sorted', () => {
  assert.deepEqual(STATES, ['approved', 'archived', 'discarded', 'draft', 'published', 'review']);
});

test('TRANSITIONS is the table, including the terminal states', () => {
  assert.deepEqual(Object.keys(TRANSITIONS).sort(), STATES);
  for (const state of STATES) {
    assert.deepEqual(TRANSITIONS[state], EXPECTED[state], `table differs for ${state}`);
  }
});

test('every legal transition still leads where it did', () => {
  for (const [state, events] of Object.entries(EXPECTED)) {
    for (const [event, next] of Object.entries(events)) {
      assert.equal(transition(state, event), next, `${state} + ${event}`);
    }
  }
});

test('every illegal pair throws with the same message it always did', () => {
  const allEvents = [...new Set(Object.values(EXPECTED).flatMap((events) => Object.keys(events)))];
  for (const state of STATES) {
    for (const event of allEvents) {
      if (event in EXPECTED[state]) continue;
      assert.throws(
        () => transition(state, event),
        (error) => {
          assert.equal(error.message, `cannot ${event} from ${state}`);
          return true;
        },
        `${state} + ${event}`,
      );
    }
  }
});

test('an unknown state throws the same way', () => {
  assert.throws(() => transition('nowhere', 'submit'), /cannot submit from nowhere/);
  assert.throws(() => transition(undefined, 'submit'), /cannot submit from undefined/);
});

test('canTransition never throws', () => {
  assert.equal(canTransition('draft', 'submit'), true);
  assert.equal(canTransition('draft', 'publish'), false);
  assert.equal(canTransition('archived', 'archive'), false);
  assert.equal(canTransition('nowhere', 'submit'), false);
  assert.equal(canTransition(undefined, undefined), false);
  assert.equal(canTransition('draft', '__proto__'), false);
  assert.equal(canTransition('draft', 'toString'), false);
});

test('canTransition agrees with transition everywhere', () => {
  const allEvents = [...new Set(Object.values(EXPECTED).flatMap((events) => Object.keys(events)))];
  for (const state of [...STATES, 'nowhere']) {
    for (const event of [...allEvents, 'nonsense']) {
      let threw = false;
      try {
        transition(state, event);
      } catch {
        threw = true;
      }
      assert.equal(canTransition(state, event), !threw, `${state} + ${event}`);
    }
  }
});

test('eventsFrom lists what the UI may offer', () => {
  assert.deepEqual(eventsFrom('draft'), ['discard', 'submit']);
  assert.deepEqual(eventsFrom('review'), ['approve', 'discard', 'reject']);
  assert.deepEqual(eventsFrom('approved'), ['publish', 'reject']);
  assert.deepEqual(eventsFrom('published'), ['archive']);
  assert.deepEqual(eventsFrom('discarded'), []);
  assert.deepEqual(eventsFrom('archived'), []);
  assert.deepEqual(eventsFrom('nowhere'), []);
});

test('every state the table leads to is a state the table knows', () => {
  for (const events of Object.values(TRANSITIONS)) {
    for (const next of Object.values(events)) {
      assert.ok(STATES.includes(next), `${next} is not a known state`);
    }
  }
});
