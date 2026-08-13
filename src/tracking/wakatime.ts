import { access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { describeFailure, resolveExecutable, runProcess, type ProcessResult, type ProcessRunOptions } from '../process/runner.ts';
import { errorMessage } from '../util/errors.ts';

export interface HeartbeatFields {
  entity: string;
  project: string;
  branch: string;
  plugin: string;
  category: string;
}

export type ProcessRunner = (
  command: string,
  args: readonly string[],
  options?: ProcessRunOptions,
) => Promise<ProcessResult>;

export type ExecutableResolver = (command: string) => Promise<string | null>;

export function buildHeartbeatArgs(fields: HeartbeatFields): string[] {
  return [
    '--entity', fields.entity,
    '--entity-type', 'app',
    '--project', fields.project,
    '--branch', fields.branch,
    '--plugin', fields.plugin,
    '--category', fields.category,
    '--write',
  ];
}

export async function resolveWakaTimeCli(
  resolver: ExecutableResolver = resolveExecutable,
  home: string = homedir(),
): Promise<string | null> {
  const standard = join(home, '.wakatime', 'wakatime-cli');
  try {
    await access(standard, fsConstants.X_OK);
    return standard;
  } catch {
    return resolver('wakatime-cli');
  }
}

export type HeartbeatResult = { ok: true } | { ok: false; reason: string };

export async function sendHeartbeat(
  runner: ProcessRunner,
  binary: string,
  args: readonly string[],
  signal: AbortSignal,
): Promise<HeartbeatResult> {
  try {
    const result = await runner(binary, args, { signal, timeoutMs: 5_000, killGraceMs: 250, maxCaptureChars: 4_000 });
    return result.ok ? { ok: true } : { ok: false, reason: describeFailure(result) };
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

export const defaultProcessRunner: ProcessRunner = runProcess;
