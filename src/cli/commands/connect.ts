import { discoverRepository } from '../../git/repository.ts';
import { packageVersion } from '../../update/installation.ts';
import { isRelayError, RelayError } from '../../util/errors.ts';
import { loadPairingToken, pairingPath, pairingUrl } from '../../studio/pairing.ts';
import { openInBrowser } from '../../studio/open.ts';
import { DEFAULT_COMPANION_PORT, DEFAULT_STUDIO_URL, type CompanionRepository, type CompanionRunView, type HelloResponse } from '../../studio/protocol.ts';
import { selfLauncher, StudioRuns } from '../../studio/runs.ts';
import { parseTokenSource, startRunner } from '../../cloud/runner.ts';
import { createCompanion, normalizeOrigin, type CompanionEvent } from '../../studio/server.ts';
import { EXIT } from '../exit.ts';
import { emitJsonLine } from '../json.ts';
import { banner, dim, failure, hint, out, rows, success, theme, warning } from '../output.ts';

export interface ConnectOptions {
  /** Dial out to a Relay Cloud hub instead of listening on 127.0.0.1. */
  hub?: string;
  /** Where the runner token comes from with `--hub`: env, azure or file:<path>. */
  tokenFrom?: string;
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
 * How long an already-paired studio gets to find a restarted companion before
 * the studio is opened anyway. An open studio tab checks every few seconds
 * while its machine is away, so one that is there answers well inside this.
 */
const RECONNECT_GRACE_MS = 8_000;

/** How long to wait for any studio before explaining what usually went wrong. */
const PAIRING_HINT_MS = 30_000;

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
  const hub = options.hub ?? process.env['RELAY_HUB_URL'];
  if (hub !== undefined && hub.length > 0) return runnerCommand(hub, options);
  const json = options.json === true;
  const studio = studioUrl(options.studio);
  const port = parsePort(options.port ?? process.env['RELAY_COMPANION_PORT'] ?? String(DEFAULT_COMPANION_PORT));
  const origins = [...new Set([normalizeOrigin(studio), ...LOCAL_STUDIO_ORIGINS, ...(options.allowOrigin ?? []).map(checkedOrigin)])];
  const repository = await findRepository();
  const { token, created } = await loadPairingToken({ rotate: options.newToken === true });
  const version = await packageVersion().catch(() => 'unknown');

  let paired = false;
  const waiting: NodeJS.Timeout[] = [];
  const log = (event: CompanionEvent): void => {
    if (event.kind === 'paired' && !paired) {
      paired = true;
      for (const timer of waiting) clearTimeout(timer);
    }
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
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') throw await portInUse(port, token, repository);
    throw error;
  }

  const link = pairingUrl(studio, bound, token);
  // Opening the studio is the next step for a person at a terminal, so it
  // happens unless asked not to: at once for a new pairing, and otherwise
  // only if no paired studio tab picks the restarted companion up by itself.
  const interactive = theme().interactive && !json;
  const openNow = options.open === true || (options.open === undefined && created && interactive);
  const openLater = options.open === undefined && !created && interactive;
  const opened = openNow ? await openInBrowser(link) : false;

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
    printHeader({ bound, studio, repository, link, opened, created, openLater });
  }

  // A studio can say hello while the browser is still being opened above, so
  // each timer checks again when it fires.
  if (openLater) {
    waiting.push(
      setTimeout(() => {
        if (paired) return;
        void openInBrowser(link).then((ok) => {
          if (ok && !paired) out(`  ${dim(time())}  Opened the studio.`);
        });
      }, RECONNECT_GRACE_MS),
    );
  }
  if (!json) {
    waiting.push(
      setTimeout(() => {
        if (!paired) printPairingHelp(link);
      }, (openLater ? RECONNECT_GRACE_MS : 0) + PAIRING_HINT_MS),
    );
  }
  for (const timer of waiting) timer.unref();

  await untilStopped(runs, json);
  for (const timer of waiting) clearTimeout(timer);
  await companion.close();
  if (json) emitJsonLine('connect', { type: 'stopped', at: new Date().toISOString() });
  else out(dim('  Companion stopped. The studio falls back to simulated runs until it is back.'));
  return EXIT.success;
}

/**
 * `relay connect --hub`: this machine as a Relay Cloud runner. No port and no
 * pairing link; it dials out to the hub and serves the studio through it.
 */
async function runnerCommand(hub: string, options: ConnectOptions): Promise<number> {
  const json = options.json === true;
  try {
    const url = new URL(hub);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('not http');
  } catch {
    throw new RelayError(`"${hub}" is not a hub address.`, { code: 'BAD_FLAG', hint: 'Pass the hub\'s URL, e.g. --hub https://hub.example.com' });
  }
  const version = await packageVersion().catch(() => 'unknown');
  const log = (event: CompanionEvent): void => {
    if (json) emitJsonLine('connect', { type: 'event', at: new Date().toISOString(), event });
    else printEvent(event);
  };
  const runner = startRunner({ hub, tokenFrom: parseTokenSource(options.tokenFrom), version, log });
  if (json) emitJsonLine('connect', { type: 'dialing', at: new Date().toISOString(), hub, version });
  else {
    banner('a Relay Cloud runner');
    rows([
      { label: 'Hub', value: hub },
      { label: 'Repositories', value: dim('each run names its own; checkouts live in ~/.relay/repos') },
    ]);
    out();
    hint('Leave this running. Ctrl-C stops it; runs in flight are asked to stop first.');
    out();
  }
  await untilStopped(runner.runs, json);
  await runner.link.stop();
  if (json) emitJsonLine('connect', { type: 'stopped', at: new Date().toISOString() });
  else out(dim('  Runner stopped.'));
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

function printHeader(input: { bound: number; studio: string; repository: CompanionRepository | null; link: string; opened: boolean; created: boolean; openLater: boolean }): void {
  const { bound, studio, repository, link, opened, created, openLater } = input;
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
  if (opened) out(`  ${success('Opened the studio to pair it.')} If it did not open, use this link:`);
  else if (openLater) out('  A studio you paired before reconnects by itself; if none has in a few seconds, this opens:');
  else out(created ? '  Pair the studio by opening this link:' : '  To pair a studio, open:');
  out(`  ${link}`);
  hint('Your browser may ask whether the studio may reach apps on this device. Choose Allow: that is this companion.');
  hint(`The link holds this machine's pairing token (${pairingPath()}); treat it like a password. \`relay connect --new-token\` unpairs every studio that has it.`);
  out();
  hint('Leave this running while you use the studio. Ctrl-C stops it.');
  out();
}

/** Printed once, when nothing has paired a while after the link went out. */
function printPairingHelp(link: string): void {
  out();
  out(warning('  No studio has connected yet.'));
  hint('If the browser asked whether the studio may reach apps on this device (local network access), choose Allow.');
  hint('If it was blocked: open the site settings from the icon left of the address, allow local network access, and press Try again.');
  hint(`Or open the link again: ${link}`);
  out();
}

/**
 * Explains a taken port. A companion already there answers this machine's own
 * token, so it can say which repository it serves; anything else is a
 * different program.
 */
async function portInUse(port: number, token: string, repository: CompanionRepository | null): Promise<RelayError> {
  const other = await probeCompanion(port, token);
  if (other === null) {
    return new RelayError(`Port ${port} is taken by another program.`, {
      code: 'PORT_IN_USE',
      hint: `Start the companion on another port: relay connect --port ${port + 1}\nThe pairing link carries the port, so the studio follows.`,
    });
  }
  const where = other.repository === null || other.repository === undefined ? 'outside any repository' : `for ${other.repository.root}`;
  const same = other.repository?.root !== undefined && other.repository.root === repository?.root;
  return new RelayError(same ? `\`relay connect\` is already running for this repository, on port ${port}.` : `\`relay connect\` is already running on port ${port}, ${where}.`, {
    code: 'PORT_IN_USE',
    hint: same
      ? 'Nothing more to start: the studio talks to that one. Stop it with Ctrl-C in its terminal to restart it.'
      : `Stop that one with Ctrl-C in its terminal and run this again, or run both: relay connect --port ${port + 1}\nThe studio talks to one at a time; opening a companion's link switches it.`,
  });
}

/** The companion on a port, if one answers with this machine's token. */
export async function probeCompanion(port: number, token: string): Promise<HelloResponse | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/hello`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(2_000) });
    const body = (await response.json()) as Partial<HelloResponse>;
    return body.product === 'relay' ? (body as HelloResponse) : null;
  } catch {
    return null;
  }
}

function time(): string {
  return new Date().toTimeString().slice(0, 8);
}

function printEvent(event: CompanionEvent): void {
  const text =
    event.kind === 'error' ? failure(event.message) : event.kind === 'refused' ? warning(event.message) : event.kind === 'paired' ? success(event.message) : event.message;
  out(`  ${dim(time())}  ${text}`);
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
