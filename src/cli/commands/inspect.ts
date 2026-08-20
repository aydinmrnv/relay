import { readFile } from 'node:fs/promises';

import { RelayError } from '../../util/errors.ts';
import { formatDuration, oneLine } from '../../util/text.ts';
import { snapshotDiff, formatDiffStat, formatFileList } from '../../git/diff.ts';
import { describeLanding, type Landing } from '../../git/commit.ts';
import { issueHeadline } from '../../issues/identity.ts';
import { worktreeExists } from '../../git/worktree.ts';
import { listRuns, resolveRun, RunStore, RUN_FILES } from '../../storage/runs.ts';
import { PHASES, isTerminal, phaseLabel } from '../../workflow/phases.ts';
import { transition, type RunState } from '../../workflow/state.ts';
import { pidAlive } from '../../workflow/admission.ts';
import { formatUsage } from '../../workflow/usage.ts';
import { runLiveness } from '../../workflow/liveness.ts';
import { replayEvents } from '../../workflow/replay.ts';
import { rendererFor } from './run.ts';
import { createCliContext } from '../context.ts';
import { runToJson } from '../runJson.ts';
import { EXIT, exitCodeForRun } from '../exit.ts';
import { emitJson, emitJsonLine } from '../json.ts';
import { diffToJson, eventToJson, logsToJson, planToJson, stopToJson, storedDiffToJson } from '../inspectJson.ts';
import { panelInnerWidth } from '../../ui/box.ts';
import { visibleWidth } from '../../ui/theme.ts';
import {
  box,
  changeCount,
  dim,
  emptyState,
  facts,
  failure,
  gridLines,
  heading,
  hint,
  out,
  raw,
  rows,
  success,
  warning,
  width,
} from '../output.ts';

export interface StatusOptions {
  json?: boolean;
}

export async function statusCommand(runRef?: string, options: StatusOptions = {}): Promise<number> {
  const cli = await createCliContext();

  if (options.json === true) return printStatusJson(cli.repo.root, runRef);

  if (runRef !== undefined) {
    const state = await resolveRun(cli.repo.root, runRef);
    const store = new RunStore(cli.repo.root, state.runId);

    // A finished run has a summary worth reading in full. An in-progress one
    // does not yet, so report live state rather than a bare phase name.
    const summary = isTerminal(state.phase) ? await store.readArtifact(RUN_FILES.summary) : undefined;
    if (summary !== undefined) {
      out(summary.trimEnd());
      await printLanding(cli.repo.root, state);
      return 0;
    }

    await printLiveStatus(state, store);
    return 0;
  }

  const runs = await listRuns(cli.repo.root);
  if (runs.length === 0) {
    emptyState('No runs yet. A run plans, reviews, implements and tests one GitHub issue.', [
      'relay run <issue-number>',
      'relay doctor              # check that your agents are ready first',
    ]);
    return 0;
  }

  const shown = runs.slice(0, 20);
  const listed = await Promise.all(
    shown.map(async (state) => {
      const elapsed = runDuration(state);
      const issue = state.issue === undefined ? state.issueRef : issueHeadline(state.issue);
      const landing = await landingOf(cli.repo.root, state);

      return {
        cells: [state.runId, phaseTag(state), oneLine(issue, 48)] as const,
        // `unlanded` rides the detail line rather than the title row. It is a
        // warning, and the title row is the one that has to absorb a long issue
        // title — putting them together makes the warning the first thing a
        // narrow terminal clips, which is exactly backwards.
        facts: facts([
          state.phase === 'QUEUED' ? 'waiting to start' : !isTerminal(state.phase) ? (pidAlive(state.pid) ? 'running' : warning('interrupted')) : false,
          state.workspace?.branch ?? '(no branch)',
          formatDuration(elapsed),
          `plan ${state.rounds.planReview}r, code ${state.rounds.codeReview}r`,
          state.diff !== undefined && changeCount(state.diff.additions, state.diff.deletions),
          state.commit !== undefined && `committed ${state.commit.sha.slice(0, 8)}`,
          landing === 'unlanded' && warning('unlanded'),
          runLiveness(state) === 'stale' && warning('stale'),
        ]),
      };
    }),
  );

  // The aligned row and its dim detail line are interleaved after alignment, so
  // the run id, phase and issue still line up down the column while each run
  // keeps the second line that carries its branch, duration and diff.
  //
  // The issue column is capped at whatever the frame has left after the two
  // fixed columns, so the table clips the title itself — deliberately, with an
  // ellipsis — instead of letting the panel shear the end off the row.
  const fixed = Math.max(
    ...listed.map((entry) => visibleWidth(entry.cells[0]) + visibleWidth(entry.cells[1])),
  );
  const aligned = gridLines(
    [{ header: '' }, { header: '' }, { header: '', max: Math.max(24, panelInnerWidth(width()) - fixed - 4) }],
    listed.map((entry) => entry.cells),
  );
  const body = aligned.flatMap((line, index) => [line, dim(`  ${listed[index]?.facts ?? ''}`)]);

  box({
    title: `Relay runs in ${cli.repo.root}`,
    badge: `${runs.length} run${runs.length === 1 ? '' : 's'}`,
    body,
    footer: [
      dim(
        runs.length > shown.length
          ? `… and ${runs.length - shown.length} older run(s)   ·   relay status <run>`
          : 'relay status <run>   ·   relay diff <run>',
      ),
    ],
  });
  return 0;
}

/** A run's phase, coloured by what that phase means for the reader. */
export function phaseTag(state: RunState): string {
  if (runLiveness(state) === 'stale') return warning('stale');
  const label = phaseLabel(state.phase);
  if (state.phase === 'COMPLETE') return success(label);
  if (state.phase === 'FAILED') return failure(label);
  return isTerminal(state.phase) ? warning(label) : label;
}

/**
 * Machine-readable status. One `run` for a named run, the whole `runs` list
 * otherwise — unabridged, unlike the human table, since a script should not
 * have to page. Colour never reaches this path: the payload is serialized
 * straight from state.
 */
async function printStatusJson(repoRoot: string, runRef: string | undefined): Promise<number> {
  if (runRef !== undefined) {
    const state = await resolveRun(repoRoot, runRef);
    emitJson('status', { run: runToJson(state, { landing: await landingOf(repoRoot, state) }) });
    return EXIT.success;
  }

  const runs = await listRuns(repoRoot);
  const payload = await Promise.all(
    runs.map(async (state) => runToJson(state, { landing: await landingOf(repoRoot, state) })),
  );
  emitJson('status', { runs: payload });
  return EXIT.success;
}

/**
 * Where a completed run's work actually is. Relay leaves a staged index behind
 * unless `--commit` was used, and a staged index is one `git worktree prune`
 * away from being gone — so the answer is read from git rather than assumed.
 */
export async function landingOf(repoRoot: string, state: RunState): Promise<Landing> {
  const workspace = state.workspace;
  if (state.phase !== 'COMPLETE' || workspace === undefined) return 'unknown';

  return describeLanding(repoRoot, {
    branch: workspace.branch,
    baseSha: workspace.baseSha,
    changedFiles: state.diff?.fileCount ?? 0,
    ...(state.commit === undefined ? {} : { committedSha: state.commit.sha }),
  });
}

/** Stable elapsed time for a run, shared by status and the home screen. */
export function runDuration(state: RunState): number {
  return new Date(state.finishedAt ?? state.updatedAt).getTime() - new Date(state.createdAt).getTime();
}

/** Warns, after a completed run's summary, that its work is not committed anywhere. */
async function printLanding(repoRoot: string, state: RunState): Promise<void> {
  if ((await landingOf(repoRoot, state)) !== 'unlanded') return;

  out();
  out(warning('Unlanded: this run\'s changes are staged in its worktree but never committed.'));
  hint('A `git worktree prune` or `git reset` would discard them.');
  hint(`relay deliver ${state.runId}   # run the delivery again: commit, push, pull request, merge`);
}

/** Progress view for a run that has not finished yet. */
async function printLiveStatus(state: RunState, store: RunStore): Promise<void> {
  const issue = state.issue;
  heading(`${state.runId}  ${phaseLabel(state.phase)}`);
  out();

  const elapsed = Date.now() - new Date(state.createdAt).getTime();
  rows([
    issue !== undefined && { label: 'Issue', value: issueHeadline(issue) },
    state.workspace !== undefined && { label: 'Branch', value: state.workspace.branch },
    state.workspace !== undefined && { label: 'Worktree', value: state.workspace.path },
    {
      label: 'Agents',
      value:
        `planner=${state.config.agents.planner}, plan reviewer=${state.config.agents.planReviewer}, ` +
        `implementer=${state.config.agents.implementer}, code reviewer=${state.config.agents.codeReviewer}`,
    },
    {
      label: 'Rounds',
      value:
        `plan ${state.rounds.planReview}/${state.config.workflow.maxPlanReviewRounds}, ` +
        `code ${state.rounds.codeReview}/${state.config.workflow.maxCodeReviewRounds}` +
        (state.planApproved ? dim('  (plan approved)') : ''),
    },
    state.diff !== undefined && {
      label: 'Changes',
      value: `${state.diff.fileCount} file(s), ${changeCount(state.diff.additions, state.diff.deletions)}`,
    },
    state.usage !== undefined && { label: 'Usage', value: formatUsage(state.usage.total) },
    state.error !== undefined && { label: 'Error', value: failure(state.error.message) },
    { label: 'Elapsed', value: formatDuration(elapsed) },
  ]);
  if (runLiveness(state) === 'stale') {
    out(warning(`Stale: ${state.pid === undefined ? 'no process was recorded' : `pid ${state.pid} is no longer alive`} — this run is not running.`));
    hint(`relay resume ${state.runId}`);
  } else if (state.pid !== undefined) hint(`Driven by process ${state.pid}`);

  const events = await store.readEvents();
  const recent = events.slice(-8);
  if (recent.length > 0) {
    out();
    out(dim('  Recent activity'));
    for (const event of recent) {
      const detail = event.message ?? (event.data === undefined ? '' : oneLine(JSON.stringify(event.data), 90));
      out(dim(`    ${event.timestamp.slice(11, 19)}  ${(event.agent ?? 'relay').padEnd(13)} ${event.type.padEnd(15)} ${detail}`));
    }
  }

  out();
  hint(`relay watch ${state.runId}`);
}

/**
 * Shows the run's diff, recomputed from git so it reflects the worktree as it
 * is now, not as it was when the run finished.
 */
export async function diffCommand(runRef: string, options: { stat?: boolean; json?: boolean }): Promise<number> {
  const cli = await createCliContext();
  const state = await resolveRun(cli.repo.root, runRef);
  const store = new RunStore(cli.repo.root, state.runId);
  const json = options.json === true;

  const workspace = state.workspace;
  if (workspace === undefined) {
    throw new RelayError(`Run ${state.runId} never created a workspace.`, { code: 'NO_WORKSPACE' });
  }

  if (!(await worktreeExists(workspace.path))) {
    // The worktree is gone, but the patch Relay captured during the run is not.
    const stored = state.diff === undefined ? undefined : await store.readArtifact(state.diff.patchFile);
    if (stored === undefined) {
      throw new RelayError(`The worktree for run ${state.runId} no longer exists and no patch was stored.`, {
        code: 'NO_WORKSPACE',
      });
    }
    if (json) {
      emitJson('diff', storedDiffToJson(state, stored, options));
      return EXIT.success;
    }
    out(dim(`Worktree is gone; showing the patch captured during the run (${state.diff?.patchFile}).`));
    raw(stored);
    return EXIT.success;
  }

  const snapshot = await snapshotDiff(workspace.path, workspace.baseSha);

  // An empty diff is a fact rather than an empty state once something is
  // parsing it, so the JSON path answers before the prose one does.
  if (json) {
    emitJson('diff', diffToJson(state, snapshot, options));
    return EXIT.success;
  }

  if (snapshot.isEmpty) {
    emptyState(`Run ${state.runId} changed no files (${phaseLabel(state.phase)}).`, [
      `relay status ${state.runId}`,
      `relay logs ${state.runId}`,
    ]);
    return EXIT.success;
  }

  if (options.stat === true) {
    heading(`${workspace.branch} — ${formatDiffStat(snapshot)}`);
    out();
    for (const line of formatFileList(snapshot)) out(`  ${line}`);
    return EXIT.success;
  }

  raw(snapshot.patch);
  return EXIT.success;
}

export async function logsCommand(
  runRef: string,
  options: { limit?: string; all?: boolean; json?: boolean },
): Promise<number> {
  const cli = await createCliContext();
  const state = await resolveRun(cli.repo.root, runRef);
  const store = new RunStore(cli.repo.root, state.runId);

  const events = await store.readEvents();
  const limit = options.all === true ? events.length : Number.parseInt(options.limit ?? '80', 10) || 80;

  // No events is an empty list, not advice: a consumer asked for the log, and
  // `total` says how much of it there was without any prose.
  if (options.json === true) {
    emitJson('logs', logsToJson(state, events, limit));
    return EXIT.success;
  }

  if (events.length === 0) {
    emptyState(
      `No events recorded for ${state.runId} — it is ${phaseLabel(state.phase)} and no agent has taken a turn yet.`,
      [`relay status ${state.runId}`, `relay watch ${state.runId}`],
    );
    return EXIT.success;
  }

  for (const event of events.slice(-limit)) {
    const time = event.timestamp.slice(11, 19);
    const who = event.agent ?? 'relay';
    const detail = event.message ?? (event.data === undefined ? '' : oneLine(JSON.stringify(event.data), 140));
    out(`${dim(time)}  ${event.phase.padEnd(18)} ${who.padEnd(14)} ${event.type.padEnd(16)} ${detail}`);
  }

  printUsageByPhase(state);
  return EXIT.success;
}

/** Per-phase token spend, so a run's cost can be attributed to the rounds that caused it. */
function printUsageByPhase(state: RunState): void {
  const usage = state.usage;
  if (usage === undefined) return;

  out();
  out(dim('Usage by phase'));
  for (const phase of PHASES) {
    const totals = usage.byPhase[phase];
    if (totals === undefined) continue;
    out(dim(`  ${phaseLabel(phase).padEnd(20)} ${formatUsage(totals)}`));
  }
  out(dim(`  ${'Total'.padEnd(20)} ${formatUsage(usage.total)}`));
}

/** Signals a running engine to stop at its next phase boundary. */
export async function stopCommand(runRef: string, options: { json?: boolean } = {}): Promise<number> {
  const cli = await createCliContext();
  const state = await resolveRun(cli.repo.root, runRef);
  const store = new RunStore(cli.repo.root, state.runId);
  const json = options.json === true;

  if (isTerminal(state.phase)) {
    // Already over is not a failure — `relay stop` asked for the run to be
    // stopped, and it is stopped — so this reports rather than exits non-zero.
    if (json) emitJson('stop', stopToJson(state, { cancelRequested: false, signalled: false }));
    else out(`Run ${state.runId} already finished (${phaseLabel(state.phase)}).`);
    return EXIT.success;
  }

  await store.requestCancel(`stopped by user at ${new Date().toISOString()}`);
  if (state.phase === 'QUEUED') {
    transition(state, 'CANCELLED', { note: 'cancelled before start' });
    await store.saveState(state);
  }
  if (!json) out(`Cancellation requested for ${state.runId}.`);

  let signalled = false;
  if (state.pid !== undefined) {
    try {
      // SIGINT so the owning process runs the same clean shutdown as Ctrl-C.
      process.kill(state.pid, 'SIGINT');
      signalled = true;
      if (!json) hint(`Signalled process ${state.pid}.`, '');
    } catch {
      if (!json) hint('The run process is no longer alive; the cancellation flag has been recorded.', '');
    }
  }

  if (json) {
    emitJson('stop', stopToJson(state, { cancelRequested: true, signalled }));
    return EXIT.success;
  }

  hint('Work completed so far is preserved on the run branch.', '');
  return EXIT.success;
}

/** Tails a run's event log, following an in-progress run until it finishes. */
export async function watchCommand(
  runRef: string,
  options: { interval?: string; json?: boolean },
): Promise<number> {
  const cli = await createCliContext();
  const initial = await resolveRun(cli.repo.root, runRef);
  const store = new RunStore(cli.repo.root, initial.runId);
  const json = options.json === true;

  const intervalMs = Math.max(250, Number.parseInt(options.interval ?? '1000', 10) || 1000);
  let seen = 0;

  const renderer = json ? undefined : rendererFor(initial);
  renderer?.start();

  for (;;) {
    const events = await store.readEvents();
    for (const event of events.slice(seen)) {
      if (json) {
        emitJsonLine('watch', { type: 'event', runId: initial.runId, event: eventToJson(event) });
        continue;
      }
      replayEvents([event], renderer!);
    }
    seen = events.length;

    const state = await store.loadState();
    if (isTerminal(state.phase)) {
      // The same verdict `relay run` would have exited with, so watching a run
      // from another terminal answers the same question the run itself did.
      const code = exitCodeForRun(state, await landingOf(cli.repo.root, state));
      if (json) {
        emitJsonLine('watch', {
          type: 'finished',
          runId: state.runId,
          phase: state.phase,
          phaseLabel: phaseLabel(state.phase),
          exitCode: code,
        });
        return code;
      }
      renderer!.finish(state.phase);
      if (state.config.notify.bell && process.stdout.isTTY) process.stdout.write('\u0007');
      return code;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export async function planCommand(runRef: string, options: { json?: boolean } = {}): Promise<number> {
  const cli = await createCliContext();
  const state = await resolveRun(cli.repo.root, runRef);
  const store = new RunStore(cli.repo.root, state.runId);

  const plan = await store.readArtifact(RUN_FILES.plan);
  if (plan === undefined) {
    throw new RelayError(`Run ${state.runId} has no plan yet.`, { code: 'NO_PLAN' });
  }
  if (options.json === true) {
    emitJson('plan', planToJson(state, plan));
    return EXIT.success;
  }
  raw(plan.trimEnd());
  return EXIT.success;
}

export async function readFileOrUndefined(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}
