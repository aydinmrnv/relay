import { AGENT_PROVIDERS, isAgentProvider } from '../../agents/index.ts';
import { createRunId, shortId } from '../../util/ids.ts';
import { RelayError } from '../../util/errors.ts';
import { parseIssueRef } from '../../github/provider.ts';
import { RunStore, resolveRun } from '../../storage/runs.ts';
import type { RelayConfig } from '../../storage/config.ts';
import { WorkflowEngine } from '../../workflow/engine.ts';
import { createRunState, type RunState } from '../../workflow/state.ts';
import { isTerminal } from '../../workflow/phases.ts';
import type { EngineContext } from '../../workflow/context.ts';
import { RunRenderer } from '../../ui/renderer.ts';
import { formatDuration } from '../../util/text.ts';
import { createCliContext, type CliContext } from '../context.ts';
import { dim, failure, out, success, warning } from '../output.ts';

export interface RunOptions {
  verbose?: boolean;
  base?: string;
  planner?: string;
  implementer?: string;
  maxPlanRounds?: string;
  maxCodeRounds?: string;
  tests?: boolean;
}

/** Applies `relay run` flags over the repository config for this run only. */
function applyOverrides(config: RelayConfig, options: RunOptions): RelayConfig {
  const merged: RelayConfig = structuredClone(config);

  if (options.base !== undefined) merged.workflow.baseBranch = options.base;
  if (options.tests === false) merged.workflow.runTests = false;

  if (options.planner !== undefined) {
    assertProvider(options.planner, '--planner');
    merged.agents.planner = options.planner;
    // Keeping the reviewer on the other model is the point of the workflow.
    merged.agents.codeReviewer = merged.agents.planner;
  }
  if (options.implementer !== undefined) {
    assertProvider(options.implementer, '--implementer');
    merged.agents.implementer = options.implementer;
    merged.agents.planReviewer = merged.agents.implementer;
  }

  if (options.maxPlanRounds !== undefined) {
    merged.workflow.maxPlanReviewRounds = parseRounds(options.maxPlanRounds, '--max-plan-rounds');
  }
  if (options.maxCodeRounds !== undefined) {
    merged.workflow.maxCodeReviewRounds = parseRounds(options.maxCodeRounds, '--max-code-rounds');
  }

  if (merged.agents.planner === merged.agents.planReviewer) {
    // Not fatal — the user may only have one CLI installed — but it removes the
    // cross-model critique that makes the workflow worth running.
    out(warning('Warning: the planner and plan reviewer are the same agent, so the plan is self-reviewed.'));
  }

  return merged;
}

function assertProvider(value: string, flag: string): void {
  if (!isAgentProvider(value)) {
    throw new RelayError(`${flag} must be one of ${AGENT_PROVIDERS.join(', ')} (got "${value}").`, { code: 'BAD_FLAG' });
  }
}

function parseRounds(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 10) {
    throw new RelayError(`${flag} must be an integer between 0 and 10.`, { code: 'BAD_FLAG' });
  }
  return parsed;
}

export async function runCommand(issueRef: string, options: RunOptions): Promise<number> {
  const cli = await createCliContext();

  // Fail on a malformed reference before creating any state on disk.
  parseIssueRef(issueRef);

  const config = applyOverrides(cli.config, options);
  const now = new Date();
  const state = createRunState({
    runId: createRunId(now),
    shortId: shortId(),
    issueRef,
    repository: {
      root: cli.repo.root,
      owner: cli.repo.owner,
      name: cli.repo.name,
      defaultBranch: cli.repo.defaultBranch,
    },
    config,
    now,
  });

  return executeRun(cli, state, options);
}

export async function resumeCommand(runRef: string, options: RunOptions): Promise<number> {
  const cli = await createCliContext();
  const previous = await resolveRun(cli.repo.root, runRef);

  if (isTerminal(previous.phase)) {
    if (previous.phase === 'COMPLETE') {
      out(`Run ${previous.runId} already completed.`);
      return 0;
    }
    // A failed or cancelled run resumes from the phase it died in, keeping its
    // worktree, sessions and review history.
    const retryFrom = previous.history.filter((entry) => entry.phase !== previous.phase).pop()?.phase;
    if (retryFrom === undefined) {
      throw new RelayError(`Run ${previous.runId} has no phase to resume from.`, { code: 'CANNOT_RESUME' });
    }
    out(dim(`Resuming ${previous.runId} from ${retryFrom} (was ${previous.phase}).`));
    previous.phase = retryFrom;
    delete previous.error;
    delete previous.finishedAt;
  } else {
    out(dim(`Resuming ${previous.runId} from ${previous.phase}.`));
  }

  return executeRun(cli, previous, options);
}

async function executeRun(cli: CliContext, state: RunState, options: RunOptions): Promise<number> {
  const store = new RunStore(state.repository.root, state.runId);
  const controller = new AbortController();

  const renderer = new RunRenderer({
    title: `Relay — ${state.issue === undefined ? `Issue ${state.issueRef}` : `Issue #${state.issue.number}`}`,
    subtitle: state.issue?.title ?? `run ${state.runId}`,
    agentNames: {
      planner: state.config.agents.planner,
      planReviewer: state.config.agents.planReviewer,
      implementer: state.config.agents.implementer,
      codeReviewer: state.config.agents.codeReviewer,
    },
    ...(options.verbose === true ? { verbose: true } : {}),
  });

  // Ctrl-C stops the agents and lets the engine record a CANCELLED run rather
  // than leaving state that claims a phase is still in flight.
  let interrupted = false;
  const onSigint = (): void => {
    if (interrupted) process.exit(130);
    interrupted = true;
    renderer.warn('Cancelling… (press Ctrl-C again to force quit)');
    controller.abort();
    void Promise.all(Object.values(cli.harnesses).map((harness) => harness.cancel()));
  };
  process.on('SIGINT', onSigint);

  renderer.start();

  const context: EngineContext = {
    state,
    store,
    harnesses: cli.harnesses,
    issueProvider: cli.issueProvider,
    observer: renderer,
    signal: controller.signal,
  };

  try {
    const finalState = await new WorkflowEngine(context).run();
    renderer.finish(finalState.phase);
    printOutcome(finalState, store);
    return finalState.phase === 'COMPLETE' ? 0 : finalState.phase === 'CANCELLED' ? 130 : 1;
  } finally {
    process.off('SIGINT', onSigint);
  }
}

function printOutcome(state: RunState, store: RunStore): void {
  const elapsed = new Date(state.finishedAt ?? state.updatedAt).getTime() - new Date(state.createdAt).getTime();

  out();
  if (state.phase === 'COMPLETE') {
    out(success('Run complete') + dim(` in ${formatDuration(elapsed)}`));
  } else if (state.phase === 'CANCELLED') {
    out(warning('Run cancelled') + dim(` after ${formatDuration(elapsed)}`));
  } else {
    out(failure('Run failed') + dim(` after ${formatDuration(elapsed)}`));
    if (state.error !== undefined) out(`  ${state.error.message}`);
  }

  out();
  if (state.workspace !== undefined) {
    out(`  Branch     ${state.workspace.branch}`);
    out(`  Worktree   ${state.workspace.path}`);
  }
  if (state.diff !== undefined) {
    out(`  Changes    ${state.diff.fileCount} file(s), +${state.diff.additions} −${state.diff.deletions}`);
  }
  if (state.tests !== undefined) {
    out(
      `  Tests      ${
        state.tests.discovered
          ? `${state.tests.command.join(' ')} → ${state.tests.passed ? success('passed') : failure('failed')}`
          : dim(`not run (${state.tests.skippedReason ?? state.tests.reason})`)
      }`,
    );
  }
  out(`  Reviews    plan ${state.rounds.planReview} round(s), code ${state.rounds.codeReview} round(s)`);
  out(`  Run state  ${store.dir}`);

  out();
  out(dim('Nothing was pushed or merged. To review:'));
  out(`  relay diff ${state.runId}`);
  out(`  ${store.path('summary.md')}`);
  out();
}
