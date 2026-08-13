import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { RelayError } from '../util/errors.ts';
import { redactDeep, redact } from '../util/redact.ts';
import { isRunId } from '../util/ids.ts';
import type { AgentEvent } from '../agents/types.ts';
import type { Phase } from '../workflow/phases.ts';
import type { RunState } from '../workflow/state.ts';
import { validateRunState } from '../workflow/state.ts';
import { atomicWriteFile, atomicWriteJson, appendLine, readJsonFile } from './atomic.ts';
import { runsDir } from './config.ts';

/** A single line of `events.jsonl`. */
export interface LoggedEvent {
  timestamp: string;
  runId: string;
  phase: Phase;
  agent: string | null;
  type: string;
  /** Human-readable one-liner; the structured payload lives in `data`. */
  message?: string;
  data?: Record<string, unknown>;
}

export const RUN_FILES = {
  state: 'state.json',
  issue: 'issue.md',
  brief: 'brief.md',
  plan: 'plan.md',
  summary: 'summary.md',
  events: 'events.jsonl',
  cancel: 'CANCEL',
} as const;

/**
 * Owns everything Relay writes for a run. Nothing outside this class builds
 * paths inside the run directory, which keeps the on-disk layout in one place.
 */
export class RunStore {
  readonly repoRoot: string;
  readonly runId: string;
  readonly dir: string;

  constructor(repoRoot: string, runId: string) {
    if (!isRunId(runId)) {
      throw new RelayError(`Invalid run id: ${runId}`, { code: 'BAD_RUN_ID' });
    }
    this.repoRoot = repoRoot;
    this.runId = runId;
    this.dir = join(runsDir(repoRoot), runId);
  }

  path(...parts: string[]): string {
    return join(this.dir, ...parts);
  }

  async init(): Promise<void> {
    await mkdir(this.path('reviews'), { recursive: true });
    await mkdir(this.path('patches'), { recursive: true });
    await mkdir(this.path('discussion'), { recursive: true });
    await mkdir(this.path('tests'), { recursive: true });
  }

  async saveState(state: RunState): Promise<void> {
    state.updatedAt = new Date().toISOString();
    await atomicWriteJson(this.path(RUN_FILES.state), state);
  }

  async loadState(): Promise<RunState> {
    const raw = await readJsonFile<unknown>(this.path(RUN_FILES.state));
    if (raw === undefined) {
      throw new RelayError(`Run ${this.runId} has no state file.`, {
        code: 'RUN_NOT_FOUND',
        hint: 'Run `relay status` to list known runs.',
      });
    }
    return validateRunState(raw);
  }

  async writeArtifact(name: string, contents: string): Promise<string> {
    const path = this.path(name);
    await atomicWriteFile(path, contents.endsWith('\n') ? contents : `${contents}\n`);
    return path;
  }

  async readArtifact(name: string): Promise<string | undefined> {
    try {
      return await readFile(this.path(name), 'utf8');
    } catch {
      return undefined;
    }
  }

  /**
   * Appends to the audit log. Every value is redacted first: agent output is
   * untrusted and may echo anything it read.
   */
  async logEvent(event: LoggedEvent): Promise<void> {
    const safe: LoggedEvent = {
      ...event,
      ...(event.message === undefined ? {} : { message: redact(event.message) }),
      ...(event.data === undefined ? {} : { data: redactDeep(event.data) }),
    };
    await appendLine(this.path(RUN_FILES.events), JSON.stringify(safe));
  }

  async logAgentEvent(phase: Phase, event: AgentEvent, extra?: Record<string, unknown>): Promise<void> {
    const { type, agent, at, ...rest } = event;
    await this.logEvent({
      timestamp: at,
      runId: this.runId,
      phase,
      agent,
      type,
      data: { ...rest, ...extra },
    });
  }

  async readEvents(): Promise<LoggedEvent[]> {
    const raw = await this.readArtifact(RUN_FILES.events);
    if (raw === undefined) return [];
    const events: LoggedEvent[] = [];
    for (const line of raw.split('\n')) {
      if (line.trim().length === 0) continue;
      try {
        events.push(JSON.parse(line) as LoggedEvent);
      } catch {
        // A partially written final line is expected if Relay was interrupted.
      }
    }
    return events;
  }

  async saveReview(kind: 'plan' | 'code', round: number, payload: unknown): Promise<string> {
    const name = join('reviews', `${kind}-round-${round}.json`);
    await atomicWriteJson(this.path(name), payload);
    return name;
  }

  async saveDiscussion(kind: 'plan' | 'code', round: number, payload: unknown): Promise<string> {
    const name = join('discussion', `${kind}-round-${round}.json`);
    await atomicWriteJson(this.path(name), payload);
    return name;
  }

  async savePatch(label: string, patch: string): Promise<string> {
    const name = join('patches', `${label}.patch`);
    await atomicWriteFile(this.path(name), patch);
    return name;
  }

  async saveTestOutput(label: string, output: string): Promise<string> {
    const name = join('tests', `${label}.log`);
    await atomicWriteFile(this.path(name), redact(output));
    return name;
  }

  /** `relay stop` drops a sentinel file; the engine polls for it between steps. */
  async requestCancel(reason: string): Promise<void> {
    await writeFile(this.path(RUN_FILES.cancel), `${reason}\n`, 'utf8');
  }

  async cancelRequested(): Promise<boolean> {
    return (await this.readArtifact(RUN_FILES.cancel)) !== undefined;
  }

  async clearCancel(): Promise<void> {
    await rm(this.path(RUN_FILES.cancel), { force: true });
  }
}

/** Lists runs newest-first. Unreadable run directories are skipped, not fatal. */
export async function listRuns(repoRoot: string): Promise<RunState[]> {
  let entries: string[];
  try {
    entries = await readdir(runsDir(repoRoot));
  } catch {
    return [];
  }

  const states: RunState[] = [];
  for (const entry of entries.sort().reverse()) {
    if (!isRunId(entry)) continue;
    try {
      states.push(await new RunStore(repoRoot, entry).loadState());
    } catch {
      continue;
    }
  }
  return states;
}

/**
 * Resolves a user-supplied run reference: a full run id, a unique short id, or
 * `latest`. Ambiguity is an error rather than a guess.
 */
export async function resolveRun(repoRoot: string, ref: string): Promise<RunState> {
  const runs = await listRuns(repoRoot);
  if (runs.length === 0) {
    throw new RelayError('No runs found in this repository.', {
      code: 'RUN_NOT_FOUND',
      hint: 'Start one with `relay run <issue>`.',
    });
  }

  if (ref === 'latest' || ref === '') {
    return runs[0]!;
  }

  const exact = runs.find((run) => run.runId === ref);
  if (exact !== undefined) return exact;

  const matches = runs.filter((run) => run.shortId === ref || run.runId.endsWith(`-${ref}`) || run.runId.startsWith(ref));
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new RelayError(`Run reference "${ref}" is ambiguous (${matches.length} matches).`, {
      code: 'AMBIGUOUS_RUN',
      hint: `Use the full run id. Candidates: ${matches.map((run) => run.runId).join(', ')}.`,
    });
  }

  throw new RelayError(`No run matching "${ref}".`, {
    code: 'RUN_NOT_FOUND',
    hint: 'Run `relay status` to list known runs.',
  });
}
