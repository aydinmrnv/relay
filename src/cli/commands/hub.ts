import { readFile } from 'node:fs/promises';

import { AzureDriver, type AzureCredential } from '../../cloud/hub/azure.ts';
import { ClerkVerifier, clerkIssuerFromPublishableKey, mintRunnerToken } from '../../cloud/hub/auth.ts';
import { runnerCloudInit } from '../../cloud/hub/cloudInit.ts';
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
      adminUser: env['RELAY_CLOUD_ADMIN_USER']?.trim() || 'relay',
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
    origins: origins.length > 0 ? origins : [DEFAULT_STUDIO_URL, 'http://localhost:3000'],
    adminToken: await secretFrom(env, 'RELAY_HUB_ADMIN_TOKEN'),
    tarball: env['RELAY_HUB_TARBALL']?.trim() || null,
    sessions,
    cloud,
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
    tokenFor: (runner, userId) => mintRunnerToken(config.secret, { runner, userId }),
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

  const hub = createHub({ fleet, secret: config.secret, sessions, origins: config.origins, version, adminToken: config.adminToken, tarballPath: config.tarball, log: logLine });
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
  process.stdout.write(`${mintRunnerToken(secret, { runner: options.runner, userId: options.user })}\n`);
  return EXIT.success;
}
