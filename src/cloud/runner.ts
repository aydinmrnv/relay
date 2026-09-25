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

export type TokenSource = { kind: 'env' } | { kind: 'azure' } | { kind: 'file'; path: string };

export function parseTokenSource(value: string | undefined): TokenSource {
  if (value === undefined || value === 'env') return { kind: 'env' };
  if (value === 'azure') return { kind: 'azure' };
  if (value.startsWith('file:') && value.length > 'file:'.length) return { kind: 'file', path: value.slice('file:'.length) };
  throw new RelayError(`"${value}" is not a token source.`, { code: 'BAD_FLAG', hint: 'Use env (RELAY_RUNNER_TOKEN), azure (the VM\'s user data) or file:<path>.' });
}

/**
 * The runner's token, fresh every time it is asked. From the environment it
 * is read once and removed, so no child inherits it; on Azure it lives in
 * the VM's user data, which only this machine can read and which the hub can
 * replace, so it is never written to the disk.
 */
export function tokenReader(source: TokenSource, fetchImpl: typeof fetch = fetch): () => Promise<string> {
  if (source.kind === 'env') {
    const token = process.env['RELAY_RUNNER_TOKEN']?.trim() ?? '';
    delete process.env['RELAY_RUNNER_TOKEN'];
    if (token.length === 0) throw new RelayError('No runner token: set RELAY_RUNNER_TOKEN.', { code: 'NO_RUNNER_TOKEN', hint: 'The hub operator mints one: relay hub token --user <id> --runner <name>' });
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
  return { runs, link };
}

function finished(view: CompanionRunView): string {
  const name = `"${view.workflow.name}"${view.repository ? ` in ${view.repository}` : ''}`;
  return view.exitCode === 0 ? `Finished ${name}.` : `${name} ended with exit code ${view.exitCode ?? 'unknown'}.`;
}
