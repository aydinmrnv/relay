import type { PlanMode, Role } from '../storage/config.ts';

export const PHASES = [
  'INITIALIZING',
  'FETCHING_ISSUE',
  'CREATING_WORKSPACE',
  'PLANNING',
  'REVIEWING_PLAN',
  'REVISING_PLAN',
  'IMPLEMENTING',
  'REVIEWING_CODE',
  'REVISING_CODE',
  'TESTING',
  'COMPLETE',
  'FAILED',
  'CANCELLED',
] as const;

export type Phase = (typeof PHASES)[number];

export const TERMINAL_PHASES: readonly Phase[] = ['COMPLETE', 'FAILED', 'CANCELLED'];

/**
 * The workflow is a finite state machine with an explicit transition table, so
 * a bug can only ever produce a rejected transition — never an undefined state.
 * FAILED and CANCELLED are reachable from every non-terminal phase and are
 * therefore added programmatically below.
 */
const FORWARD_TRANSITIONS: Record<Phase, readonly Phase[]> = {
  INITIALIZING: ['FETCHING_ISSUE'],
  FETCHING_ISSUE: ['CREATING_WORKSPACE'],
  // Inline planning skips the planner and plan-review turns entirely: the
  // implementer writes the plan in its own session and implements it.
  CREATING_WORKSPACE: ['PLANNING', 'IMPLEMENTING'],
  PLANNING: ['REVIEWING_PLAN'],
  // Plan review either accepts (implement) or sends the plan back for revision.
  REVIEWING_PLAN: ['REVISING_PLAN', 'IMPLEMENTING'],
  REVISING_PLAN: ['REVIEWING_PLAN'],
  IMPLEMENTING: ['REVIEWING_CODE'],
  // Code review either accepts (test) or sends blocking findings back.
  REVIEWING_CODE: ['REVISING_CODE', 'TESTING'],
  REVISING_CODE: ['REVIEWING_CODE'],
  TESTING: ['COMPLETE'],
  COMPLETE: [],
  FAILED: [],
  CANCELLED: [],
};

function buildTransitionTable(): Record<Phase, readonly Phase[]> {
  const table = {} as Record<Phase, readonly Phase[]>;
  for (const phase of PHASES) {
    table[phase] = isTerminal(phase) ? [] : [...FORWARD_TRANSITIONS[phase], 'FAILED', 'CANCELLED'];
  }
  return table;
}

export const ALLOWED_TRANSITIONS: Record<Phase, readonly Phase[]> = buildTransitionTable();

export function isTerminal(phase: Phase): boolean {
  return TERMINAL_PHASES.includes(phase);
}

export function canTransition(from: Phase, to: Phase): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/** Human-readable phase label used in the terminal UI and summaries. */
export function phaseLabel(phase: Phase): string {
  switch (phase) {
    case 'INITIALIZING':
      return 'Initializing';
    case 'FETCHING_ISSUE':
      return 'Fetching issue';
    case 'CREATING_WORKSPACE':
      return 'Creating workspace';
    case 'PLANNING':
      return 'Planning';
    case 'REVIEWING_PLAN':
      return 'Plan review';
    case 'REVISING_PLAN':
      return 'Plan revision';
    case 'IMPLEMENTING':
      return 'Implementation';
    case 'REVIEWING_CODE':
      return 'Code review';
    case 'REVISING_CODE':
      return 'Code revision';
    case 'TESTING':
      return 'Tests';
    case 'COMPLETE':
      return 'Complete';
    case 'FAILED':
      return 'Failed';
    case 'CANCELLED':
      return 'Cancelled';
  }
}

/**
 * The phases shown as the progress checklist. Revision phases are folded into
 * the review step they belong to, so the display stays stable across rounds.
 */
export const DISPLAY_PHASES: readonly Phase[] = [
  'FETCHING_ISSUE',
  'CREATING_WORKSPACE',
  'PLANNING',
  'REVIEWING_PLAN',
  'IMPLEMENTING',
  'REVIEWING_CODE',
  'TESTING',
];

export function displayPhaseFor(phase: Phase): Phase | undefined {
  if (phase === 'REVISING_PLAN') return 'REVIEWING_PLAN';
  if (phase === 'REVISING_CODE') return 'REVIEWING_CODE';
  return DISPLAY_PHASES.includes(phase) ? phase : undefined;
}

/**
 * The checklist for a particular run. Inline planning never enters the two plan
 * phases, and a checklist that lists steps the run will not take reads as a
 * stall when they never turn green.
 */
export function displayPhasesFor(plan: PlanMode): readonly Phase[] {
  if (plan === 'review') return DISPLAY_PHASES;
  return DISPLAY_PHASES.filter((phase) => phase !== 'PLANNING' && phase !== 'REVIEWING_PLAN');
}

/**
 * Which agent role drives a phase. The progress display uses it for the status
 * column, and a failure report uses it to name the agent that actually failed
 * rather than blaming "the run".
 */
const PHASE_ROLES: Partial<Record<Phase, Role>> = {
  PLANNING: 'planner',
  REVIEWING_PLAN: 'planReviewer',
  REVISING_PLAN: 'planner',
  IMPLEMENTING: 'implementer',
  REVIEWING_CODE: 'codeReviewer',
  REVISING_CODE: 'implementer',
};

export function phaseRole(phase: Phase): Role | undefined {
  return PHASE_ROLES[phase];
}
