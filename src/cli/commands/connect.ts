import { discoverRepository } from '../../git/repository.ts';
import { packageVersion } from '../../update/installation.ts';
import { isRelayError, RelayError } from '../../util/errors.ts';
import { loadPairingToken, pairingPath, pairingUrl } from '../../studio/pairing.ts';
import { openInBrowser } from '../../studio/open.ts';
import { DEFAULT_COMPANION_PORT, DEFAULT_STUDIO_URL, type CompanionRepository, type CompanionRunView } from '../../studio/protocol.ts';
import { selfLauncher, StudioRuns } from '../../studio/runs.ts';
import { createCompanion, normalizeOrigin, type CompanionEvent } from '../../studio/server.ts';
import { EXIT } from '../exit.ts';
import { emitJsonLine } from '../json.ts';
import { banner, dim, failure, hint, out, rows, success, theme, warning } from '../output.ts';

export interface ConnectOptions {
  port?: string;
  studio?: string;
  allowOrigin?: string[];
  /** `--open` forces the pairing page open, `--no-open` never opens it; unset opens it on a new token. */
  open?: boolean;
  newToken?: boolean;
  json?: boolean;
}

/** A studio running from a checkout (`cd web && npm run dev`) is always allowed. */
const LOCAL_STUDIO_ORIGINS = ['http://localhost:3000', 'http://127.0.0.1:3000'];

/**
 * `relay connect`: make this machine the studio's hands.
 *
 * The workflow studio is where a workflow is drawn, validated and compiled —
 * in a browser, hosted or local. This is where the coding CLIs, their
 * sign-ins and the repository are. `connect` starts a small server on the
 * loopback interface that a paired studio can ask to:
 *
 *   - report and start the coding CLIs' own sign-ins,
 *   - run a workflow's pipeline for real in this repository, and stream it,
 *   - install a workflow's export into this repository.
 *
 * Pairing is one link: it opens the studio with the port and a token in the
 * URL fragment, which the browser keeps to itself. After that the studio
 * finds this companion on its own whenever it is running.
 */
export async function connectCommand(options: ConnectOptions = {}): Promise<number> {
  const json = options.json === true;
  const studio = studioUrl(options.studio);
  const port = parsePort(options.port ?? process.env['RELAY_COMPANION_PORT'] ?? String(DEFAULT_COMPANION_PORT));
  const origins = [...new Set([normalizeOrigin(studio), ...LOCAL_STUDIO_ORIGINS, ...(options.allowOrigin ?? []).map(checkedOrigin)])];
  const repository = await findRepository();
  const { token, created } = await loadPairingToken({ rotate: options.newToken === true });
  const version = await packageVersion().catch(() => 'unknown');

  const log = (event: CompanionEvent): void => {
    if (json) emitJsonLine('connect', { type: 'event', at: new Date().toISOString(), event });
    else printEvent(event);
  };
  const runs =
    repository === null
      ? null
      : new StudioRuns(repository.root, selfLauncher(), (view) => {
          if (view.status === 'exited') log({ kind: 'run-finished', message: finishedMessage(view) });
        });

  const companion = createCompanion({ token, origins, version, repository, runs, log });
  let bound: number;
  try {
    bound = await companion.listen(port);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      throw new RelayError(`Port ${port} is already in use — probably another \`relay connect\`.`, {
        code: 'PORT_IN_USE',
        hint: `Stop the other one, or start this one elsewhere: relay connect --port ${port + 1}\nThe pairing link carries the port, so the studio follows.`,
      });
    }
    throw error;
  }

  const link = pairingUrl(studio, bound, token);
  const shouldOpen = options.open ?? (created && theme().interactive && !json);
  const opened = shouldOpen ? await openInBrowser(link) : false;

  if (json) {
    emitJsonLine('connect', {
      type: 'listening',
      at: new Date().toISOString(),
      url: `http://127.0.0.1:${bound}`,
      port: bound,
      studio,
      origins,
      pairUrl: link,
      newToken: created,
      repository,
    });
  } else {
    printHeader({ bound, studio, repository, link, opened, created });
  }

  await untilStopped(runs, json);
  await companion.close();
  if (json) emitJsonLine('connect', { type: 'stopped', at: new Date().toISOString() });
  else out(dim('  Companion stopped. The studio falls back to simulated runs until it is back.'));
  return EXIT.success;
}

function studioUrl(flag: string | undefined): string {
  const raw = flag ?? process.env['RELAY_STUDIO_URL'] ?? DEFAULT_STUDIO_URL;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('not http');
    return url.toString().replace(/\/+$/, '');
  } catch {
    throw new RelayError(`"${raw}" is not a studio URL.`, { code: 'BAD_FLAG', hint: 'Pass the address you open the studio at, e.g. --studio http://localhost:3000' });
  }
}

function checkedOrigin(value: string): string {
  try {
    return normalizeOrigin(value);
  } catch {
    throw new RelayError(`"${value}" is not an origin.`, { code: 'BAD_FLAG', hint: 'An origin is a scheme, a host and maybe a port: https://studio.example.com' });
  }
}

export function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new RelayError(`"${value}" is not a port.`, { code: 'BAD_FLAG', hint: `Ports run from 1 to 65535; the studio looks on ${DEFAULT_COMPANION_PORT} first.` });
  }
  return port;
}

/** The repository runs and installs go to, or null: sign-ins still work from anywhere. */
async function findRepository(): Promise<CompanionRepository | null> {
  try {
    const repo = await discoverRepository(process.cwd());
    return { root: repo.root, owner: repo.owner, name: repo.name, defaultBranch: repo.defaultBranch };
  } catch (error) {
    if (isRelayError(error) && (error.code === 'NOT_A_REPOSITORY' || error.code === 'EMPTY_REPOSITORY')) return null;
    throw error;
  }
}

function printHeader(input: { bound: number; studio: string; repository: CompanionRepository | null; link: string; opened: boolean; created: boolean }): void {
  const { bound, studio, repository, link, opened, created } = input;
  banner('the studio’s companion on this machine');
  rows([
    { label: 'Studio', value: studio },
    { label: 'Listening', value: `http://127.0.0.1:${bound} ${dim('(this machine only)')}` },
    {
      label: 'Repository',
      value:
        repository === null
          ? warning('none — sign-ins only. Start it inside a repository to run workflows there.')
          : `${repository.owner !== null && repository.name !== null ? `${repository.owner}/${repository.name}  ` : ''}${dim(repository.root)}`,
    },
  ]);
  out();
  if (opened) {
    out(`  ${success('Opened the studio to pair it.')} If it did not open, use this link:`);
  } else {
    out(created ? '  Pair the studio by opening this link:' : '  Paired studios reconnect on their own. To pair another browser, open:');
  }
  out(`  ${link}`);
  hint(`The link holds this machine's pairing token (${pairingPath()}); treat it like a password.`);
  hint('`relay connect --new-token` unpairs every studio that has it.');
  out();
  hint('Leave this running while you use the studio. Ctrl-C stops it.');
  out();
}

function printEvent(event: CompanionEvent): void {
  const time = new Date().toTimeString().slice(0, 8);
  const text =
    event.kind === 'error' ? failure(event.message) : event.kind === 'refused' ? warning(event.message) : event.kind === 'paired' ? success(event.message) : event.message;
  out(`  ${dim(time)}  ${text}`);
}

function finishedMessage(view: CompanionRunView): string {
  const name = `"${view.workflow.name}"${view.runId === null ? '' : ` (${view.runId})`}`;
  if (view.exitCode === EXIT.success) return `Finished ${name}.`;
  if (view.exitCode === EXIT.cancelled) return `Stopped ${name}.`;
  return `${name} ended with exit code ${view.exitCode ?? 'unknown'}${view.runId === null ? '' : ` — relay logs ${view.runId}`}.`;
}

/**
 * Waits for Ctrl-C. With runs in flight the first one only warns: those runs
 * are somebody's work in progress, started from a browser that may not be
 * looking. The second stops them the way `relay stop` does — the work so far
 * stays committed on their branches — and then the companion leaves.
 */
function untilStopped(runs: StudioRuns | null, json: boolean): Promise<void> {
  return new Promise((resolve) => {
    let warned = false;
    let stopping = false;
    const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
    const finish = () => {
      for (const signal of signals) process.off(signal, onSignal);
      resolve();
    };
    const onSignal = (signal: NodeJS.Signals): void => {
      if (stopping) {
        finish();
        return;
      }
      const active = runs?.active() ?? [];
      if (active.length === 0) {
        stopping = true;
        if (!json) out();
        finish();
        return;
      }
      if (!warned && signal === 'SIGINT') {
        warned = true;
        if (!json) {
          out();
          out(warning(`  ${active.length} run${active.length === 1 ? '' : 's'} the studio started ${active.length === 1 ? 'is' : 'are'} still going.`));
          hint('Press Ctrl-C again to stop them — work so far stays on their branches — and quit.');
        }
        return;
      }
      stopping = true;
      if (!json) out(dim(`  Stopping ${active.length} run${active.length === 1 ? '' : 's'}…`));
      void Promise.all(active.map((view) => runs?.cancel(view.id)))
        .then(() => runs?.settled(30_000))
        .finally(finish);
    };
    for (const signal of signals) process.on(signal, onSignal);
  });
}
