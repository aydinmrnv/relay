import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { atomicWriteJson, readJsonFile } from '../storage/atomic.ts';
import { relayDir } from '../storage/config.ts';

/**
 * Everything under `.relay/` that is machine-local rather than project state.
 * `config.json` is deliberately absent: it records deliberate choices and is
 * meant to be committed.
 */
export const RELAY_IGNORE_ENTRIES = ['.relay/runs/', '.relay/onboarding.json'] as const;

/**
 * What onboarding remembers between invocations. Only enough to make `relay
 * start` idempotent — never anything about the user, and never a credential.
 */
export interface OnboardingState {
  version: 1;
  /** When the "what a run does" tour was last shown, so it is shown once. */
  tourShownAt?: string;
  /** When the flow last reached the end, for the record. */
  completedAt?: string;
}

export function onboardingPath(repoRoot: string): string {
  return join(relayDir(repoRoot), 'onboarding.json');
}

export async function loadOnboarding(repoRoot: string): Promise<OnboardingState> {
  const raw = await readJsonFile<unknown>(onboardingPath(repoRoot));
  if (raw === null || typeof raw !== 'object') return { version: 1 };

  const record = raw as Record<string, unknown>;
  return {
    version: 1,
    ...(typeof record['tourShownAt'] === 'string' ? { tourShownAt: record['tourShownAt'] } : {}),
    ...(typeof record['completedAt'] === 'string' ? { completedAt: record['completedAt'] } : {}),
  };
}

export async function saveOnboarding(repoRoot: string, state: OnboardingState): Promise<void> {
  await atomicWriteJson(onboardingPath(repoRoot), state);
}

/**
 * Keeps machine-local Relay state out of git. Returns the entries it added, so
 * a caller can report only what actually changed; re-running adds nothing.
 */
export async function ensureRelayIgnored(repoRoot: string): Promise<string[]> {
  const path = join(repoRoot, '.gitignore');
  const current = await readFileOrEmpty(path);
  const present = new Set(current.split('\n').map((line) => line.trim()));

  const missing = RELAY_IGNORE_ENTRIES.filter((entry) => !present.has(entry));
  if (missing.length === 0) return [];

  const separator = current.length === 0 || current.endsWith('\n') ? '' : '\n';
  const block = `\n# Relay run state (machine-local)\n${missing.join('\n')}\n`;
  await writeFile(path, `${current}${separator}${block}`, 'utf8');
  return missing;
}

async function readFileOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
}
