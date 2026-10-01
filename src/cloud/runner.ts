import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';

import { relayHome } from '../studio/pairing.ts';
import { createRouter, type CompanionEvent } from '../studio/router.ts';
import { selfLauncher, StudioRuns } from '../studio/runs.ts';
import type { CompanionRunView } from '../studio/protocol.ts';
import { RelayError } from '../util/errors.ts';
import { checkoutRepository } from './checkout.ts';
import { dialOut, type DialOut } from './dialout.ts';

/**
 * A cloud runner: `relay connect --hub <url>`.
 *
 * The companion without a repository of its own and without a port: every run
 * names the GitHub repository it works on, the runner checks it out under
 * `~/.relay/repos/`, and the studio reaches all of it through the hub. It can
 * also sign in to GitHub itself, because nobody else will on a fresh machine.
 */

export type TokenSource = { kind: 'env' } | { kind: 'azure' } | { kind: 'file'; path: string } | { kind: 'stdin' };

export function parseTokenSource(value: string | undefined): TokenSource {
  if (value === undefined || value === 'env') return { kind: 'env' };
  if (value === 'azure') return { kind: 'azure' };
  if (value === 'stdin') return { kind: 'stdin' };
  if (value.startsWith('file:') && value.length > 'file:'.length) return { kind: 'file', path: value.slice('file:'.length) };
  throw new RelayError(`"${value}" is not a token source.`, { code: 'BAD_FLAG', hint: 'Use env (RELAY_RUNNER_TOKEN), stdin, file:<path> or azure (the VM\'s user data).' });
}

/**
 * The runner's token, asked for before every connection.
 *
 *   - `env`: read once and removed from the environment, so no child inherits it.
 *   - `stdin`: read once, to the end, when the runner starts, and kept only in
 *     memory. This is what a machine the hub manages uses. The agents a
 *     runner starts run as the runner's own user and can read whatever that
 *     user can, so the token must never be anywhere that user can read: the
 *     service's root start step reads it and passes it down a pipe to this
 *     process as it drops to the unprivileged user. No file, no environment
 *     variable, nothing in `ps`. (It is still in this process's memory. What
 *     keeps an agent out of that is the kernel's ptrace restriction and the
 *     core-dump limit, both of which the machine's cloud-init sets.)
 *   - `file:<path>`: read every time, so a token someone replaces is picked up
 *     without a restart.
 *   - `azure`: read from the VM's user data through the instance metadata
 *     service every time. For a VM set up by hand. On a machine the hub
 *     manages only root may ask that service, which is the point: whatever
 *     can read user data can read the token.
 */
export function tokenReader(source: TokenSource, fetchImpl: typeof fetch = fetch, readStdin: () => string = () => readFileSync(0, 'utf8')): () => Promise<string> {
  if (source.kind === 'env') {
    const token = process.env['RELAY_RUNNER_TOKEN']?.trim() ?? '';
    delete process.env['RELAY_RUNNER_TOKEN'];
    if (token.length === 0) throw new RelayError('No runner token: set RELAY_RUNNER_TOKEN.', { code: 'NO_RUNNER_TOKEN', hint: 'The hub operator mints one: relay hub token --user <id> --runner <name>' });
    return async () => token;
  }
  if (source.kind === 'stdin') {
    // Now, not at the first connection: an empty pipe is a start that failed,
    // and saying so ends the process so that whatever started it tries again.
    const token = readStdin().trim();
    if (token.length === 0) throw new RelayError('No runner token on standard input.', { code: 'NO_RUNNER_TOKEN', hint: 'Pipe the token in: printf %s "$token" | relay connect --hub <url> --token-from stdin' });
    return async () => token;
  }
  if (source.kind === 'file') {
    return async () => {
      const token = (await readFile(source.path, 'utf8')).trim();
      if (token.length === 0) throw new Error(`${source.path} is empty.`);
      return token;
    };
  }
  return async () => {
    const response = await fetchImpl('http://169.254.169.254/metadata/instance/compute/userData?api-version=2021-01-01&format=text', {
      headers: { Metadata: 'true' },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`the instance metadata service answered ${response.status}`);
    const token = Buffer.from((await response.text()).trim(), 'base64').toString('utf8').trim();
    if (token.length === 0) throw new Error('this VM has no user data');
    return token;
  };
}

export interface RunnerModeOptions {
  hub: string;
  tokenFrom: TokenSource;
  version: string;
  log: (event: CompanionEvent) => void;
  maxRuns?: number;
}

export interface RunnerMode {
  runs: StudioRuns;
  link: DialOut;
}

export function startRunner(options: RunnerModeOptions): RunnerMode {
  const token = tokenReader(options.tokenFrom);
  const reposRoot = join(relayHome(), 'repos');
  const maxRuns = options.maxRuns ?? (Number(process.env['RELAY_RUNNER_MAX_RUNS'] ?? '1') || 1);
  const runs = new StudioRuns(
    null,
    selfLauncher(),
    (view) => {
      if (view.status === 'exited') options.log({ kind: 'run-finished', message: finished(view) });
    },
    { maxConcurrent: maxRuns, checkout: (slug, signal) => checkoutRepository(slug, signal, { root: reposRoot }) },
  );
  const router = createRouter({
    version: options.version,
    repository: null,
    runs,
    capabilities: ['agents', 'runs', 'repositories', 'github'],
    machine: hostname(),
    log: options.log,
  });
  const link = dialOut({
    hub: options.hub,
    token,
    router,
    runs,
    log: (message, level) => options.log({ kind: level === 'error' ? 'error' : level === 'warn' ? 'refused' : 'paired', message }),
  });
  // Stopping the runner stops what it started: a run left behind would go on
  // spending with nothing to report to and nothing able to stop it.
  return {
    runs,
    link: {
      connected: link.connected,
      ready: link.ready,
      stop: async () => {
        await link.stop();
        await runs.shutdown();
      },
    },
  };
}

function finished(view: CompanionRunView): string {
  const name = `"${view.workflow.name}"${view.repository ? ` in ${view.repository}` : ''}`;
  return view.exitCode === 0 ? `Finished ${name}.` : `${name} ended with exit code ${view.exitCode ?? 'unknown'}.`;
}
