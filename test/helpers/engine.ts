import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { AgentHarness } from '../../src/agents/types.ts';
import { DEFAULT_CONFIG, type RelayConfig } from '../../src/storage/config.ts';
import { RunStore } from '../../src/storage/runs.ts';
import { createRunId, shortId } from '../../src/util/ids.ts';
import type { EngineContext } from '../../src/workflow/context.ts';
import { RecordingObserver } from '../../src/workflow/observer.ts';
import { createRunState, type RunState } from '../../src/workflow/state.ts';
import { FakeAgentHarness, approveReview, planText, section } from './fakeHarness.ts';
import { FakeIssueProvider, type TempRepo } from './tempRepo.ts';

export interface Harness {
  claude: FakeAgentHarness;
  codex: FakeAgentHarness;
}

export interface BuildContextOptions {
  config?: Partial<RelayConfig['workflow']>;
  state?: RunState;
  signal?: AbortSignal;
  /** Collects the backoff delays a run would have waited out. */
  delays?: number[];
}

export interface BuiltContext {
  context: EngineContext;
  store: RunStore;
  observer: RecordingObserver;
  state: RunState;
}

/** Implementation side effect: writes a real file so `git diff` is non-empty. */
export function writesFile(name: string, contents: string) {
  return async (cwd: string): Promise<void> => {
    await writeFile(join(cwd, name), contents, 'utf8');
  };
}

export function buildEngineContext(repo: TempRepo, harnesses: Harness, options: BuildContextOptions = {}): BuiltContext {
  const config = structuredClone(DEFAULT_CONFIG);
  Object.assign(config.workflow, options.config ?? {});

  const state =
    options.state ??
    createRunState({
      runId: createRunId(new Date()),
      shortId: shortId(),
      issueRef: '142',
      repository: { root: repo.root, owner: 'acme', name: 'widgets', defaultBranch: 'main' },
      config,
    });

  const store = new RunStore(repo.root, state.runId);
  const observer = new RecordingObserver();

  const context: EngineContext = {
    state,
    store,
    harnesses: harnesses as unknown as Record<'claude' | 'codex', AgentHarness>,
    issueProvider: new FakeIssueProvider(),
    observer,
    signal: options.signal ?? new AbortController().signal,
    // Backoff is recorded rather than waited on: the delay is the unit's
    // business, and a test should not spend seconds proving it happened.
    sleep: async (ms: number) => {
      options.delays?.push(ms);
    },
  };

  return { context, store, observer, state };
}

/** Agents scripted for a clean run: plan approved first time, code approved first time. */
export function happyPathHarnesses(): Harness {
  return {
    claude: new FakeAgentHarness('claude', {
      planner: [{ text: planText() }],
      codeReviewer: [{ text: approveReview('Implementation matches the plan.') }],
    }),
    codex: new FakeAgentHarness('codex', {
      planReviewer: [{ text: approveReview('Plan is sound.') }],
      implementer: [
        {
          text: section('NOTES', 'Edited src/app.ts'),
          effect: writesFile('src/app.ts', 'export const value = 2;\n'),
        },
      ],
    }),
  };
}
