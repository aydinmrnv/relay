import type { RelayConfig } from '../storage/config.ts';
import type { RunJson } from './runJson.ts';

/**
 * The machine-readable shapes of the two commands that describe a repository
 * rather than a run: the home screen, and `relay init`.
 *
 * Both answer the same question in different tenses — what is Relay set up to
 * do here — so they share a config projection rather than each inventing one.
 */

export interface ConfigJson {
  agents: { planner: string; planReviewer: string; implementer: string; codeReviewer: string };
  workflow: {
    plan: string;
    reviewCode: boolean;
    runTests: boolean;
    maxPlanReviewRounds: number;
    maxCodeReviewRounds: number;
    deliver: string;
    baseBranch: string | null;
  };
  /** `null` means "discovered per run", which is not the same as "none". */
  tests: { command: string[] | null };
}

export function configToJson(config: RelayConfig): ConfigJson {
  return {
    agents: {
      planner: config.agents.planner,
      planReviewer: config.agents.planReviewer,
      implementer: config.agents.implementer,
      codeReviewer: config.agents.codeReviewer,
    },
    workflow: {
      plan: config.workflow.plan,
      reviewCode: config.workflow.reviewCode,
      runTests: config.workflow.runTests,
      maxPlanReviewRounds: config.workflow.maxPlanReviewRounds,
      maxCodeReviewRounds: config.workflow.maxCodeReviewRounds,
      deliver: config.workflow.deliver,
      // An empty string means "whatever the repository's default is at run
      // time"; `null` says that without a consumer having to know the trick.
      baseBranch: config.workflow.baseBranch.length > 0 ? config.workflow.baseBranch : null,
    },
    tests: { command: config.tests.command },
  };
}

export interface RepositoryJson {
  root: string;
  owner: string | null;
  name: string | null;
  /** `owner/name` when there is a GitHub remote, `null` when there is not. */
  slug: string | null;
  defaultBranch: string;
}

export interface HomeJson {
  repository: RepositoryJson;
  /** Whether `.relay/config.json` exists. The config below is the effective one either way. */
  configured: boolean;
  config: ConfigJson;
  /** The most recent runs, newest first — the same ones the screen lists. */
  runs: RunJson[];
  /** The one command the screen suggests, so a wrapper can suggest the same one. */
  next: string;
}

export interface InitJson {
  repository: RepositoryJson;
  /** Absolute path of the config that was written, or would have been. */
  configPath: string;
  written: boolean;
  config: ConfigJson;
  /** The test command discovery found, and why, when the config leaves it open. */
  tests: { discovered: boolean; command: string[] | null; reason: string };
  agents: Array<{ name: string; label: string; available: boolean; detail: string }>;
}
