import { join } from 'node:path';

import { RelayError } from '../util/errors.ts';
import { readJsonFile, atomicWriteJson } from './atomic.ts';

export const AGENT_PROVIDERS = ['claude', 'codex'] as const;
export type AgentProvider = (typeof AGENT_PROVIDERS)[number];

export const ROLES = ['planner', 'planReviewer', 'implementer', 'codeReviewer'] as const;
export type Role = (typeof ROLES)[number];

export interface RelayConfig {
  version: 1;
  agents: Record<Role, AgentProvider>;
  models: Partial<Record<AgentProvider, string>>;
  workflow: {
    maxPlanReviewRounds: number;
    maxCodeReviewRounds: number;
    /** Branch to base worktrees on. Empty means "use the repository default". */
    baseBranch: string;
    branchPrefix: string;
    runTests: boolean;
  };
  timeouts: {
    planningMs: number;
    reviewMs: number;
    implementationMs: number;
    testsMs: number;
  };
  tests: {
    /** Overrides discovery entirely, e.g. `["npm", "test"]`. */
    command: string[] | null;
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
    maxPlanReviewRounds: 3,
    maxCodeReviewRounds: 2,
    baseBranch: '',
    branchPrefix: 'relay',
    runTests: true,
  },
  timeouts: {
    planningMs: 20 * 60_000,
    reviewMs: 20 * 60_000,
    implementationMs: 45 * 60_000,
    testsMs: 15 * 60_000,
  },
  tests: {
    command: null,
  },
};

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
  const raw = await readJsonFile<unknown>(configPath(repoRoot));
  if (raw === undefined) return structuredClone(DEFAULT_CONFIG);
  return mergeConfig(DEFAULT_CONFIG, raw);
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
      if (typeof provider !== 'string' || !(AGENT_PROVIDERS as readonly string[]).includes(provider)) {
        throw new RelayError(
          `Unknown agent "${String(provider)}" for role "${role}". Valid agents: ${AGENT_PROVIDERS.join(', ')}.`,
          { code: 'BAD_CONFIG' },
        );
      }
      config.agents[role as Role] = provider as AgentProvider;
    }
  }

  const models = raw['models'];
  if (models !== undefined) {
    if (!isRecord(models)) throw new RelayError('config.models must be an object.', { code: 'BAD_CONFIG' });
    for (const [provider, model] of Object.entries(models)) {
      if (!(AGENT_PROVIDERS as readonly string[]).includes(provider)) {
        throw new RelayError(`Unknown agent "${provider}" in config.models.`, { code: 'BAD_CONFIG' });
      }
      if (typeof model !== 'string') {
        throw new RelayError(`config.models.${provider} must be a string.`, { code: 'BAD_CONFIG' });
      }
      config.models[provider as AgentProvider] = model;
    }
  }

  const workflow = raw['workflow'];
  if (workflow !== undefined) {
    if (!isRecord(workflow)) throw new RelayError('config.workflow must be an object.', { code: 'BAD_CONFIG' });
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
    if (workflow['branchPrefix'] !== undefined) {
      if (typeof workflow['branchPrefix'] !== 'string' || workflow['branchPrefix'].length === 0) {
        throw new RelayError('config.workflow.branchPrefix must be a non-empty string.', { code: 'BAD_CONFIG' });
      }
      config.workflow.branchPrefix = workflow['branchPrefix'];
    }
    if (workflow['runTests'] !== undefined) {
      if (typeof workflow['runTests'] !== 'boolean') {
        throw new RelayError('config.workflow.runTests must be a boolean.', { code: 'BAD_CONFIG' });
      }
      config.workflow.runTests = workflow['runTests'];
    }
  }

  const timeouts = raw['timeouts'];
  if (timeouts !== undefined) {
    if (!isRecord(timeouts)) throw new RelayError('config.timeouts must be an object.', { code: 'BAD_CONFIG' });
    for (const key of ['planningMs', 'reviewMs', 'implementationMs', 'testsMs'] as const) {
      config.timeouts[key] = readBoundedInt(timeouts[key], config.timeouts[key], `timeouts.${key}`, {
        min: 1_000,
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

  return config;
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
