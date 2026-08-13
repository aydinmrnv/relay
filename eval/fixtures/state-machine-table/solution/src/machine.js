/**
 * Reference solution. Never copied into a run — `relay eval --check-fixtures`
 * applies it to prove the hidden suite can be satisfied.
 */

export const TRANSITIONS = {
  draft: { submit: 'review', discard: 'discarded' },
  review: { approve: 'approved', reject: 'draft', discard: 'discarded' },
  approved: { publish: 'published', reject: 'draft' },
  published: { archive: 'archived' },
  discarded: {},
  archived: {},
};

export const STATES = Object.keys(TRANSITIONS).sort();

/** `Object.hasOwn`, so `toString` and `__proto__` are not legal events. */
function nextState(state, event) {
  if (typeof state !== 'string' || !Object.hasOwn(TRANSITIONS, state)) return undefined;
  const events = TRANSITIONS[state];
  if (typeof event !== 'string' || !Object.hasOwn(events, event)) return undefined;
  return events[event];
}

export function transition(state, event) {
  const next = nextState(state, event);
  if (next === undefined) throw new Error(`cannot ${event} from ${state}`);
  return next;
}

export function canTransition(state, event) {
  return nextState(state, event) !== undefined;
}

export function eventsFrom(state) {
  if (typeof state !== 'string' || !Object.hasOwn(TRANSITIONS, state)) return [];
  return Object.keys(TRANSITIONS[state]).sort();
}
