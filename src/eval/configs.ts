/**
 * The configurations under test, and the comparisons they exist to settle.
 *
 * Every one of these is a design decision Relay currently takes on intuition:
 * two review rounds and not three, the plan reviewed by a different model,
 * `--fast` dropping the plan stage entirely. Each configuration below isolates
 * exactly one of them, so a result can name the decision it supports or refutes
 * rather than blessing the pipeline as a whole.
 */
import { DEFAULT_CONFIG, type AgentProvider, type RelayConfig } from '../storage/config.ts';
import { RelayError } from '../util/errors.ts';

/** The two seats a comparison swaps models between. */
export interface AgentPair {
  /** Fills `planner` and `codeReviewer` in the shipped default. */
  planner: AgentProvider;
  /** Fills `implementer` and `planReviewer` in the shipped default. */
  implementer: AgentProvider;
}

export const DEFAULT_AGENT_PAIR: AgentPair = {
  planner: DEFAULT_CONFIG.agents.planner,
  implementer: DEFAULT_CONFIG.agents.implementer,
};

/**
 * What every arm holds fixed.
 *
 * Delivery stops at a local commit: the eval measures the change a pipeline
 * produces, and pushing four hundred throwaway branches would measure nothing
 * except how patient a git remote is. Tests stay on, because the project's own
 * suite is feedback a real run gets and removing it would compare a pipeline
 * against a version of itself nobody ships.
 */
function evalBaseConfig(): RelayConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  config.workflow.deliver = 'branch';
  config.workflow.offerMerge = false;
  config.workflow.runTests = true;
  config.workflow.concurrentTests = true;
  config.workflow.primeReviewers = true;
  config.workflow.typos = false;
  config.github.autoPush = false;
  config.github.autoPr = false;
  config.github.autoMerge = false;
  return config;
}

function withAgents(config: RelayConfig, agents: RelayConfig['agents']): RelayConfig {
  config.agents = { ...agents };
  return config;
}

/** Every role on one CLI: the "one agent" arms. */
function soloAgents(provider: AgentProvider): RelayConfig['agents'] {
  return { planner: provider, planReviewer: provider, implementer: provider, codeReviewer: provider };
}

/** The shipped split: each artifact is judged by the model that did not write it. */
function crossAgents(pair: AgentPair): RelayConfig['agents'] {
  return {
    planner: pair.planner,
    planReviewer: pair.implementer,
    implementer: pair.implementer,
    codeReviewer: pair.planner,
  };
}

export interface EvalConfigSpec {
  name: string;
  /** What the arm does, in one line. */
  summary: string;
  /** The design decision it isolates. */
  question: string;
  build(pair: AgentPair): RelayConfig;
}

export const EVAL_CONFIGS: readonly EvalConfigSpec[] = [
  {
    name: 'solo',
    summary: 'One agent — the implementer model — plans and implements. No plan review, no code review.',
    question: 'Does a second agent help at all? This arm is exactly what `relay run --fast` produces.',
    build: (pair) => {
      const config = withAgents(evalBaseConfig(), soloAgents(pair.implementer));
      config.workflow.plan = 'inline';
      config.workflow.reviewCode = false;
      return config;
    },
  },
  {
    name: 'solo-planner',
    summary: 'One agent — the planner model — plans and implements. No plan review, no code review.',
    question: 'Is the single-agent baseline model-dependent, or is one agent one agent?',
    build: (pair) => {
      const config = withAgents(evalBaseConfig(), soloAgents(pair.planner));
      config.workflow.plan = 'inline';
      config.workflow.reviewCode = false;
      return config;
    },
  },
  {
    name: 'same-model',
    summary: 'The full pipeline with one model in all four seats: it reviews its own plan and its own diff.',
    question: 'Is the gain the second model, or just a second pass?',
    build: (pair) => withAgents(evalBaseConfig(), soloAgents(pair.planner)),
  },
  {
    name: 'cross-model',
    summary: 'The shipped default: each artifact is reviewed by the model that did not write it.',
    question: 'The baseline every other arm is measured against.',
    build: (pair) => withAgents(evalBaseConfig(), crossAgents(pair)),
  },
  {
    name: 'no-plan-review',
    summary: 'Cross-model, but the implementer writes its own plan inline. The code review still happens.',
    question: 'Does reviewing the plan earn the two-to-four serial turns it costs?',
    build: (pair) => {
      const config = withAgents(evalBaseConfig(), crossAgents(pair));
      config.workflow.plan = 'inline';
      return config;
    },
  },
  {
    name: 'code-rounds-1',
    summary: 'Cross-model with a single code-review round.',
    question: 'Is one code-review round enough?',
    build: (pair) => {
      const config = withAgents(evalBaseConfig(), crossAgents(pair));
      config.workflow.maxCodeReviewRounds = 1;
      return config;
    },
  },
  {
    name: 'code-rounds-3',
    summary: 'Cross-model with three code-review rounds.',
    question: 'Does a third round change anything the second did not?',
    build: (pair) => {
      const config = withAgents(evalBaseConfig(), crossAgents(pair));
      config.workflow.maxCodeReviewRounds = 3;
      return config;
    },
  },
];

export interface EvalComparison {
  name: string;
  question: string;
  /** Configuration names, baseline last. */
  configs: readonly string[];
}

/**
 * The five comparisons that answer the actual questions. Each names the arms it
 * needs, so `relay eval --compare code-rounds` cannot accidentally run a set
 * that does not settle anything.
 */
export const EVAL_COMPARISONS: readonly EvalComparison[] = [
  {
    name: 'second-agent',
    question: 'Does a second agent produce better changes than one agent alone?',
    configs: ['solo', 'solo-planner', 'cross-model'],
  },
  {
    name: 'second-model',
    question: 'Is the gain the second model, or just a second pass?',
    configs: ['same-model', 'cross-model'],
  },
  {
    name: 'plan-stage',
    question: 'Does reviewing the plan with a different model earn its turns?',
    configs: ['no-plan-review', 'cross-model'],
  },
  {
    name: 'review-depth',
    question: 'No review (`--fast`), code review only, or the full pipeline?',
    configs: ['solo', 'no-plan-review', 'cross-model'],
  },
  {
    name: 'code-rounds',
    question: 'Is two code-review rounds the right number?',
    configs: ['code-rounds-1', 'cross-model', 'code-rounds-3'],
  },
];

export const EVAL_CONFIG_NAMES: readonly string[] = EVAL_CONFIGS.map((spec) => spec.name);
export const EVAL_COMPARISON_NAMES: readonly string[] = EVAL_COMPARISONS.map((entry) => entry.name);

export function evalConfigSpec(name: string): EvalConfigSpec {
  const spec = EVAL_CONFIGS.find((entry) => entry.name === name);
  if (spec === undefined) {
    throw new RelayError(`Unknown eval configuration "${name}".`, {
      code: 'UNKNOWN_EVAL_CONFIG',
      hint: `Known configurations: ${EVAL_CONFIG_NAMES.join(', ')}.`,
    });
  }
  return spec;
}

export function evalComparison(name: string): EvalComparison {
  const comparison = EVAL_COMPARISONS.find((entry) => entry.name === name);
  if (comparison === undefined) {
    throw new RelayError(`Unknown eval comparison "${name}".`, {
      code: 'UNKNOWN_EVAL_COMPARISON',
      hint: `Known comparisons: ${EVAL_COMPARISON_NAMES.join(', ')}.`,
    });
  }
  return comparison;
}

export interface ResolvedEvalConfig {
  spec: EvalConfigSpec;
  config: RelayConfig;
}

/**
 * Builds the named arms against a pair of installed CLIs, in registry order.
 *
 * `models` is carried through from the repository's own config because the
 * harnesses were constructed with it: an arm whose config claimed the default
 * model while the CLI ran a pinned one would attach the result to the wrong
 * model version, which is the one way a published number goes quietly stale.
 */
export function resolveEvalConfigs(
  names: readonly string[],
  pair: AgentPair,
  models: RelayConfig['models'] = {},
): ResolvedEvalConfig[] {
  const wanted = new Set(names);
  return EVAL_CONFIGS.filter((spec) => wanted.has(spec.name)).map((spec) => {
    const config = spec.build(pair);
    config.models = structuredClone(models);
    return { spec, config };
  });
}

/** Every provider a set of arms will actually spawn. */
export function providersUsed(configs: readonly ResolvedEvalConfig[]): string[] {
  const providers = new Set<string>();
  for (const { config } of configs) {
    for (const provider of Object.values(config.agents)) providers.add(provider);
  }
  return [...providers].sort();
}
