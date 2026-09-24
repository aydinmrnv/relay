import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

import { AGENT_PROVIDERS } from '../agents/index.ts';
import { parseHarnessesConfig, type HarnessConfig } from '../agents/configHarness.ts';
import { MERGE_METHODS, type MergeMethod } from '../github/pullRequest.ts';
import {
  applyReviewLevel,
  isReviewLevel,
  levelOf,
  profileFor,
  REVIEW_LEVELS,
  type ReviewLevel,
  type ReviewProfile,
} from '../reviews/level.ts';
import { RelayError } from '../util/errors.ts';
import { atomicWriteJson } from './atomic.ts';

export { AGENT_PROVIDERS, REVIEW_LEVELS, type ReviewLevel };

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

/**
 * How far a run nobody asked for may carry its own work.
 *
 * It is `DELIVERY_POLICIES` with `merge` removed, and the removal is the point:
 * an autonomous merge is the one thing this project exists not to do, so the
 * ceiling on unattended delivery is a type that cannot spell it rather than a
 * comparison somebody has to remember to write.
 */
export const UNATTENDED_POLICIES = ['none', 'branch', 'push', 'pr'] as const;
export type UnattendedPolicy = (typeof UNATTENDED_POLICIES)[number];

export function isUnattendedPolicy(value: unknown): value is UnattendedPolicy {
  return typeof value === 'string' && (UNATTENDED_POLICIES as readonly string[]).includes(value);
}

export { MERGE_METHODS, type MergeMethod };

function isMergeMethod(value: unknown): value is MergeMethod {
  return typeof value === 'string' && (MERGE_METHODS as readonly string[]).includes(value);
}

export const ISSUE_TRACKERS = ['github', 'linear'] as const;
export type IssueTrackerName = (typeof ISSUE_TRACKERS)[number];
export const WEBHOOK_FORMATS = ['auto', 'json', 'slack', 'discord', 'teams'] as const;
export type WebhookFormat = (typeof WEBHOOK_FORMATS)[number];

export interface RelayConfig {
  version: 1;
  /**
   * User-defined coding CLIs, keyed by the name roles refer to them by. Parsed
   * before `agents`, because a role may name one. See `HarnessConfig` for the
   * deliberately narrow shape. Absent in configs written before it existed, so
   * readers go through `configHarnesses()` rather than the key.
   */
  harnesses: Record<string, HarnessConfig>;
  agents: Record<Role, AgentProvider>;
  /**
   * Model overrides, keyed by role (`codeReviewer`) or by provider (`claude`).
   * A role key wins, which is what lets a review run on a faster model than the
   * turn it is reviewing even when both are the same CLI.
   */
  models: Partial<Record<AgentProvider | Role, string>>;
  workflow: {
    maxConcurrentRuns: number;
    /**
     * How hard the agents are asked to look, as one word.
     *
     * The level owns `plan`, `reviewCode` and both round counts — setting it is
     * setting all four — and it alone decides the severity at which a finding
     * comes back to the implementer. Any of those keys may still be written
     * underneath it, and an explicit key always wins: the level is a starting
     * point that a repository is allowed to tune, not a lock.
     */
    review: ReviewLevel;
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
    /**
     * The label that starts a run with nobody present.
     *
     * Read by `relay serve` and by the GitHub Action, and by nothing else: an
     * attended `relay run` never consults it. It is deliberately a name with a
     * colon in it — a label nobody applies by reflex — because applying it is
     * the whole authorisation gesture, and the guardrails in `unattended` are
     * what decide whether the gesture counts.
     */
    triggerLabel: string;
  };
  /**
   * Runs that begin without a person: `relay serve` watching for the trigger
   * label, and the GitHub Action doing the same thing on `issues.labeled`.
   *
   * Every key here is a guardrail, and none of them has a permissive default. A
   * public repository where any drive-by can start a paid agent run by typing a
   * label is a funded denial-of-wallet attack, so the shipped configuration
   * cannot start anything at all: the switch is off, the allowlist is empty and
   * both budgets are unset. `relay serve` refuses to run until somebody has
   * answered all three deliberately.
   */
  unattended: {
    /**
     * The master switch, and one third of the kill switch. Re-read on every
     * poll rather than captured at startup, so flipping it to `false` stops a
     * running server from starting anything more.
     */
    enabled: boolean;
    /** Logins that may start a run by labelling. Empty means nobody may. */
    authors: string[];
    /** `org/team` slugs whose members may. Empty means no team does. */
    teams: string[];
    /**
     * Dollars unattended runs may report in one UTC day, across the whole
     * repository. Reached means stop starting runs and say so — never queue
     * them for tomorrow, which is the same spend with a delay in front of it.
     */
    maxDailyCostUsd: number | null;
    /** Dollars any one unattended run may report before it stops itself. */
    maxRunCostUsd: number | null;
    /** Seconds between polls of the tracker. */
    pollSeconds: number;
    /**
     * How far an unattended run delivers. Capped at `pr` by its type: nothing
     * merges without a person, whatever `workflow.deliver` says.
     */
    deliver: UnattendedPolicy;
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
  delivery: {
    comment: boolean;
    /**
     * Paths `--allow-secret` let through the pre-publish secret scan. Set per
     * invocation by the flag, never from `.relay/config.json`: a standing
     * allowance belongs in `.relay/secretsignore`, where it is reviewable.
     */
    allowSecrets?: string[];
  };
  issues: {
    /**
     * Where a bare reference like `142` is looked up. `ENG-142` and a
     * linear.app URL reach Linear whatever this says, and `owner/repo#142`
     * reaches GitHub.
     */
    provider: IssueTrackerName;
    /** Linear's default team key (`ENG`), so `relay run 142` means `ENG-142`. */
    team: string | null;
  };
  notify: {
    webhook: string | null;
    /**
     * The body the webhook receives. `auto` recognises Slack, Discord and
     * Microsoft Teams URLs and sends each the message shape it renders; any
     * other URL gets Relay's JSON document.
     */
    webhookFormat: WebhookFormat;
    bell: boolean;
    system: boolean;
    command: string[] | null;
  };
  tracking: {
    enabled: boolean;
    plugin: string;
    project: string | null;
    includeAgentPhases: boolean;
  };
  retention: { artifactDays: number };
}

/**
 * Defaults follow the brief: Claude plans (it reads a codebase well), Codex
 * implements inside its sandbox, and each agent reviews the other's work so
 * neither grades its own homework.
 */
export const DEFAULT_CONFIG: RelayConfig = {
  version: 1,
  harnesses: {},
  agents: {
    planner: 'claude',
    planReviewer: 'codex',
    implementer: 'codex',
    codeReviewer: 'claude',
  },
  models: {},
  workflow: {
    maxConcurrentRuns: 1,
    review: 'standard',
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
    triggerLabel: 'relay:go',
  },
  unattended: {
    enabled: false,
    authors: [],
    teams: [],
    maxDailyCostUsd: null,
    maxRunCostUsd: null,
    pollSeconds: 60,
    deliver: 'pr',
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
  issues: { provider: 'github', team: null },
  notify: { webhook: null, webhookFormat: 'auto', bell: false, system: false, command: null },
  tracking: {
    enabled: false,
    plugin: 'relay/<version> relay-wakatime/<version>',
    project: null,
    includeAgentPhases: true,
  },
  retention: { artifactDays: 30 },
};

/** Old run snapshots predate this outward-facing opt-in. */
export function commentsIssue(config: RelayConfig): boolean {
  return config.delivery?.comment === true;
}

/**
 * The config's user-defined harnesses. Read through a function because a run
 * snapshot recorded before the key existed has no `harnesses` at all.
 */
export function configHarnesses(config: RelayConfig): Record<string, HarnessConfig> {
  return config.harnesses ?? {};
}

/** The roles that must run read-only, because they judge the others' work. */
export const REVIEW_ROLES = ['planReviewer', 'codeReviewer'] as const;

/**
 * Refuses a reviewer that cannot be confined.
 *
 * A config-defined harness without `readOnly` flags is perfectly usable for
 * implementation — but a reviewer that can edit the code it is reviewing
 * breaks the guarantee the whole workflow rests on, so the assignment is
 * refused here, loudly, rather than silently run unenforced. Called at config
 * load and again after `--planner`/`--implementer` flags reshuffle the roles.
 */
export function assertReviewRolesEnforceable(config: RelayConfig): void {
  for (const role of REVIEW_ROLES) {
    const provider = config.agents[role];
    const def = configHarnesses(config)[provider];
    if (def === undefined || def.readOnly !== undefined) continue;
    throw new RelayError(
      `Agent "${provider}" cannot be the ${role}: it is a config-defined harness with no "readOnly" flags, ` +
        `and a reviewer that can edit the code it reviews breaks the guarantee reviews rest on. ` +
        `Add "readOnly" to harnesses.${provider} in .relay/config.json, or give the ${role} role to a shipped agent (${AGENT_PROVIDERS.join(', ')}).`,
      { code: 'BAD_CONFIG' },
    );
  }
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

/**
 * The review profile a run is judged by, read from the run's own config
 * snapshot — so a run started at `thorough` keeps being judged at `thorough`
 * even if the repository's default changes underneath it.
 *
 * A snapshot recorded before levels existed has no `review` key and gets the
 * level its round counts describe, which is `standard` for every run that took
 * the defaults.
 */
export function reviewProfileOf(config: RelayConfig): ReviewProfile {
  return profileFor(config.workflow);
}

/** The level name for a config, including whether its keys were tuned past it. */
export function reviewLevelOf(config: RelayConfig): ReviewLevel {
  return config.workflow.review ?? levelOf(config.workflow) ?? 'standard';
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

/**
 * A config file layered over the repository's for one invocation. `relay
 * connect` sets it on the `relay run` it starts for the studio, so a workflow
 * can shape a run without rewriting the repository's committed config.
 */
export const CONFIG_OVERLAY_VARIABLE = 'RELAY_CONFIG_OVERLAY';

let overlayPath: string | undefined;

/** Layers a config file over the repository's for the rest of this process; `undefined` removes it. */
export function setConfigOverlay(path: string | undefined): void {
  overlayPath = path === undefined || path.length === 0 ? undefined : path;
}

/**
 * Takes `RELAY_CONFIG_OVERLAY` out of the environment and into this process.
 * Out, because everything a run spawns inherits the environment — the agents,
 * the repository's own test suite, which may well run Relay — and a shape meant
 * for this one run must not become theirs.
 */
export function adoptConfigOverlay(env: NodeJS.ProcessEnv = process.env): void {
  const path = env[CONFIG_OVERLAY_VARIABLE];
  delete env[CONFIG_OVERLAY_VARIABLE];
  if (path !== undefined && path.length > 0) setConfigOverlay(path);
}

/** Loads repository config, falling back to defaults when absent. */
export async function loadConfig(repoRoot: string): Promise<RelayConfig> {
  const config = await readConfigFile(configPath(repoRoot), DEFAULT_CONFIG);
  return overlayPath === undefined ? config : readConfigFile(overlayPath, config, { required: true });
}

async function readConfigFile(path: string, base: RelayConfig, options: { required?: boolean } = {}): Promise<RelayConfig> {
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch (error) {
    // A missing repository config means defaults. A missing overlay means the
    // caller asked for a shape it will not get, which is not the same thing.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && options.required !== true) return structuredClone(base);
    throw error;
  }
  try {
    return mergeConfig(base, JSON.parse(contents) as unknown);
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

  // Parsed before `agents`: roles may name a harness this block defines, and a
  // name colliding with a shipped CLI or a role is refused inside the parser.
  const harnesses = raw['harnesses'];
  if (harnesses !== undefined) {
    config.harnesses = parseHarnessesConfig(harnesses, [...AGENT_PROVIDERS, ...ROLES]);
  }
  const knownProviders = [...AGENT_PROVIDERS, ...Object.keys(configHarnesses(config))];
  const isProvider = (value: unknown): value is string =>
    typeof value === 'string' && knownProviders.includes(value);

  const agents = raw['agents'];
  if (agents !== undefined) {
    if (!isRecord(agents)) throw new RelayError('config.agents must be an object.', { code: 'BAD_CONFIG' });
    for (const [role, provider] of Object.entries(agents)) {
      if (!(ROLES as readonly string[]).includes(role)) {
        throw new RelayError(`Unknown role "${role}" in config.agents. Valid roles: ${ROLES.join(', ')}.`, {
          code: 'BAD_CONFIG',
        });
      }
      if (!isProvider(provider)) {
        throw new RelayError(
          `Unknown agent "${String(provider)}" for role "${role}". Valid agents: ${knownProviders.join(', ')}.`,
          { code: 'BAD_CONFIG' },
        );
      }
      config.agents[role as Role] = provider;
    }
  }
  assertReviewRolesEnforceable(config);

  const models = raw['models'];
  if (models !== undefined) {
    if (!isRecord(models)) throw new RelayError('config.models must be an object.', { code: 'BAD_CONFIG' });
    for (const [key, model] of Object.entries(models)) {
      // A config-defined harness has no model flag in its schema, so a model
      // for it would be silently unused — refused rather than ignored.
      if (configHarnesses(config)[key] !== undefined) {
        throw new RelayError(
          `config.models.${key}: "${key}" is a config-defined harness, and its schema has no model flag to pass a model to. Remove this key.`,
          { code: 'BAD_CONFIG' },
        );
      }
      // A role key and a provider key are both legitimate: the first pins one
      // seat's model, the second pins every seat that CLI happens to fill.
      if (!isProvider(key) && !isRole(key)) {
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
    // Read first, and written before anything else in this block: the level
    // seeds four keys, and a repository that also names one of them by hand
    // means the hand-written one. Every read below overwrites what it seeded.
    if (workflow['review'] !== undefined) {
      if (!isReviewLevel(workflow['review'])) {
        throw new RelayError(`config.workflow.review must be one of ${REVIEW_LEVELS.join(' | ')}.`, {
          code: 'BAD_CONFIG',
        });
      }
      config.workflow.review = workflow['review'];
      applyReviewLevel(config.workflow, workflow['review']);
    }
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
    config.workflow.maxConcurrentRuns = readBoundedInt(
      workflow['maxConcurrentRuns'], config.workflow.maxConcurrentRuns, 'workflow.maxConcurrentRuns', { min: 1, max: 32 },
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
    if (workflow['triggerLabel'] !== undefined) {
      const label = workflow['triggerLabel'];
      if (typeof label !== 'string') {
        throw new RelayError('config.workflow.triggerLabel must be a string.', { code: 'BAD_CONFIG' });
      }
      // Trimmed rather than rejected for whitespace: a label pasted out of the
      // GitHub UI often carries some, and `" relay:go "` names the same label.
      // Empty is legitimate and means "no label starts anything here".
      config.workflow.triggerLabel = label.trim();
    }
  }

  const unattended = raw['unattended'];
  if (unattended !== undefined) {
    if (!isRecord(unattended)) throw new RelayError('config.unattended must be an object.', { code: 'BAD_CONFIG' });
    if (unattended['enabled'] !== undefined) {
      if (typeof unattended['enabled'] !== 'boolean') {
        throw new RelayError('config.unattended.enabled must be a boolean.', { code: 'BAD_CONFIG' });
      }
      config.unattended.enabled = unattended['enabled'];
    }
    if (unattended['authors'] !== undefined) {
      config.unattended.authors = readLogins(unattended['authors'], 'unattended.authors');
    }
    if (unattended['teams'] !== undefined) {
      const teams = readLogins(unattended['teams'], 'unattended.teams');
      for (const team of teams) {
        // `org/team` and nothing else: a bare name has no organisation to ask
        // about membership of, and guessing one would widen an allowlist.
        if (!/^[^/\s]+\/[^/\s]+$/.test(team)) {
          throw new RelayError(
            `config.unattended.teams: "${team}" must be an "org/team" slug, e.g. "acme/reviewers".`,
            { code: 'BAD_CONFIG' },
          );
        }
      }
      config.unattended.teams = teams;
    }
    for (const key of ['maxDailyCostUsd', 'maxRunCostUsd'] as const) {
      if (unattended[key] === undefined) continue;
      config.unattended[key] = readMoney(unattended[key], `unattended.${key}`);
    }
    config.unattended.pollSeconds = readBoundedInt(
      unattended['pollSeconds'], config.unattended.pollSeconds, 'unattended.pollSeconds', { min: 5, max: 3600 },
    );
    if (unattended['deliver'] !== undefined) {
      if (!isUnattendedPolicy(unattended['deliver'])) {
        // Naming `merge` here is the mistake worth its own sentence: it is not a
        // typo, it is somebody asking for the thing the ceiling exists to refuse.
        throw new RelayError(
          isDeliveryPolicy(unattended['deliver'])
            ? 'config.unattended.deliver cannot be "merge": a run nobody asked for never merges. ' +
              `Valid values: ${UNATTENDED_POLICIES.join(' | ')}.`
            : `config.unattended.deliver must be one of ${UNATTENDED_POLICIES.join(' | ')}.`,
          { code: 'BAD_CONFIG' },
        );
      }
      config.unattended.deliver = unattended['deliver'];
    }
  }

  const retention = raw['retention'];
  if (retention !== undefined) {
    if (!isRecord(retention)) throw new RelayError('config.retention must be an object.', { code: 'BAD_CONFIG' });
    config.retention.artifactDays = readBoundedInt(
      retention['artifactDays'], config.retention.artifactDays, 'retention.artifactDays', { min: 0, max: 3650 },
    );
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

  const issues = raw['issues'];
  if (issues !== undefined) {
    if (!isRecord(issues)) throw new RelayError('config.issues must be an object.', { code: 'BAD_CONFIG' });
    if (issues['provider'] !== undefined) {
      if (!ISSUE_TRACKERS.includes(issues['provider'] as IssueTrackerName)) {
        throw new RelayError(`config.issues.provider must be one of ${ISSUE_TRACKERS.join(' | ')}.`, { code: 'BAD_CONFIG' });
      }
      config.issues.provider = issues['provider'] as IssueTrackerName;
    }
    if (issues['team'] !== undefined) {
      const team = issues['team'];
      if (team !== null && (typeof team !== 'string' || !/^[A-Za-z][A-Za-z0-9]{0,9}$/.test(team))) {
        throw new RelayError('config.issues.team must be a Linear team key such as "ENG", or null.', { code: 'BAD_CONFIG' });
      }
      config.issues.team = team === null ? null : (team as string).toUpperCase();
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
    if (notify['webhookFormat'] !== undefined) {
      if (!WEBHOOK_FORMATS.includes(notify['webhookFormat'] as WebhookFormat)) {
        throw new RelayError(`config.notify.webhookFormat must be one of ${WEBHOOK_FORMATS.join(' | ')}.`, { code: 'BAD_CONFIG' });
      }
      config.notify.webhookFormat = notify['webhookFormat'] as WebhookFormat;
    }
    for (const key of ['bell', 'system'] as const) {
      if (notify[key] !== undefined) {
        if (typeof notify[key] !== 'boolean') throw new RelayError(`config.notify.${key} must be a boolean.`, { code: 'BAD_CONFIG' });
        config.notify[key] = notify[key];
      }
    }
    if (notify['command'] !== undefined) {
      const command = notify['command'];
      if (command !== null && (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== 'string'))) {
        throw new RelayError('config.notify.command must be a non-empty array of strings or null.', { code: 'BAD_CONFIG' });
      }
      config.notify.command = command as string[] | null;
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

/** A list of non-empty, whitespace-free names: logins, or `org/team` slugs. */
function readLogins(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.trim().length === 0)) {
    throw new RelayError(`config.${label} must be an array of non-empty strings.`, { code: 'BAD_CONFIG' });
  }
  return (value as string[]).map((entry) => entry.trim());
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
