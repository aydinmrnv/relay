import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { relayDir, type RelayConfig } from '../storage/config.ts';
import { unattendedOf } from './policy.ts';

/**
 * Three ways to stop a server, because the person who needs to stop one is not
 * always the person who started it, and is not always at its terminal.
 *
 * - **A file.** `touch .relay/STOP` works over SSH, from a deploy script, from
 *   a cron job, and from anybody with write access to the checkout.
 * - **A config flag.** `unattended.enabled: false` is the version that survives
 *   a restart, and the version that travels with the repository.
 * - **A signal.** SIGINT or SIGTERM, for the person actually looking at it.
 *
 * All three mean exactly the same thing: **start nothing more, and let what is
 * in flight finish.** None of them kills a run. A half-finished run killed
 * mid-turn leaves a worktree nobody asked for and an agent session nobody will
 * resume, and the runs already going are the ones somebody already paid for.
 * `relay stop <run>` is how you end one of those, deliberately, by name.
 */

export const STOP_FILE = 'STOP';

export function stopFilePath(repoRoot: string): string {
  return join(relayDir(repoRoot), STOP_FILE);
}

export interface KillSwitch {
  engaged: boolean;
  /** Which of the three, and whatever the file had to say. */
  reason?: string;
}

/**
 * Whether anything is telling the server to stop.
 *
 * Called before every poll and before every start, against config re-read from
 * disk — the flag is a kill switch only if flipping it reaches a server that is
 * already running, which means it cannot be a value captured at startup.
 */
export async function killSwitch(repoRoot: string, config: RelayConfig): Promise<KillSwitch> {
  if (!unattendedOf(config).enabled) {
    return { engaged: true, reason: 'unattended.enabled is false in .relay/config.json' };
  }
  const note = await readStopFile(repoRoot);
  if (note !== undefined) {
    const detail = note.trim();
    return {
      engaged: true,
      reason: `.relay/${STOP_FILE} is present${detail.length === 0 ? '' : `: ${detail.split('\n')[0]}`}`,
    };
  }
  return { engaged: false };
}

async function readStopFile(repoRoot: string): Promise<string | undefined> {
  try {
    return await readFile(stopFilePath(repoRoot), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    // An unreadable stop file is treated as present. The failure mode of
    // guessing wrong in the other direction is a server that keeps spending
    // money because it could not read the file that said not to.
    return `unreadable (${(error as Error).message})`;
  }
}
