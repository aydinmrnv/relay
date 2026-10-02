import type { ExitCode } from '../cli/exit.ts';
import type { RunJson } from '../cli/runJson.ts';
import { RunJsonStream, type RunStreamLine } from '../cli/runStream.ts';
import type { LoggedEvent } from '../storage/runs.ts';
import { replayEvents } from '../workflow/replay.ts';
import type { RunState } from '../workflow/state.ts';

/**
 * The `relay run --json` stream of a run that already happened, rebuilt from
 * what the run left on disk.
 *
 * It is made by the same class that writes the live stream, fed the run's own
 * event log with the clock set to each event's recorded time. So the lines
 * have the shape a consumer of the live stream already reads — the studio's
 * fold takes them unchanged — and every timestamp and duration is the one the
 * run recorded, not the time of the export.
 *
 * It is not a byte-for-byte copy of what the run printed. The engine's
 * commentary (`observer.note`) is not kept in `events.jsonl`; what is kept are
 * the phase boundaries, each phase's closing note, the test result and the
 * delivery steps, and those are what come back.
 */
export function rebuildStream(state: RunState, events: readonly LoggedEvent[], run: RunJson, exitCode: ExitCode): RunStreamLine[] {
  const lines: RunStreamLine[] = [];
  let clock = new Date(state.createdAt);
  const stream = new RunJsonStream({
    state,
    command: 'run',
    now: () => clock,
    write: (line) => lines.push(line),
  });

  const end = new Date(state.finishedAt ?? state.updatedAt);
  let finished = false;
  // The last phase ends when the run did. What was logged afterwards — the
  // commit a failed run makes on its way out, a `relay deliver` hours later —
  // is part of the record, and is not time the phase spent.
  const finish = (): void => {
    if (finished) return;
    finished = true;
    if (!Number.isNaN(end.getTime()) && end.getTime() >= clock.getTime()) clock = end;
    stream.finish(state.phase);
  };

  stream.start();
  for (const event of events) {
    // Agent events are per-tool-call detail the stream leaves out unless asked.
    if (event.agent !== null) continue;
    const at = new Date(event.timestamp);
    if (!Number.isNaN(at.getTime()) && !Number.isNaN(end.getTime()) && at.getTime() > end.getTime()) finish();
    // Nothing opens a phase once the run is over: there would be nothing left to close it.
    if (finished && event.type === 'phase_started') continue;
    // A log line with no readable time keeps its place, at the time of the one before it.
    if (!Number.isNaN(at.getTime()) && at.getTime() >= clock.getTime()) clock = at;
    replayEvents([event], stream);
  }

  finish();
  stream.summary(run, exitCode);
  return lines;
}
