import { readFile } from 'node:fs/promises';

import { RelayError } from '../../util/errors.ts';
import { formatDuration, oneLine } from '../../util/text.ts';
import { snapshotDiff, formatDiffStat, formatFileList } from '../../git/diff.ts';
import { worktreeExists } from '../../git/worktree.ts';
import { listRuns, resolveRun, RunStore, RUN_FILES } from '../../storage/runs.ts';
import { isTerminal, phaseLabel } from '../../workflow/phases.ts';
import { createCliContext } from '../context.ts';
import { dim, failure, heading, out, success, warning } from '../output.ts';

export async function statusCommand(runRef?: string): Promise<number> {
  const cli = await createCliContext();

  if (runRef !== undefined) {
    const state = await resolveRun(cli.repo.root, runRef);
    const store = new RunStore(cli.repo.root, state.runId);
    const summary = await store.readArtifact(RUN_FILES.summary);
    if (summary !== undefined) {
      out(summary.trimEnd());
      return 0;
    }
    out(`${state.runId}  ${phaseLabel(state.phase)}`);
    return 0;
  }

  const runs = await listRuns(cli.repo.root);
  if (runs.length === 0) {
    out('No runs yet. Start one with `relay run <issue>`.');
    return 0;
  }

  heading(`Relay runs in ${cli.repo.root}`);
  out();

  for (const state of runs.slice(0, 20)) {
    const elapsed = new Date(state.finishedAt ?? state.updatedAt).getTime() - new Date(state.createdAt).getTime();
    const label =
      state.phase === 'COMPLETE'
        ? success(phaseLabel(state.phase))
        : state.phase === 'FAILED'
          ? failure(phaseLabel(state.phase))
          : isTerminal(state.phase)
            ? warning(phaseLabel(state.phase))
            : phaseLabel(state.phase);

    const issue = state.issue === undefined ? state.issueRef : `#${state.issue.number} ${state.issue.title}`;
    out(`  ${state.runId}  ${label.padEnd(22)} ${oneLine(issue, 48)}`);
    out(
      dim(
        `    ${state.workspace?.branch ?? '(no branch)'}  ·  ${formatDuration(elapsed)}  ·  ` +
          `plan ${state.rounds.planReview}r, code ${state.rounds.codeReview}r` +
          (state.diff === undefined ? '' : `  ·  +${state.diff.additions} −${state.diff.deletions}`),
      ),
    );
  }

  if (runs.length > 20) out(dim(`  … and ${runs.length - 20} older run(s)`));
  return 0;
}

/**
 * Shows the run's diff, recomputed from git so it reflects the worktree as it
 * is now, not as it was when the run finished.
 */
export async function diffCommand(runRef: string, options: { stat?: boolean }): Promise<number> {
  const cli = await createCliContext();
  const state = await resolveRun(cli.repo.root, runRef);
  const store = new RunStore(cli.repo.root, state.runId);

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
    out(dim(`Worktree is gone; showing the patch captured during the run (${state.diff?.patchFile}).`));
    out(stored);
    return 0;
  }

  const snapshot = await snapshotDiff(workspace.path, workspace.baseSha);

  if (snapshot.isEmpty) {
    out('No changes in this run.');
    return 0;
  }

  if (options.stat === true) {
    heading(`${workspace.branch} — ${formatDiffStat(snapshot)}`);
    out();
    for (const line of formatFileList(snapshot)) out(`  ${line}`);
    return 0;
  }

  out(snapshot.patch);
  return 0;
}

export async function logsCommand(runRef: string, options: { limit?: string; all?: boolean }): Promise<number> {
  const cli = await createCliContext();
  const state = await resolveRun(cli.repo.root, runRef);
  const store = new RunStore(cli.repo.root, state.runId);

  const events = await store.readEvents();
  if (events.length === 0) {
    out(`No events recorded for ${state.runId}.`);
    return 0;
  }

  const limit = options.all === true ? events.length : Number.parseInt(options.limit ?? '80', 10) || 80;
  for (const event of events.slice(-limit)) {
    const time = event.timestamp.slice(11, 19);
    const who = event.agent ?? 'relay';
    const detail = event.message ?? (event.data === undefined ? '' : oneLine(JSON.stringify(event.data), 140));
    out(`${dim(time)}  ${event.phase.padEnd(18)} ${who.padEnd(14)} ${event.type.padEnd(16)} ${detail}`);
  }
  return 0;
}

/** Signals a running engine to stop at its next phase boundary. */
export async function stopCommand(runRef: string): Promise<number> {
  const cli = await createCliContext();
  const state = await resolveRun(cli.repo.root, runRef);
  const store = new RunStore(cli.repo.root, state.runId);

  if (isTerminal(state.phase)) {
    out(`Run ${state.runId} already finished (${phaseLabel(state.phase)}).`);
    return 0;
  }

  await store.requestCancel(`stopped by user at ${new Date().toISOString()}`);
  out(`Cancellation requested for ${state.runId}.`);

  if (state.pid !== undefined) {
    try {
      // SIGINT so the owning process runs the same clean shutdown as Ctrl-C.
      process.kill(state.pid, 'SIGINT');
      out(dim(`Signalled process ${state.pid}.`));
    } catch {
      out(dim('The run process is no longer alive; the cancellation flag has been recorded.'));
    }
  }

  out(dim('Work completed so far is preserved on the run branch.'));
  return 0;
}

/** Tails a run's event log, following an in-progress run until it finishes. */
export async function watchCommand(runRef: string, options: { interval?: string }): Promise<number> {
  const cli = await createCliContext();
  const initial = await resolveRun(cli.repo.root, runRef);
  const store = new RunStore(cli.repo.root, initial.runId);

  const intervalMs = Math.max(250, Number.parseInt(options.interval ?? '1000', 10) || 1000);
  let seen = 0;

  heading(`Watching ${initial.runId}`);
  out();

  for (;;) {
    const events = await store.readEvents();
    for (const event of events.slice(seen)) {
      const time = event.timestamp.slice(11, 19);
      const who = event.agent ?? 'relay';
      const detail = event.message ?? (event.data === undefined ? '' : oneLine(JSON.stringify(event.data), 120));
      out(`${dim(time)}  ${event.phase.padEnd(18)} ${who.padEnd(14)} ${event.type.padEnd(16)} ${detail}`);
    }
    seen = events.length;

    const state = await store.loadState();
    if (isTerminal(state.phase)) {
      out();
      out(`Run ${phaseLabel(state.phase)}.`);
      return state.phase === 'COMPLETE' ? 0 : 1;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export async function planCommand(runRef: string): Promise<number> {
  const cli = await createCliContext();
  const state = await resolveRun(cli.repo.root, runRef);
  const store = new RunStore(cli.repo.root, state.runId);

  const plan = await store.readArtifact(RUN_FILES.plan);
  if (plan === undefined) {
    throw new RelayError(`Run ${state.runId} has no plan yet.`, { code: 'NO_PLAN' });
  }
  out(plan.trimEnd());
  return 0;
}

export async function readFileOrUndefined(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}
