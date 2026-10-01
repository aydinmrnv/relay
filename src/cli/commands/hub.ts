import { readFile } from 'node:fs/promises';

import { AzureDriver, type AzureCredential } from '../../cloud/hub/azure.ts';
import { ClerkVerifier, clerkIssuerFromPublishableKey, DEFAULT_OWN_TOKEN_TTL_MS, mintRunnerToken } from '../../cloud/hub/auth.ts';
import { RUN_USER, runnerCloudInit } from '../../cloud/hub/cloudInit.ts';
import { Fleet, type FleetEvent } from '../../cloud/hub/fleet.ts';
import { createHub, StaticVerifier, type HubLogEntry, type SessionVerifier } from '../../cloud/hub/server.ts';
import { DEFAULT_STUDIO_URL } from '../../studio/protocol.ts';
import { packageVersion } from '../../update/installation.ts';
import { errorMessage, RelayError } from '../../util/errors.ts';
import { EXIT } from '../exit.ts';
import { out } from '../output.ts';

/**
 * `relay hub serve`: the Relay Cloud hub.
 *
 * Configured entirely by the environment, so a systemd unit with an
 * `EnvironmentFile` is the whole deployment (scripts/azure/deploy-hub.sh
 * writes both). Without the `RELAY_CLOUD_*` machine settings the hub makes no
 * machines and only routes to runners that dial in with a token of their own.
 */

export interface HubConfig {
  port: number;
  host: string;
  publicUrl: string | null;
  secret: string;
  /** Secrets the hub used before this one. Tokens they signed are still read; new tokens are signed with `secret`. */
  previousSecrets: string[];
  origins: string[];
  adminToken: string | null;
  tarball: string | null;
  sessions: { kind: 'clerk'; issuer: string; jwksUrl: string | null } | { kind: 'dev'; users: Array<[string, string]> };
  cloud: {
    subscriptionId: string;
    resourceGroup: string;
    credential: AzureCredential;
    regions: string[];
    vmSize: string;
    cores: number;
    image: string;
    osDiskType: 'Standard_LRS' | 'StandardSSD_LRS' | 'Premium_LRS';
    osDiskGb: number;
    sshPublicKey: string;
    adminUser: string;
    maxRuns: number;
    idleMinutes: number;
    maxMachines: number;
    allowedUsers: '*' | string[];
  } | null;
}

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function number(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) throw new RelayError(`${name}=${raw} is not a number from ${min} to ${max}.`, { code: 'BAD_CONFIG' });
  return value;
}

async function secretFrom(env: NodeJS.ProcessEnv, name: string): Promise<string | null> {
  const direct = env[name]?.trim();
  if (direct !== undefined && direct.length > 0) return direct;
  const file = env[`${name}_FILE`]?.trim();
  if (file !== undefined && file.length > 0) return (await readFile(file, 'utf8')).trim();
  return null;
}

/**
 * The secrets the hub used before its current one: `RELAY_HUB_SECRET_PREVIOUS`
 * (comma-separated), or one per line in `RELAY_HUB_SECRET_PREVIOUS_FILE`. A
 * file that is not there is no previous secret, so the same environment file
 * serves a hub that has never rotated.
 *
 * This is what makes rotating the hub's secret something an operator can do
 * on a running fleet. With the old secret listed here, a restarted hub still
 * reads the token every awake machine holds, and signs new ones with the new
 * secret. Every machine gets a new token at its next start, so once each has
 * slept and woken the old secret signs nothing in use and can be dropped;
 * dropping it at once instead is how every token the old secret signed is
 * revoked together. Hand-minted tokens are re-minted by hand.
 */
async function previousSecrets(env: NodeJS.ProcessEnv): Promise<string[]> {
  const name = 'RELAY_HUB_SECRET_PREVIOUS';
  let raw = env[name] ?? '';
  const file = env[`${name}_FILE`]?.trim();
  if (raw.trim().length === 0 && file !== undefined && file.length > 0) {
    raw = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
  }
  const secrets = raw
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  for (const secret of secrets) {
    if (secret.length < 32) throw new RelayError(`${name} holds a secret shorter than 32 characters.`, { code: 'BAD_CONFIG' });
  }
  return secrets;
}

export async function readHubConfig(env: NodeJS.ProcessEnv = process.env): Promise<HubConfig> {
  const secret = await secretFrom(env, 'RELAY_HUB_SECRET');
  if (secret === null || secret.length < 32) {
    throw new RelayError('RELAY_HUB_SECRET must be set, at least 32 characters.', { code: 'BAD_CONFIG', hint: 'openssl rand -base64 48, kept in the hub\'s environment file. Runner tokens are signed with it.' });
  }

  let sessions: HubConfig['sessions'];
  const devUsers = list(env['RELAY_HUB_DEV_USERS']);
  if (devUsers.length > 0) {
    if (env['RELAY_HUB_DEV'] !== '1') throw new RelayError('RELAY_HUB_DEV_USERS is for development only; set RELAY_HUB_DEV=1 to use it.', { code: 'BAD_CONFIG' });
    sessions = {
      kind: 'dev',
      users: devUsers.map((pair) => {
        const [token, user] = pair.split('=');
        if (token === undefined || user === undefined || token.length < 16) throw new RelayError('RELAY_HUB_DEV_USERS is token=user pairs, tokens of 16 characters or more.', { code: 'BAD_CONFIG' });
        return [token, user] as [string, string];
      }),
    };
  } else {
    const issuer = env['RELAY_HUB_CLERK_ISSUER']?.trim() || (env['CLERK_PUBLISHABLE_KEY'] ? clerkIssuerFromPublishableKey(env['CLERK_PUBLISHABLE_KEY']) : '');
    if (issuer.length === 0) throw new RelayError('Set CLERK_PUBLISHABLE_KEY (or RELAY_HUB_CLERK_ISSUER) so the hub can check who is signed in.', { code: 'BAD_CONFIG' });
    sessions = { kind: 'clerk', issuer, jwksUrl: env['RELAY_HUB_CLERK_JWKS_URL']?.trim() || null };
  }

  const origins = list(env['RELAY_HUB_STUDIO_ORIGINS']);
  const publicUrl = env['RELAY_HUB_PUBLIC_URL']?.trim() || null;

  let cloud: HubConfig['cloud'] = null;
  const subscriptionId = env['AZURE_SUBSCRIPTION_ID']?.trim();
  if (subscriptionId !== undefined && subscriptionId.length > 0) {
    const regions = list(env['RELAY_CLOUD_REGIONS']);
    if (regions.length === 0) throw new RelayError('RELAY_CLOUD_REGIONS must list at least one Azure region.', { code: 'BAD_CONFIG' });
    if (publicUrl === null) throw new RelayError('RELAY_HUB_PUBLIC_URL must be set: it is the address the machines dial.', { code: 'BAD_CONFIG' });
    const sshPublicKey = env['RELAY_CLOUD_SSH_KEY']?.trim() ?? '';
    if (!/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-\S+) /.test(sshPublicKey)) throw new RelayError('RELAY_CLOUD_SSH_KEY must be an SSH public key; Azure requires one on every Linux VM.', { code: 'BAD_CONFIG' });
    const credential = (env['RELAY_CLOUD_CREDENTIAL']?.trim() || 'managed-identity') as AzureCredential;
    if (credential !== 'managed-identity' && credential !== 'azure-cli') throw new RelayError('RELAY_CLOUD_CREDENTIAL is managed-identity or azure-cli.', { code: 'BAD_CONFIG' });
    const disk = env['RELAY_CLOUD_DISK']?.trim() || 'StandardSSD_LRS';
    if (disk !== 'Standard_LRS' && disk !== 'StandardSSD_LRS' && disk !== 'Premium_LRS') throw new RelayError('RELAY_CLOUD_DISK is Standard_LRS, StandardSSD_LRS or Premium_LRS.', { code: 'BAD_CONFIG' });
    const allowed = env['RELAY_CLOUD_ALLOWED_USERS']?.trim() ?? '';
    const adminUser = env['RELAY_CLOUD_ADMIN_USER']?.trim() || 'relay';
    // Azure gives the admin user sudo without a password; the runner and its agents run as RUN_USER, which has none.
    if (adminUser === RUN_USER) throw new RelayError(`RELAY_CLOUD_ADMIN_USER cannot be "${RUN_USER}": that is the unprivileged user the runner runs as.`, { code: 'BAD_CONFIG' });
    cloud = {
      subscriptionId,
      resourceGroup: env['RELAY_CLOUD_RESOURCE_GROUP']?.trim() || 'relay-cloud',
      credential,
      regions,
      vmSize: env['RELAY_CLOUD_VM_SIZE']?.trim() || 'Standard_B2ats_v2',
      cores: number(env, 'RELAY_CLOUD_CORES', 2, 1, 64),
      image: env['RELAY_CLOUD_IMAGE']?.trim() || 'Canonical:ubuntu-24_04-lts:server:latest',
      osDiskType: disk,
      osDiskGb: number(env, 'RELAY_CLOUD_DISK_GB', 32, 30, 1024),
      sshPublicKey,
      adminUser,
      maxRuns: number(env, 'RELAY_CLOUD_RUNNER_MAX_RUNS', 1, 1, 8),
      idleMinutes: number(env, 'RELAY_CLOUD_IDLE_MINUTES', 10, 1, 24 * 60),
      maxMachines: number(env, 'RELAY_CLOUD_MAX_MACHINES', 20, 0, 10_000),
      allowedUsers: allowed === '*' ? '*' : list(allowed),
    };
  }

  return {
    port: number(env, 'RELAY_HUB_PORT', 8080, 1, 65_535),
    host: env['RELAY_HUB_HOST']?.trim() || '127.0.0.1',
    publicUrl,
    secret,
    previousSecrets: (await previousSecrets(env)).filter((previous) => previous !== secret),
    origins: origins.length > 0 ? origins : [DEFAULT_STUDIO_URL, 'http://localhost:3000'],
    adminToken: await secretFrom(env, 'RELAY_HUB_ADMIN_TOKEN'),
    tarball: env['RELAY_HUB_TARBALL']?.trim() || null,
    sessions,
    cloud,
  };
}

/**
 * Keeps the hub serving through an error nothing caught.
 *
 * Node's answer to an unhandled rejection or an uncaught exception is to end
 * the process, and for most programs that is right: the state may be wrong,
 * so start again. For the hub it is the worse failure. One process holds
 * every person's runner link and every open run stream, so ending it turns a
 * bug in one request into an outage for everyone, and a request that can
 * trigger it into a way to keep the hub down for as long as someone repeats
 * it. And the hub has little state to be wrong: what it knows about machines
 * is rebuilt from Azure every thirty seconds, and a link or a stream that was
 * left half-done times out on its own.
 *
 * So the error is logged, loudly, with its stack, and the hub carries on.
 * The handlers in `createHub` are meant to make this unreachable; when a line
 * from here shows up in the journal, that is a bug to fix, not noise.
 *
 * Returns the function that removes the handlers again.
 */
export function keepServing(log: (entry: HubLogEntry) => void, target: Pick<NodeJS.Process, 'on' | 'off'> = process): () => void {
  const describe = (error: unknown): { error: string; stack?: string } =>
    error instanceof Error && error.stack !== undefined ? { error: error.message, stack: error.stack } : { error: errorMessage(error) };
  const say = (msg: string, error: unknown): void => {
    try {
      log({ level: 'error', msg, ...describe(error) });
    } catch {
      // A log line that cannot be written is not a reason to stop either.
    }
  };
  const onRejection = (reason: unknown): void => say('unhandled rejection; the hub keeps serving', reason);
  const onException = (error: Error): void => say('uncaught exception; the hub keeps serving', error);
  target.on('unhandledRejection', onRejection);
  target.on('uncaughtException', onException);
  return () => {
    target.off('unhandledRejection', onRejection);
    target.off('uncaughtException', onException);
  };
}

export async function hubServeCommand(options: { json?: boolean } = {}): Promise<number> {
  const config = await readHubConfig();
  const version = await packageVersion().catch(() => 'unknown');
  const logLine = (entry: HubLogEntry): void => {
    const line = { at: new Date().toISOString(), ...entry };
    if (options.json === true || !process.stdout.isTTY) process.stdout.write(`${JSON.stringify(line)}\n`);
    else out(`  ${line.at.slice(11, 19)}  ${entry.level === 'info' ? '' : `${entry.level}: `}${entry.msg}${Object.keys(entry).length > 2 ? `  ${JSON.stringify(Object.fromEntries(Object.entries(entry).filter(([key]) => key !== 'level' && key !== 'msg')))}` : ''}`);
  };
  // From here on: a bad configuration above still ends the command with its message.
  const stopKeeping = keepServing(logLine);
  try {
    return await serveHub(config, version, logLine);
  } finally {
    stopKeeping();
  }
}

async function serveHub(config: HubConfig, version: string, logLine: (entry: HubLogEntry) => void): Promise<number> {

  const cloud = config.cloud;
  const driver =
    cloud === null
      ? null
      : new AzureDriver({
          subscriptionId: cloud.subscriptionId,
          resourceGroup: cloud.resourceGroup,
          credential: cloud.credential,
          vmSize: cloud.vmSize,
          image: cloud.image,
          osDiskType: cloud.osDiskType,
          osDiskGb: cloud.osDiskGb,
          adminUser: cloud.adminUser,
          sshPublicKey: cloud.sshPublicKey,
          customData: () => runnerCloudInit({ hubUrl: config.publicUrl!, maxRuns: cloud.maxRuns, adminUser: cloud.adminUser }),
        });

  const fleet = new Fleet({
    driver,
    regions: cloud?.regions ?? [],
    coresPerRunner: cloud?.cores ?? 2,
    tokenFor: (runner, userId) => mintRunnerToken(config.secret, { runner, userId }, { kind: 'managed' }),
    admit: (userId) => {
      if (cloud === null || cloud.allowedUsers === '*' || cloud.allowedUsers.includes(userId)) return null;
      return 'Relay Cloud is invite-only for now. Ask to be let in, or run on your own machine with `relay connect`.';
    },
    maxMachines: cloud?.maxMachines ?? 0,
    idleMs: (cloud?.idleMinutes ?? 10) * 60_000,
    log: (event: FleetEvent) => logLine({ level: event.kind === 'error' ? 'warn' : 'info', msg: event.message, event: event.kind, ...(event.region === undefined ? {} : { region: event.region }) }),
  });

  let sessions: SessionVerifier;
  if (config.sessions.kind === 'dev') {
    sessions = new StaticVerifier(config.sessions.users);
    logLine({ level: 'warn', msg: 'development sign-in: fixed tokens from RELAY_HUB_DEV_USERS. Never expose this hub.' });
  } else {
    const verifier = new ClerkVerifier({ issuer: config.sessions.issuer, authorizedParties: config.origins, ...(config.sessions.jwksUrl === null ? {} : { jwksUrl: config.sessions.jwksUrl }) });
    await verifier.refresh().catch((error: unknown) => logLine({ level: 'warn', msg: `could not load Clerk's keys yet: ${errorMessage(error)}` }));
    sessions = verifier;
  }

  if (config.previousSecrets.length > 0) {
    logLine({ level: 'info', msg: `still reading runner tokens signed by ${config.previousSecrets.length} earlier secret${config.previousSecrets.length === 1 ? '' : 's'}; drop RELAY_HUB_SECRET_PREVIOUS once every machine has been started again` });
  }
  const hub = createHub({ fleet, secret: config.secret, previousSecrets: config.previousSecrets, sessions, origins: config.origins, version, adminToken: config.adminToken, tarballPath: config.tarball, log: logLine });
  const port = await hub.listen(config.port, config.host);
  logLine({ level: 'info', msg: `hub listening on ${config.host}:${port}`, version, machines: driver === null ? 'none (runners dial in on their own)' : `${cloud?.vmSize} in ${cloud?.regions.join(', ')}` });

  // The cloud is read before anyone is admitted, so a restarted hub knows every machine it made.
  await fleet.reconcile().catch((error: unknown) => logLine({ level: 'warn', msg: `could not read the machines yet: ${errorMessage(error)}` }));

  let reconciling = false;
  const reconcileTimer = setInterval(() => {
    if (reconciling) return;
    reconciling = true;
    void fleet
      .reconcile()
      .catch((error: unknown) => logLine({ level: 'warn', msg: `reading the machines failed: ${errorMessage(error)}` }))
      .finally(() => {
        reconciling = false;
      });
  }, 30_000);
  const tickTimer = setInterval(() => void fleet.tick().catch((error: unknown) => logLine({ level: 'error', msg: `tick failed: ${errorMessage(error)}` })), 10_000);

  await new Promise<void>((resolve) => {
    const stop = () => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      resolve();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
  clearInterval(reconcileTimer);
  clearInterval(tickTimer);
  logLine({ level: 'info', msg: 'hub stopping' });
  await hub.close();
  return EXIT.success;
}

export async function hubTokenCommand(options: { user: string; runner: string }): Promise<number> {
  const secret = await secretFrom(process.env, 'RELAY_HUB_SECRET');
  if (secret === null || secret.length < 32) throw new RelayError('RELAY_HUB_SECRET must be set to the hub\'s secret.', { code: 'BAD_CONFIG' });
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(options.runner)) throw new RelayError('A runner name is lower-case letters, digits and dashes.', { code: 'BAD_FLAG' });
  // A token for a runner someone starts themselves is good for a while, not
  // for ever: thirty days unless RELAY_HUB_TOKEN_TTL_DAYS says otherwise.
  const days = number(process.env, 'RELAY_HUB_TOKEN_TTL_DAYS', DEFAULT_OWN_TOKEN_TTL_MS / (24 * 60 * 60_000), 1, 365);
  const minted = mintRunnerToken(secret, { runner: options.runner, userId: options.user }, { kind: 'own', ttlMs: days * 24 * 60 * 60_000 });
  process.stdout.write(`${minted.token}\n`);
  // On stderr, so `RELAY_RUNNER_TOKEN=$(relay hub token …)` still captures only the token.
  process.stderr.write(`Expires ${new Date(minted.expiresAt).toISOString()}. Mint another before then; the hub refuses this one after.\n`);
  return EXIT.success;
}
