import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { harnessRegistration } from '../agents/index.ts';
import type { AgentHarness } from '../agents/types.ts';
import type { IssueProvider } from '../github/types.ts';
import { LINEAR_API_URL, LINEAR_KEY_PAGE, LINEAR_KEY_VARIABLE } from '../issues/linear.ts';
import { createLineSplitter, parseJsonLine } from '../process/lines.ts';
import { runProcess } from '../process/runner.ts';
import { CONFIG_OVERLAY_VARIABLE, mergeConfig, type RelayConfig } from '../storage/config.ts';
import { listRuns } from '../storage/runs.ts';
import { studioRunOverlay } from '../studio/overlay.ts';
import { killTree, runArguments, selfLauncher, watchChild, lastError, type RelayLauncher } from '../studio/runs.ts';
import { dailySpend } from '../unattended/budget.ts';
import { withholdSecrets } from '../unattended/environment.ts';
import { stopFilePath, STOP_FILE } from '../unattended/killSwitch.ts';
import { RUN_TRIGGER_VARIABLE } from '../unattended/trigger.ts';
import { errorMessage, RelayError } from '../util/errors.ts';
import { estimateRun } from '../workflow/estimate.ts';
import { runLiveness } from '../workflow/liveness.ts';
import { createApproval, decideApproval, waitForApproval, type ApprovalRecord } from './approvals.ts';
import type { ApprovalAnswer, GraphEffects, PipelineResult, PipelineRun } from './executor.ts';
import type { GraphRecord, GraphTask, WorkflowEvent, WorkflowGraph } from './types.ts';

/**
 * What a workflow's steps do to the world, for real, in one repository.
 *
 * The walk in `executor.ts` decides; this does. Each effect is the smallest
 * thing that performs the step with what is already on the machine: the
 * pipeline is `relay run` as a child process, GitHub is `gh`, Linear is its
 * API with the key the engine already reads, a chat message is a webhook.
 * Nothing here holds a credential longer than the call that uses it, and the
 * environment these steps read is never the one an agent is handed.
 */

export interface EffectsOptions {
  repoRoot: string;
  /** The repository's own config, before the workflow is layered over it. */
  config: RelayConfig;
  harnesses: Record<string, AgentHarness>;
  issueProvider: IssueProvider;
  graph: WorkflowGraph;
  signal: AbortSignal;
  emit: (record: GraphRecord) => void;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
  /** How the pipeline's `relay run` is launched. This Node and this launcher, unless a test says otherwise. */
  launcher?: RelayLauncher;
  /**
   * Asks at the terminal, when there is one. Resolves with the answer, or
   * never: the file under `.relay/approvals/` is watched either way, so an
   * answer from anywhere ends the wait.
   */
  askAtTerminal?: (record: ApprovalRecord, signal: AbortSignal) => Promise<{ approved: boolean; by: string }>;
  /** How often an approval file is looked at. A seam for the tests. */
  approvalPollMs?: number;
  now?: () => Date;
}

/** The workflow's shape for a run: the same overlay a studio-started run gets, plus the unattended ceiling when nobody is here. */
export function pipelineOverlay(graph: WorkflowGraph, event: WorkflowEvent): Record<string, unknown> {
  const overlay = studioRunOverlay(graph.config);
  if (event.attended) return overlay;
  const compiled = graph.config['unattended'];
  const picked: Record<string, unknown> = {};
  if (compiled !== null && typeof compiled === 'object' && !Array.isArray(compiled)) {
    for (const key of ['maxRunCostUsd', 'deliver', 'injectionScreen', 'allowEnv']) {
      const value = (compiled as Record<string, unknown>)[key];
      if (value !== undefined) picked[key] = value;
    }
  }
  return { ...overlay, unattended: picked };
}

/** What started an unattended run, in the words its record and its pull request will carry. */
export function triggerLabel(event: WorkflowEvent, graph: WorkflowGraph): string {
  const what = event.source === 'webhook' ? 'an incoming webhook' : event.source === 'schedule' ? 'a schedule' : event.source === 'issue' ? 'a label on the issue' : 'a workflow';
  return `${what} (workflow “${graph.name}”)`;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('cancelled'));
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('cancelled'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function createEffects(options: EffectsOptions): GraphEffects {
  const env = options.env ?? process.env;
  const fetcher = options.fetch ?? ((...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args));
  const now = options.now ?? ((): Date => new Date());
  const { repoRoot, graph, signal } = options;

  /** The config a run of this workflow would have: the repository's, with the workflow's shape over it. */
  const shaped = (event: WorkflowEvent | null): RelayConfig => {
    try {
      return mergeConfig(options.config, event === null ? studioRunOverlay(graph.config) : pipelineOverlay(graph, event));
    } catch (error) {
      throw new RelayError(`The workflow does not compile to a config this Relay accepts: ${errorMessage(error)}`, { code: 'BAD_WORKFLOW' });
    }
  };

  return {
    now,
    sleep: (ms) => abortableSleep(ms, signal),
    signal,
    env,
    fetch: fetcher,
    emit: options.emit,

    async stopReason() {
      try {
        const note = (await readFile(stopFilePath(repoRoot), 'utf8')).trim().split('\n')[0] ?? '';
        return `.relay/${STOP_FILE} is present${note.length === 0 ? '' : `: ${note}`}`;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        // An unreadable stop file is treated as present: the other way to be wrong keeps spending.
        return `.relay/${STOP_FILE} is unreadable (${errorMessage(error)})`;
      }
    },

    async spend() {
      const runs = await listRuns(repoRoot);
      const spend = dailySpend(runs, now());
      return { spentUsd: spend.spentUsd, runs: spend.runs, unpriced: spend.unpriced, inFlight: runs.filter((run) => runLiveness(run) === 'running').length };
    },

    async estimate() {
      const estimate = estimateRun(await listRuns(repoRoot), shaped(null).workflow);
      if (estimate.cost === undefined) return null;
      return { medianUsd: estimate.cost.median, worstUsd: estimate.cost.worst, samples: estimate.cost.sampleSize };
    },

    async teamOf(login, teams) {
      if (options.issueProvider.teamMembership === undefined) return null;
      return options.issueProvider.teamMembership(login, teams, { signal }).catch(() => null);
    },

    async approval(ask, announce): Promise<ApprovalAnswer> {
      const record = await createApproval(repoRoot, { workflow: ask.workflow, node: ask.node, subject: ask.subject, via: ask.via, approvers: ask.approvers, expiresAt: ask.expiresAt }, now());
      const who = ask.approvers.length === 0 ? '' : ` It may be answered by ${ask.approvers.join(', ')}.`;
      announce(`Approve with \`relay workflow approve ${record.id}\`, or reject with \`relay workflow reject ${record.id}\`, in this repository.${who} It gives up at ${record.expiresAt}.`);

      // Whichever answers first: the file, written from anywhere, or the terminal this runs in.
      const asking = new AbortController();
      const stop = (): void => asking.abort();
      signal.addEventListener('abort', stop, { once: true });
      try {
        const fromFile = waitForApproval(repoRoot, record.id, { signal, now, ...(options.approvalPollMs === undefined ? {} : { pollMs: options.approvalPollMs }) });
        const fromTerminal =
          options.askAtTerminal === undefined
            ? undefined
            : options.askAtTerminal(record, asking.signal).then(async (answer) => {
                // Written to the same file, so the two ways of answering cannot disagree.
                await decideApproval(repoRoot, record.id, answer, now()).catch(() => undefined);
              });
        // A terminal that fails to ask is not an answer; the file is still watched.
        fromTerminal?.catch(() => undefined);
        const { record: decided, timedOut } = await fromFile;
        if (timedOut) return { approved: false, by: null, reason: 'timeout' };
        return { approved: decided.status === 'approved', by: decided.decidedBy ?? null, reason: 'answered' };
      } finally {
        asking.abort();
        signal.removeEventListener('abort', stop);
      }
    },

    runPipeline: (input) => runPipelineChild({ ...input, graph, repoRoot, signal, launcher: options.launcher ?? selfLauncher(), env, now }),

    async aiStep({ prompt, vendor, event }) {
      const config = shaped(event);
      const provider = vendor ?? config.agents.planner;
      const harness = options.harnesses[provider];
      const agent = harnessRegistration(provider)?.label ?? provider;
      if (harness === undefined) return { ok: false, text: '', agent, error: `no agent called ${provider} is set up on this machine` };
      // An event nobody vetted wrote part of this prompt, so the turn gets what
      // a reviewer's turn gets: no writes, and no secret-named variables.
      const withheld = event.attended ? undefined : withholdSecrets({ allow: config.unattended.allowEnv, provider }).env;
      const session = await harness.start({
        prompt: `You are answering one question for an automated workflow. Read the repository if it helps; change nothing. Reply with the answer first, in as few words as it takes.\n\n${prompt}`,
        cwd: repoRoot,
        role: 'ai-step',
        capability: 'read_only',
        purpose: 'ai-step',
        timeoutMs: 5 * 60_000,
        signal,
        ...(withheld === undefined ? {} : { env: withheld }),
      });
      if (!session.ok) return { ok: false, text: session.text, agent, error: session.error ?? (session.timedOut ? 'timed out after five minutes' : 'the turn failed'), ...(session.usage?.costUsd === undefined ? {} : { costUsd: session.usage.costUsd }) };
      return { ok: true, text: session.text, agent, ...(session.usage?.costUsd === undefined ? {} : { costUsd: session.usage.costUsd }) };
    },

    async gh(args) {
      const result = await runProcess('gh', args, { cwd: repoRoot, timeoutMs: 60_000, signal }).catch((error: unknown) => ({ ok: false, stdout: '', stderr: errorMessage(error) }));
      return { ok: result.ok, stdout: result.stdout, stderr: result.stderr };
    },

    async linear<T>(query: string, variables: Record<string, unknown>): Promise<T> {
      const key = env[LINEAR_KEY_VARIABLE]?.trim();
      if (key === undefined || key.length === 0) {
        throw new RelayError(`${LINEAR_KEY_VARIABLE} is not set, so Relay cannot act in Linear.`, { code: 'LINEAR_AUTH', hint: `Create a personal API key at ${LINEAR_KEY_PAGE} and export it as ${LINEAR_KEY_VARIABLE}.` });
      }
      const response = await fetcher(LINEAR_API_URL, {
        method: 'POST',
        // Linear's personal keys go in the header bare, without `Bearer`.
        headers: { 'content-type': 'application/json', authorization: key },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
      });
      const payload = (await response.json().catch(() => undefined)) as { data?: T; errors?: Array<{ message?: string; extensions?: { code?: string; type?: string } }> } | undefined;
      const first = payload?.errors?.[0];
      if (response.status === 401 || /AUTHENTICATION|FORBIDDEN/i.test(`${first?.extensions?.code ?? ''} ${first?.extensions?.type ?? ''}`)) {
        throw new RelayError('Linear rejected the API key.', { code: 'LINEAR_AUTH', hint: `Check ${LINEAR_KEY_VARIABLE}; create a new key at ${LINEAR_KEY_PAGE} if it was revoked.` });
      }
      if (first !== undefined) {
        const message = first.message ?? 'unknown error';
        // Linear's answer for a missing issue is an error rather than a null.
        if (/not found/i.test(message)) return { issue: null } as T;
        throw new RelayError(`Linear: ${message}`, { code: 'LINEAR_FAILED' });
      }
      if (!response.ok || payload?.data === undefined) throw new RelayError(`Linear answered HTTP ${response.status} with no data.`, { code: 'LINEAR_FAILED' });
      return payload.data;
    },
  };
}

/* ------------------------------------------------------------------ */
/* The pipeline, as a child                                            */
/* ------------------------------------------------------------------ */

interface PipelineChildInput {
  graph: WorkflowGraph;
  task: GraphTask;
  event: WorkflowEvent;
  repoRoot: string;
  signal: AbortSignal;
  launcher: RelayLauncher;
  env: NodeJS.ProcessEnv;
  now: () => Date;
  onLine: (line: Record<string, unknown>) => void;
}

/**
 * The variables only a workflow's own steps read: the chat webhooks, the
 * bridge, the webhook's signing secret, the headers of an HTTP request. Never
 * passed on to the pipeline's run. (`LINEAR_API_KEY` is not here: the engine
 * itself reads Linear issues with it.)
 */
export function isWorkflowCredential(name: string): boolean {
  return ['SLACK_WEBHOOK_URL', 'DISCORD_WEBHOOK_URL', 'BRIDGE_WEBHOOK_URL', 'RELAY_WEBHOOK_SECRET'].includes(name) || /^HTTP_HEADERS(_\d+)?$/.test(name);
}

/** How long a run is given to cancel cleanly before its process group is ended. */
const CANCEL_GRACE_MS = 10_000;

/**
 * Runs `relay run --json` for the workflow's pipeline and hands every line it
 * prints to `onLine`, as it arrives.
 *
 * A child process, for the reason the studio's companion uses one: a run that
 * crashes takes itself down and not the workflow, and the steps after it
 * still get to say what happened. The child leads its own process group, so
 * stopping the workflow asks the run to stop the way Ctrl-C would — work so
 * far stays committed on its branch — and ends whatever is left afterwards.
 */
export async function runPipelineChild(input: PipelineChildInput): Promise<PipelineResult> {
  const { graph, task, event, repoRoot, signal } = input;
  if (signal.aborted) return { exitCode: 130, error: 'Stopped before it started.', run: null };

  const dir = await mkdtemp(join(tmpdir(), 'relay-workflow-'));
  const overlayPath = join(dir, 'config.json');
  await writeFile(overlayPath, JSON.stringify(pipelineOverlay(graph, event), null, 2), { mode: 0o600 });

  const childEnv: NodeJS.ProcessEnv = { ...input.env, [CONFIG_OVERLAY_VARIABLE]: overlayPath, NO_COLOR: '1', FORCE_COLOR: '0' };
  // The workflow's own credentials stop here. They are for its steps, and the
  // run this starts hands its environment on to agents and a test suite.
  for (const name of Object.keys(childEnv)) if (isWorkflowCredential(name)) delete childEnv[name];
  if (event.attended) delete childEnv[RUN_TRIGGER_VARIABLE];
  else childEnv[RUN_TRIGGER_VARIABLE] = JSON.stringify({ label: triggerLabel(event, graph), actor: event.actor, at: event.at });

  try {
    return await new Promise<PipelineResult>((resolve) => {
      const child = spawn(input.launcher.command, [...input.launcher.args, ...runArguments(task)], {
        cwd: repoRoot,
        env: childEnv,
        // Never this process's terminal: nothing in the run may wait for an answer nobody will type.
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        detached: true,
        windowsHide: true,
      });
      child.stdin?.end();
      watchChild(child);

      let summary: PipelineRun | null = null;
      let summaryExit: number | null = null;
      let stderr = '';
      let settled = false;
      let escalate: NodeJS.Timeout | undefined;

      const onAbort = (): void => {
        if (process.platform === 'win32') child.kill();
        else child.kill('SIGINT');
        escalate = setTimeout(() => killTree(child, 'SIGTERM'), CANCEL_GRACE_MS);
        escalate.unref();
      };
      signal.addEventListener('abort', onAbort, { once: true });

      const finish = (result: PipelineResult): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        if (escalate !== undefined) clearTimeout(escalate);
        resolve(result);
      };

      const stdout = createLineSplitter((line) => {
        const data = parseJsonLine(line);
        if (data === undefined) return;
        if (data['type'] === 'summary') {
          summary = (data['run'] ?? null) as PipelineRun | null;
          summaryExit = typeof data['exitCode'] === 'number' ? data['exitCode'] : null;
        }
        input.onLine(data);
      });
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => stdout.push(chunk));
      child.stderr?.on('data', (chunk: string) => {
        stderr = (stderr + chunk).slice(-16_000);
      });
      child.on('error', (error) => {
        stdout.flush();
        finish({ exitCode: null, error: error.message, run: summary });
      });
      child.on('close', (code) => {
        stdout.flush();
        const exitCode = signal.aborted ? 130 : (summaryExit ?? code);
        finish({ exitCode, error: exitCode === 0 ? null : lastError(stderr), run: summary });
      });
    });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
