import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLineSplitter, parseJsonLine } from '../process/lines.ts';
import { CONFIG_OVERLAY_VARIABLE, DEFAULT_CONFIG, mergeConfig } from '../storage/config.ts';
import { errorMessage } from '../util/errors.ts';
import { studioRunOverlay } from './overlay.ts';
import type { CompanionRunView, RunStage, RunStreamRecord, RunTask, StartRunRequest } from './protocol.ts';

/**
 * Runs the studio started on this machine.
 *
 * Each is a real `relay run --json` in a child process — the same command a
 * person types, with the workflow's shape layered over the repository's config
 * — and the companion is only its relay: every line the engine prints is kept
 * and handed to whoever is listening, verbatim. A child rather than a call:
 * a run that crashes takes itself down, not the companion, and a stopped
 * companion leaves the run to finish exactly like a terminal that was closed.
 */

/** How a Relay child is launched: this Node, this launcher. */
export interface RelayLauncher {
  command: string;
  args: readonly string[];
}

export function selfLauncher(): RelayLauncher {
  const entry = process.argv[1];
  if (entry === undefined) throw new Error('Cannot locate the Relay launcher.');
  // The flags Node itself was started with travel along (type stripping, when
  // running from source); a debugger's would fight this process for its port.
  const flags = process.execArgv.filter((flag) => !flag.startsWith('--inspect'));
  return { command: process.execPath, args: [...flags, entry] };
}

const MAX_RECORDS = 5_000;
const MAX_STDERR_CHARS = 16_000;
const MAX_TEXT = 20_000;
/** An issue number, `owner/repo#n`, a URL, a Linear key or a spec path. Never a flag. */
const ISSUE_REF = /^[A-Za-z0-9][A-Za-z0-9._~:/?#=&%+@-]*$/;
/** `owner/name` on GitHub: the characters GitHub allows, and never `.` or `..` as a name. */
export const REPOSITORY_SLUG = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/;

type Listener = (record: RunStreamRecord) => void;
/** A record before it is numbered. Distributed over the union, so each variant keeps its own fields. */
type Unnumbered<T> = T extends unknown ? Omit<T, 'seq'> : never;

interface StudioRun {
  view: CompanionRunView;
  request: StartRunRequest;
  overlay: Record<string, unknown>;
  /** Null until the engine is spawned: while queued, and while the repository is checked out. */
  child: ChildProcess | null;
  /** Where the engine runs, once known. */
  root: string | null;
  /** Stops a checkout in progress. */
  abort: AbortController;
  records: RunStreamRecord[];
  listeners: Set<Listener>;
  stderr: string;
  overlayDir: string | null;
  finished: boolean;
}

export interface StudioRunsOptions {
  /** Runs at once; the rest wait their turn, in order. Unlimited when absent. */
  maxConcurrent?: number;
  /**
   * Checks out `owner/name` and answers with its root: a companion whose runs
   * each name their repository (a cloud runner). Without it every run uses
   * the root the companion was started in.
   */
  checkout?: (repository: string, signal: AbortSignal) => Promise<string>;
}

export class TaskError extends Error {}

/**
 * Checks what the studio sent before anything is spawned. A companion that
 * checks out a repository per run needs one named; any other refuses one,
 * because it would run somewhere other than where the studio asked.
 */
export function parseStartRequest(body: unknown, options: { repositoryPerRun?: boolean } = {}): StartRunRequest {
  if (body === null || typeof body !== 'object') throw new TaskError('Expected a JSON object.');
  const raw = body as Record<string, unknown>;
  const workflow = raw['workflow'] as Record<string, unknown> | undefined;
  if (workflow === undefined || typeof workflow['id'] !== 'string' || typeof workflow['name'] !== 'string') {
    throw new TaskError('The request names no workflow.');
  }
  const config = raw['config'];
  if (config === null || typeof config !== 'object' || Array.isArray(config)) throw new TaskError('The request carries no compiled config.');
  const parsed: StartRunRequest = { workflow: { id: workflow['id'], name: workflow['name'] }, config: config as Record<string, unknown>, task: parseTask(raw['task']) };
  const repository = typeof raw['repository'] === 'string' ? raw['repository'].trim() : '';
  if (options.repositoryPerRun === true) {
    if (repository.length === 0) throw new TaskError('Say which GitHub repository to run in, as owner/name.');
    if (!REPOSITORY_SLUG.test(repository)) throw new TaskError(`"${repository.slice(0, 80)}" is not a GitHub repository. Use owner/name, for example acme/api.`);
    parsed.repository = repository;
  } else if (repository.length > 0) {
    throw new TaskError('This machine runs in the repository `relay connect` was started in; it cannot switch to another.');
  }
  return parsed;
}

export function parseTask(value: unknown): RunTask {
  if (value === null || typeof value !== 'object') throw new TaskError('Say what the agents should work on: an issue or a description.');
  const task = value as Record<string, unknown>;
  if (task['kind'] === 'issue' && typeof task['ref'] === 'string') {
    const ref = task['ref'].trim();
    if (ref.length === 0 || ref.length > 300 || !ISSUE_REF.test(ref)) {
      throw new TaskError(`"${ref.slice(0, 60)}" is not an issue Relay can look up. Use a number, owner/repo#number, a URL or a Linear key.`);
    }
    return { kind: 'issue', ref };
  }
  if (task['kind'] === 'prompt' && typeof task['text'] === 'string') {
    const text = task['text'].trim();
    if (text.length === 0) throw new TaskError('The description is empty.');
    if (text.length > MAX_TEXT) throw new TaskError(`The description is longer than ${MAX_TEXT} characters.`);
    return { kind: 'prompt', text };
  }
  throw new TaskError('Say what the agents should work on: an issue or a description.');
}

/** The argv after the launcher. Options are spelled `--flag=value`, so no text can become a flag. */
export function runArguments(task: RunTask): string[] {
  const base = ['run', '--json', '--no-offer-merge'];
  return task.kind === 'issue' ? [...base, '--', task.ref] : [...base, `--prompt=${task.text}`];
}

export class StudioRuns {
  private readonly runs = new Map<string, StudioRun>();
  private readonly root: string | null;
  private readonly launcher: RelayLauncher;
  private readonly onChange: (view: CompanionRunView) => void;
  private readonly maxConcurrent: number;
  private readonly checkout: ((repository: string, signal: AbortSignal) => Promise<string>) | undefined;
  /** Runs waiting for a slot, oldest first. */
  private readonly waiting: StudioRun[] = [];
  private occupied = 0;

  constructor(
    root: string | null,
    launcher: RelayLauncher = selfLauncher(),
    onChange: (view: CompanionRunView) => void = () => undefined,
    options: StudioRunsOptions = {},
  ) {
    if (root === null && options.checkout === undefined) throw new Error('StudioRuns needs a root or a checkout.');
    this.root = root;
    this.launcher = launcher;
    this.onChange = onChange;
    this.maxConcurrent = options.maxConcurrent ?? Number.POSITIVE_INFINITY;
    this.checkout = options.checkout;
  }

  async start(request: StartRunRequest): Promise<CompanionRunView> {
    const overlay = studioRunOverlay(request.config);
    // Refused here, with the engine's own message, rather than ten seconds
    // into a child that would die on the same line.
    try {
      mergeConfig(DEFAULT_CONFIG, overlay);
    } catch (error) {
      throw new TaskError(`The workflow does not compile to a config this Relay accepts: ${errorMessage(error)}`);
    }

    const id = `sr_${randomBytes(6).toString('base64url')}`;
    const run: StudioRun = {
      view: {
        id,
        workflow: request.workflow,
        task: request.task,
        status: 'running',
        stage: 'queued',
        repository: request.repository ?? null,
        runId: null,
        exitCode: null,
        startedAt: new Date().toISOString(),
        finishedAt: null,
      },
      request,
      overlay,
      child: null,
      root: null,
      abort: new AbortController(),
      records: [],
      listeners: new Set(),
      stderr: '',
      overlayDir: null,
      finished: false,
    };
    this.runs.set(id, run);

    if (this.occupied < this.maxConcurrent) {
      this.occupied += 1;
      void this.launch(run);
    } else {
      this.waiting.push(run);
    }
    this.onChange({ ...run.view });
    return { ...run.view };
  }

  /** Checks out the repository if the run names one, then spawns the engine. Holds one slot until the run ends. */
  private async launch(run: StudioRun): Promise<void> {
    let root = this.root;
    try {
      if (this.checkout !== undefined && run.request.repository !== undefined) {
        this.stage(run, 'preparing');
        root = await this.checkout(run.request.repository, run.abort.signal);
      }
      if (run.abort.signal.aborted) {
        this.finish(run, 130, 'Stopped before it started.');
        return;
      }
      if (root === null) throw new Error('This run names no repository to run in.');
      await this.spawnEngine(run, root);
    } catch (error) {
      this.finish(run, run.abort.signal.aborted ? 130 : null, run.abort.signal.aborted ? 'Stopped before it started.' : errorMessage(error));
    }
  }

  private async spawnEngine(run: StudioRun, root: string): Promise<void> {
    const overlayDir = await mkdtemp(join(tmpdir(), 'relay-studio-'));
    run.overlayDir = overlayDir;
    const overlayPath = join(overlayDir, 'config.json');
    await writeFile(overlayPath, JSON.stringify(run.overlay, null, 2), { mode: 0o600 });

    const child = spawn(this.launcher.command, [...this.launcher.args, ...runArguments(run.request.task)], {
      cwd: root,
      env: { ...process.env, [CONFIG_OVERLAY_VARIABLE]: overlayPath, NO_COLOR: '1', FORCE_COLOR: '0' },
      // A pipe on stdin, never the companion's terminal: nothing in the run
      // may wait for an answer from a person who is looking at a browser.
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      // A process group of its own, so the Ctrl-C that stops the companion is
      // not also delivered to every run it started. Stopping those is a
      // decision `relay connect` asks for separately, and does gracefully.
      detached: true,
      windowsHide: true,
    });
    child.stdin?.end();
    run.child = child;
    run.root = root;
    this.stage(run, 'running');

    const stdout = createLineSplitter((line) => {
      const data = parseJsonLine(line);
      if (data === undefined) return;
      if (data['type'] === 'run_started' && typeof data['runId'] === 'string') {
        run.view.runId = data['runId'];
        this.onChange({ ...run.view });
      }
      this.push(run, { type: 'engine', data });
    });
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: string) => {
      run.stderr = (run.stderr + chunk).slice(-MAX_STDERR_CHARS);
    });

    child.on('error', (error) => {
      stdout.flush();
      this.finish(run, null, error.message);
    });
    child.on('close', (code) => {
      stdout.flush();
      this.finish(run, code, null);
    });
  }

  private stage(run: StudioRun, stage: RunStage): void {
    run.view.stage = stage;
    this.onChange({ ...run.view });
  }

  private finish(run: StudioRun, code: number | null, error: string | null): void {
    if (run.finished) return;
    run.finished = true;
    run.view.status = 'exited';
    run.view.stage = 'exited';
    run.view.exitCode = code;
    run.view.finishedAt = new Date().toISOString();
    this.push(run, { type: 'exit', code, error: code === 0 ? null : (error ?? lastError(run.stderr)) });
    this.onChange({ ...run.view });
    if (run.overlayDir !== null) void rm(run.overlayDir, { recursive: true, force: true });

    const queued = this.waiting.indexOf(run);
    if (queued >= 0) {
      this.waiting.splice(queued, 1);
      return;
    }
    // A run that held a slot hands it to the oldest one waiting.
    const next = this.waiting.shift();
    if (next === undefined) this.occupied -= 1;
    else void this.launch(next);
  }

  list(): CompanionRunView[] {
    return [...this.runs.values()].map((run) => ({ ...run.view })).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  get(id: string): CompanionRunView | undefined {
    const run = this.runs.get(id);
    return run === undefined ? undefined : { ...run.view };
  }

  /**
   * Replays everything recorded so far, then follows. A studio that reloads
   * mid-run picks the run back up from its first line, not from wherever it
   * happened to be when the tab went away; a follower that lost its
   * connection passes `since`, the first record it has not seen.
   */
  subscribe(id: string, listener: Listener, since = 0): (() => void) | undefined {
    const run = this.runs.get(id);
    if (run === undefined) return undefined;
    for (const record of run.records) if (record.seq >= since) listener(record);
    if (run.view.status === 'exited') return () => undefined;
    run.listeners.add(listener);
    return () => run.listeners.delete(listener);
  }

  /**
   * Stops a run the way Ctrl-C in its terminal would: SIGINT, which the engine
   * turns into a clean cancellation — work so far committed to its branch,
   * the run recorded as cancelled. Windows has no such signal, so there the
   * companion asks `relay stop`, which leaves the flag the engine checks at
   * its next phase boundary; before the run has a name there is nothing to
   * flag, and the child is ended.
   */
  async cancel(id: string): Promise<boolean> {
    const run = this.runs.get(id);
    if (run === undefined || run.view.status === 'exited') return false;
    const child = run.child;
    if (child === null) {
      // Queued, or still checking out: nothing of the engine's to stop yet.
      run.abort.abort();
      if (this.waiting.includes(run)) this.finish(run, 130, 'Stopped before it started.');
      return true;
    }
    if (process.platform !== 'win32') {
      child.kill('SIGINT');
      return true;
    }
    if (run.view.runId === null) {
      child.kill();
      return true;
    }
    const stop = spawn(this.launcher.command, [...this.launcher.args, 'stop', run.view.runId, '--json'], {
      cwd: run.root ?? process.cwd(),
      stdio: 'ignore',
      shell: false,
      windowsHide: true,
    });
    await new Promise<void>((resolve) => {
      stop.once('close', () => resolve());
      stop.once('error', () => {
        child.kill();
        resolve();
      });
    });
    return true;
  }

  /** Running children, for the companion's goodbye. */
  active(): CompanionRunView[] {
    return this.list().filter((view) => view.status === 'running');
  }

  /** Resolves once every run has exited, or when the time is up — whichever is first. */
  async settled(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.active().length > 0) {
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return true;
  }

  private push(run: StudioRun, record: Unnumbered<RunStreamRecord>): void {
    const full = { ...record, seq: run.records.length } as RunStreamRecord;
    if (run.records.length < MAX_RECORDS || record.type === 'exit') run.records.push(full);
    for (const listener of run.listeners) listener(full);
    if (record.type === 'exit') run.listeners.clear();
  }
}

/**
 * What a failed child said about why, read from its stderr: `reportError`'s
 * `Error <message>` line and the hint under it, or failing that the last line.
 */
export function lastError(stderr: string): string | null {
  const lines = stderr
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const at = lines.findLastIndex((line) => line.startsWith('Error '));
  if (at >= 0) return [lines[at]!.slice('Error '.length), ...lines.slice(at + 1)].join('\n');
  return lines.at(-1) ?? null;
}
