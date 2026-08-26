/**
 * The two filesystem operations whose semantics genuinely differ on Windows,
 * kept here so the difference is documented once rather than rediscovered at
 * each call site.
 *
 * Both differences come from the same place: Windows enforces sharing at the
 * handle rather than at the directory entry. A POSIX rename or unlink acts on
 * the name and does not care who has the file open; on Windows an open handle
 * held by anyone — another Relay process, an agent CLI that has not fully
 * exited, a virus scanner reading a file it just saw appear — makes the same
 * call fail outright. Neither failure is permanent, and neither is worth
 * surfacing to a user, so both are retried briefly.
 */
import { rm, rename } from 'node:fs/promises';

/**
 * Errors Windows raises for "someone else has this open, try again", as
 * distinct from the same codes on POSIX, where they mean a real permission
 * problem that no amount of waiting fixes.
 */
const SHARING_VIOLATION_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

const REPLACE_ATTEMPTS = 20;
const REPLACE_DELAY_MS = 25;

/**
 * Whether a failed replace is the Windows sharing violation above, and so worth
 * retrying. Exported for the test that pins the platform distinction: retrying
 * `EACCES` on POSIX would delay a genuine "this directory is not writable" by
 * half a second and then report it anyway.
 */
export function isTransientReplaceError(
  error: unknown,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== 'win32') return false;
  return SHARING_VIOLATION_CODES.has((error as NodeJS.ErrnoException | null)?.code ?? '');
}

/**
 * Renames over a destination that may already exist and may be being read.
 *
 * This is the last step of every atomic write, and on Windows it is the step
 * that fails: `MoveFileEx` cannot replace a file another process holds open,
 * and Relay's run state is read constantly while it is written — `relay watch`
 * polls it, `relay status` reads it, admission scans every run's copy. The
 * rename is still atomic when it lands. It just has to wait for the reader,
 * which never takes more than the moment a read takes.
 */
export async function replaceFile(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      if (attempt >= REPLACE_ATTEMPTS || !isTransientReplaceError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, REPLACE_DELAY_MS));
    }
  }
}

/**
 * `fs.rm` options for a directory something else may still be holding open.
 *
 * Node retries `EBUSY`, `EPERM`, `ENOTEMPTY` and friends on Windows and only
 * there — but only when asked, and the default is not to ask at all. Every
 * directory Relay removes is one an agent process was working in moments
 * before, which is exactly when a handle is still closing.
 */
const REMOVE_RETRY = { recursive: true, force: true, maxRetries: 20, retryDelay: 50 } as const;

/** `rm -rf` that survives a handle that has not closed yet. See `REMOVE_RETRY`. */
export async function removeDirectory(path: string): Promise<void> {
  await rm(path, REMOVE_RETRY);
}
