import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

import { AGENT_PROVIDERS, isAgentProvider } from '../agents/index.ts';
import { MERGE_METHODS, type MergeMethod } from '../github/pullRequest.ts';
import { RelayError } from '../util/errors.ts';
import { atomicWriteJson } from './atomic.ts';

export { AGENT_PROVIDERS };

/**
 * The name of a registered harness. Deliberately not a union of the CLIs that
 * happen to ship today: the set lives in `AGENT_REGISTRY`, and every value that
 * reaches config is checked against it at load time.
 */
export type AgentProvider = string;

export const ROLES = ['planner', 'planReviewer', 'implementer', 'codeReviewer'] as const;
export type Role = (typeof ROLES)[number];

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/**
 * How the plan is produced.
 *
 * `review` is the full pipeline: a planner turn, then an adversarial plan review
 * from the other model, then revisions. `inline` collapses those into the
 * implementer's own session — it writes the plan and implements it in one turn —
 * which removes two to four serial agent turns from the run at the cost of the
 * cross-model critique of the plan. The code review still happens either way.
 */
export const PLAN_MODES = ['review', 'inline'] as const;
export type PlanMode = (typeof PLAN_MODES)[number];

/**
 * How far a finished run carries its own work, without being asked.
 *
 * Delivery is a phase of the run like any other: the pipeline that planned,
 * reviewed, implemented and tested the change also takes it as far as this
 * setting allows, and reports each step it took or skipped. The policy is a
 * ceiling, not a demand — a run with no remote stops at `branch` and says so,
 * and every step below the ceiling still has to pass its own gate.
 *
 * `pr` is the default because it is the end of the work Relay can be
 * accountable for: the change reaches a place a human reviews it, and no
 * shared branch has moved.
 */
export const DELIVERY_POLICIES = ['none', 'branch', 'push', 'pr', 'merge'] as const;
export type DeliveryPolicy = (typeof DELIVERY_POLICIES)[number];

export function isDeliveryPolicy(value: unknown): value is DeliveryPolicy {
  return typeof value === 'string' && (DELIVERY_POLICIES as readonly string[]).includes(value);
}

export { MERGE_METHODS, type MergeMethod };

function isMergeMethod(value: unknown): value is MergeMethod {
  return typeof value === 'string' && (MERGE_METHODS as readonly string[]).includes(value);
}

export interface RelayConfig {
  version: 1;
  agents: Record<Role, AgentProvider>;
  /**
   * Model overrides, keyed by role (`codeReviewer`) or by provider (`claude`).
   * A role key wins, which is what lets a review run on a faster model than the
   * turn it is reviewing even when both are the same CLI.
   */
  models: Partial<Record<AgentProvider | Role, string>>;
  workflow: {
    plan: PlanMode;
    /**
     * Whether the diff is reviewed by the other model before it is tested.
     *
     * On by default: a diff nobody but its author read is the thing Relay
     * exists to avoid. `relay run --fast` turns it off, together with the plan
     * review, for a ticket where the wall-clock matters more than the critique.
     */
    reviewCode: boolean;
    maxPlanReviewRounds: number;
    maxCodeReviewRounds: number;
    /** Branch to base worktrees on. Empty means "use the repository default". */
    baseBranch: string;
    branchPrefix: string;
    runTests: boolean;
    /** How far the run delivers its own work: commit, push, pull request, merge. */
    deliver: DeliveryPolicy;
    /** How `deliver: merge` lands a pull request. Repositories disallow methods. */
    mergeMethod: MergeMethod;
    /**
     * Ask, once, at the end of a run that delivered short of a merge. It is the
     * only question Relay asks: everything before it is mechanical, and merging
     * is the step that turns a proposal into the branch other people pull.
     */
    offerMerge: boolean;
    /** Extra attempts allowed per agent turn after a transient failure. */
    maxTransientRetries: number;
    /**
     * Dollars this run is allowed to report before it stops itself.
     *
     * Unset by default, because a ceiling nobody chose is a run that dies
     * halfway through for a reason the user never asked for. When it is set,
     * the accumulator is checked at every phase boundary and an exceeded
     * budget ends the run the way a cancellation does: the work is committed
     * to its branch, nothing is published, and the reason is recorded.
     */
    maxCostUsd: number | null;
    /**
     * Ask, once, before starting a run whose *estimate* exceeds this.
     *
     * Unset by default. It is a question about money that has not been spent
     * yet, so it is answered before the first agent turn or not at all: on a
     * terminal it prompts, and anywhere else an exceeded threshold is a
     * refusal, never a prompt nobody can answer.
     */
    confirmAboveUsd: number | null;
    /**
     * Let a reviewer read the repository during the phase it will review, so
     * its review turn is a judgement rather than a fresh reading of the code.
     */
    primeReviewers: boolean;
    /** Start the test suite as soon as a diff exists, alongside code review. */
    concurrentTests: boolean;
    /**
     * Write everything this run publishes the way a person types it: with
     * typos. What `relay run --tuff` sets. It reaches the pull request, the
     * commit messages, and the comments the agents leave in the code — and
     * nothing a machine reads back, which is checked in `src/util/typos.ts`.
     */
    typos: boolean;
  };
  github: {
    autoPush: boolean;
    autoPr: boolean;
    autoMerge: boolean;
    mergeMethod: MergeMethod;
    deleteBranchOnMerge: boolean;
    protectedBranches: string[];
  };
  timeouts: {
    planningMs: number;
    reviewMs: number;
    implementationMs: number;
    testsMs: number;
    /** Cap on a priming turn, which is speculative and must not stall a run. */
    primingMs: number;
    /** How long a review waits for a read-ahead that has not landed yet. */
    primeGraceMs: number;
  };
  tests: {
    /** Overrides discovery entirely, e.g. `["npm", "test"]`. */
    command: string[] | null;
  };
  delivery: { comment: boolean };
  notify: { webhook: string | null };
  tracking: {
    enabled: boolean;
    plugin: string;
    project: string | null;
    includeAgentPhases: boolean;
  };
}

/**
 * Defaults follow the brief: Claude plans (it reads a codebase well), Codex
 * implements inside its sandbox, and each agent reviews the other's work so
 * neither grades its own homework.
 */
export const DEFAULT_CONFIG: RelayConfig = {
  version: 1,
  agents: {
    planner: 'claude',
    planReviewer: 'codex',
    implementer: 'codex',
    codeReviewer: 'claude',
  },
  models: {},
  workflow: {
    plan: 'review',
    reviewCode: true,
    // Two rounds, not three: a round is a review turn plus a revision turn, and
    // a third round almost never changes the outcome it spends five minutes on.
    maxPlanReviewRounds: 2,
    maxCodeReviewRounds: 2,
    baseBranch: '',
    branchPrefix: 'relay',
    runTests: true,
    deliver: 'branch',
    mergeMethod: 'squash',
    offerMerge: true,
    maxTransientRetries: 2,
    maxCostUsd: null,
    confirmAboveUsd: null,
    primeReviewers: true,
    concurrentTests: true,
    typos: false,
  },
  github: {
    autoPush: false,
    autoPr: false,
    autoMerge: false,
    mergeMethod: 'squash',
    deleteBranchOnMerge: false,
    protectedBranches: [],
  },
  timeouts: {
    planningMs: 20 * 60_000,
    reviewMs: 20 * 60_000,
    implementationMs: 45 * 60_000,
    testsMs: 15 * 60_000,
    primingMs: 6 * 60_000,
    primeGraceMs: 60_000,
  },
  tests: {
    command: null,
  },
  delivery: { comment: false },
  notify: { webhook: null },
  tracking: {
    enabled: false,
    plugin: 'relay/<version> relay-wakatime/<version>',
    project: null,
    includeAgentPhases: true,
  },
};

/** Old run snapshots predate this outward-facing opt-in. */
export function commentsIssue(config: RelayConfig): boolean {
  return config.delivery?.comment === true;
}

/**
 * Whether a run reviews its own diff.
 *
 * Read through a function rather than straight off the object because a run
 * recorded before `reviewCode` existed has no such key in its config snapshot,
 * and absent there means the run *did* review its code. Reporting those as
 * skipped would rewrite the history of every run already on disk.
 */
export function reviewsCode(config: RelayConfig): boolean {
  return config.workflow.reviewCode !== false;
}

export function relayDir(repoRoot: string): string {
  return join(repoRoot, '.relay');
}

export function configPath(repoRoot: string): string {
  return join(relayDir(repoRoot), 'config.json');
}

export function runsDir(repoRoot: string): string {
  return join(relayDir(repoRoot), 'runs');
}

/** Loads repository config, falling back to defaults when absent. */
export async function loadConfig(repoRoot: string): Promise<RelayConfig> {
  const path = configPath(repoRoot);
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(DEFAULT_CONFIG);
    throw error;
  }
  try {
    return mergeConfig(DEFAULT_CONFIG, JSON.parse(contents) as unknown);
  } catch (error) {
    if (error instanceof RelayError) throw error;
    throw new RelayError(`${path} must contain valid JSON.`, { code: 'BAD_CONFIG', cause: error });
  }
}

export async function writeConfig(repoRoot: string, config: RelayConfig): Promise<string> {
  const path = configPath(repoRoot);
  await atomicWriteJson(path, config);
  return path;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Merges user config over defaults, validating as it goes. Invalid values are
 * rejected loudly: silently ignoring `"planner": "gpt5"` would run the workflow
 * with a role the user never asked for.
 */
export function mergeConfig(base: RelayConfig, raw: unknown): RelayConfig {
  if (!isRecord(raw)) {
    throw new RelayError('.relay/config.json must contain a JSON object.', { code: 'BAD_CONFIG' });
  }

  const config: RelayConfig = structuredClone(base);

  const agents = raw['agents'];
  if (agents !== undefined) {
    if (!isRecord(agents)) throw new RelayError('config.agents must be an object.', { code: 'BAD_CONFIG' });
    for (const [role, provider] of Object.entries(agents)) {
      if (!(ROLES as readonly string[]).includes(role)) {
        throw new RelayError(`Unknown role "${role}" in config.agents. Valid roles: ${ROLES.join(', ')}.`, {
          code: 'BAD_CONFIG',
        });
      }
      if (!isAgentProvider(provider)) {
        throw new RelayError(
          `Unknown agent "${String(provider)}" for role "${role}". Valid agents: ${AGENT_PROVIDERS.join(', ')}.`,
          { code: 'BAD_CONFIG' },
        );
      }
      config.agents[role as Role] = provider;
    }
  }

  const models = raw['models'];
  if (models !== undefined) {
    if (!isRecord(models)) throw new RelayError('config.models must be an object.', { code: 'BAD_CONFIG' });
    for (const [key, model] of Object.entries(models)) {
      // A role key and a provider key are both legitimate: the first pins one
      // seat's model, the second pins every seat that CLI happens to fill.
      if (!isAgentProvider(key) && !isRole(key)) {
        throw new RelayError(
          `Unknown key "${key}" in config.models. Valid keys: ${[...ROLES, ...AGENT_PROVIDERS].join(', ')}.`,
          { code: 'BAD_CONFIG' },
        );
      }
      if (typeof model !== 'string') {
        throw new RelayError(`config.models.${key} must be a string.`, { code: 'BAD_CONFIG' });
      }
      config.models[key] = model;
    }
  }

  const workflow = raw['workflow'];
  if (workflow !== undefined) {
    if (!isRecord(workflow)) throw new RelayError('config.workflow must be an object.', { code: 'BAD_CONFIG' });
    if (workflow['plan'] !== undefined) {
      const plan = workflow['plan'];
      if (typeof plan !== 'string' || !(PLAN_MODES as readonly string[]).includes(plan)) {
        throw new RelayError(`config.workflow.plan must be one of ${PLAN_MODES.join(' | ')}.`, { code: 'BAD_CONFIG' });
      }
      config.workflow.plan = plan as PlanMode;
    }
    config.workflow.maxPlanReviewRounds = readBoundedInt(
      workflow['maxPlanReviewRounds'],
      config.workflow.maxPlanReviewRounds,
      'workflow.maxPlanReviewRounds',
      { min: 0, max: 10 },
    );
    config.workflow.maxCodeReviewRounds = readBoundedInt(
      workflow['maxCodeReviewRounds'],
      config.workflow.maxCodeReviewRounds,
      'workflow.maxCodeReviewRounds',
      { min: 0, max: 10 },
    );
    if (workflow['baseBranch'] !== undefined) {
      if (typeof workflow['baseBranch'] !== 'string') {
        throw new RelayError('config.workflow.baseBranch must be a string.', { code: 'BAD_CONFIG' });
      }
      config.workflow.baseBranch = workflow['baseBranch'];
    }
    if (workflow['deliver'] !== undefined) {
      if (!isDeliveryPolicy(workflow['deliver'])) {
        throw new RelayError(`config.workflow.deliver must be one of ${DELIVERY_POLICIES.join(' | ')}.`, {
          code: 'BAD_CONFIG',
        });
      }
      config.workflow.deliver = workflow['deliver'];
    }
    if (workflow['mergeMethod'] !== undefined) {
      if (!isMergeMethod(workflow['mergeMethod'])) {
        throw new RelayError(`config.workflow.mergeMethod must be one of ${MERGE_METHODS.join(' | ')}.`, {
          code: 'BAD_CONFIG',
        });
      }
      config.workflow.mergeMethod = workflow['mergeMethod'];
    }
    if (workflow['branchPrefix'] !== undefined) {
      if (typeof workflow['branchPrefix'] !== 'string' || workflow['branchPrefix'].length === 0) {
        throw new RelayError('config.workflow.branchPrefix must be a non-empty string.', { code: 'BAD_CONFIG' });
      }
      config.workflow.branchPrefix = workflow['branchPrefix'];
    }
    for (const key of ['runTests', 'reviewCode', 'primeReviewers', 'concurrentTests', 'offerMerge', 'typos'] as const) {
      if (workflow[key] === undefined) continue;
      if (typeof workflow[key] !== 'boolean') {
        throw new RelayError(`config.workflow.${key} must be a boolean.`, { code: 'BAD_CONFIG' });
      }
      config.workflow[key] = workflow[key];
    }
    config.workflow.maxTransientRetries = readBoundedInt(
      workflow['maxTransientRetries'],
      config.workflow.maxTransientRetries,
      'workflow.maxTransientRetries',
      { min: 0, max: 5 },
    );
    for (const key of ['maxCostUsd', 'confirmAboveUsd'] as const) {
      if (workflow[key] === undefined) continue;
      config.workflow[key] = readMoney(workflow[key], `workflow.${key}`);
    }
  }

  // Legacy workflow delivery keys remain readable. Explicit github values
  // below take precedence, which makes migration deterministic.
  if (isRecord(workflow) && workflow['deliver'] !== undefined) {
    const policy = workflow['deliver'] as DeliveryPolicy;
    config.github.autoPush = ['push', 'pr', 'merge'].includes(policy);
    config.github.autoPr = ['pr', 'merge'].includes(policy);
    config.github.autoMerge = policy === 'merge';
  }
  if (isRecord(workflow) && workflow['mergeMethod'] !== undefined) {
    config.github.mergeMethod = workflow['mergeMethod'] as MergeMethod;
  }

  const github = raw['github'];
  if (github !== undefined) {
    if (!isRecord(github)) throw new RelayError('config.github must be an object.', { code: 'BAD_CONFIG' });
    for (const key of ['autoPush', 'autoPr', 'autoMerge', 'deleteBranchOnMerge'] as const) {
      if (github[key] === undefined) continue;
      if (typeof github[key] !== 'boolean') {
        throw new RelayError(`config.github.${key} must be a boolean.`, { code: 'BAD_CONFIG' });
      }
      config.github[key] = github[key];
    }
    if (github['mergeMethod'] !== undefined) {
      if (!isMergeMethod(github['mergeMethod'])) {
        throw new RelayError(`config.github.mergeMethod must be one of ${MERGE_METHODS.join(' | ')}.`, { code: 'BAD_CONFIG' });
      }
      config.github.mergeMethod = github['mergeMethod'];
    }
    if (github['protectedBranches'] !== undefined) {
      const branches = github['protectedBranches'];
      if (!Array.isArray(branches) || branches.some((branch) => typeof branch !== 'string' || branch.length === 0)) {
        throw new RelayError('config.github.protectedBranches must be an array of non-empty strings.', { code: 'BAD_CONFIG' });
      }
      config.github.protectedBranches = branches as string[];
    }
  }

  const timeouts = raw['timeouts'];
  if (timeouts !== undefined) {
    if (!isRecord(timeouts)) throw new RelayError('config.timeouts must be an object.', { code: 'BAD_CONFIG' });
    for (const key of ['planningMs', 'reviewMs', 'implementationMs', 'testsMs', 'primingMs', 'primeGraceMs'] as const) {
      config.timeouts[key] = readBoundedInt(timeouts[key], config.timeouts[key], `timeouts.${key}`, {
        min: key === 'primeGraceMs' ? 0 : 1_000,
        max: 24 * 60 * 60_000,
      });
    }
  }

  const tests = raw['tests'];
  if (tests !== undefined) {
    if (!isRecord(tests)) throw new RelayError('config.tests must be an object.', { code: 'BAD_CONFIG' });
    const command = tests['command'];
    if (command !== undefined && command !== null) {
      if (!Array.isArray(command) || command.some((part) => typeof part !== 'string') || command.length === 0) {
        throw new RelayError('config.tests.command must be a non-empty array of strings, e.g. ["npm", "test"].', {
          code: 'BAD_CONFIG',
        });
      }
      config.tests.command = command as string[];
    } else if (command === null) {
      config.tests.command = null;
    }
  }

  const tracking = raw['tracking'];
  if (tracking !== undefined) {
    if (!isRecord(tracking)) throw new RelayError('config.tracking must be an object.', { code: 'BAD_CONFIG' });
    for (const key of ['enabled', 'includeAgentPhases'] as const) {
      if (tracking[key] === undefined) continue;
      if (typeof tracking[key] !== 'boolean') {
        throw new RelayError(`config.tracking.${key} must be a boolean.`, { code: 'BAD_CONFIG' });
      }
      config.tracking[key] = tracking[key];
    }
    if (tracking['plugin'] !== undefined) {
      if (typeof tracking['plugin'] !== 'string' || tracking['plugin'].trim().length === 0) {
        throw new RelayError('config.tracking.plugin must be a non-empty string.', { code: 'BAD_CONFIG' });
      }
      config.tracking.plugin = tracking['plugin'];
    }
    if (tracking['project'] !== undefined) {
      if (tracking['project'] !== null && typeof tracking['project'] !== 'string') {
        throw new RelayError('config.tracking.project must be a string or null.', { code: 'BAD_CONFIG' });
      }
      config.tracking.project = tracking['project'] as string | null;
    }
  }

  const delivery = raw['delivery'];
  if (delivery !== undefined) {
    if (!isRecord(delivery)) throw new RelayError('config.delivery must be an object.', { code: 'BAD_CONFIG' });
    if (delivery['comment'] !== undefined) {
      if (typeof delivery['comment'] !== 'boolean') {
        throw new RelayError('config.delivery.comment must be a boolean.', { code: 'BAD_CONFIG' });
      }
      config.delivery.comment = delivery['comment'];
    }
  }

  const notify = raw['notify'];
  if (notify !== undefined) {
    if (!isRecord(notify)) throw new RelayError('config.notify must be an object.', { code: 'BAD_CONFIG' });
    if (notify['webhook'] !== undefined) {
      const webhook = notify['webhook'];
      if (webhook !== null && (typeof webhook !== 'string' || !/^https?:\/\/\S+$/i.test(webhook))) {
        throw new RelayError('config.notify.webhook must be a non-empty http(s) URL or null.', { code: 'BAD_CONFIG' });
      }
      config.notify.webhook = webhook as string | null;
    }
  }

  return config;
}

/**
 * A dollar amount, or `null` for "no limit". Zero and negatives are rejected
 * rather than read as "never spend anything": a run that cannot take a single
 * turn is a configuration mistake, not a budget.
 */
function readMoney(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new RelayError(`config.${label} must be a positive number of US dollars, or null for no limit.`, {
      code: 'BAD_CONFIG',
    });
  }
  return value;
}

function readBoundedInt(
  value: unknown,
  fallback: number,
  label: string,
  bounds: { min: number; max: number },
): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new RelayError(`config.${label} must be an integer.`, { code: 'BAD_CONFIG' });
  }
  if (value < bounds.min || value > bounds.max) {
    throw new RelayError(`config.${label} must be between ${bounds.min} and ${bounds.max}.`, { code: 'BAD_CONFIG' });
  }
  return value;
}
