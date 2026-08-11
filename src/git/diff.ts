import { git } from './repository.ts';

export interface DiffFile {
  status: string;
  path: string;
  previousPath?: string;
  added: number;
  removed: number;
}

export interface DiffSnapshot {
  /** Commit the worktree branched from. */
  baseSha: string;
  patch: string;
  files: DiffFile[];
  additions: number;
  deletions: number;
  isEmpty: boolean;
  /** True when the patch was clipped for prompt/display purposes. */
  truncated: boolean;
}

/**
 * Snapshots everything an agent changed in the worktree, measured by git rather
 * than by asking the agent what it did.
 *
 * `git add -A` stages tracked edits, deletions and new files, so a single
 * `git diff --cached <baseSha>` covers the full change set whether the agent
 * committed or not. Staging is confined to the run's own worktree index.
 */
export async function snapshotDiff(
  worktreePath: string,
  baseSha: string,
  options: { maxPatchChars?: number; signal?: AbortSignal } = {},
): Promise<DiffSnapshot> {
  const signalOpt = options.signal ? { signal: options.signal } : {};

  await git(['add', '-A'], { cwd: worktreePath, ...signalOpt });

  const numstat = await git(['diff', '--cached', '--numstat', '-M', baseSha], {
    cwd: worktreePath,
    ...signalOpt,
  });
  const nameStatus = await git(['diff', '--cached', '--name-status', '-M', baseSha], {
    cwd: worktreePath,
    ...signalOpt,
  });
  const patch = await git(['diff', '--cached', '-M', '--no-color', baseSha], {
    cwd: worktreePath,
    ...signalOpt,
  });

  const statuses = parseNameStatus(nameStatus);
  const files = parseNumstat(numstat, statuses);

  const maxPatchChars = options.maxPatchChars ?? Number.POSITIVE_INFINITY;
  const truncated = patch.length > maxPatchChars;

  return {
    baseSha,
    patch: truncated ? `${patch.slice(0, maxPatchChars)}\n\n[relay: diff truncated at ${maxPatchChars} characters]` : patch,
    files,
    additions: files.reduce((sum, file) => sum + file.added, 0),
    deletions: files.reduce((sum, file) => sum + file.removed, 0),
    isEmpty: files.length === 0 && patch.trim().length === 0,
    truncated,
  };
}

function parseNameStatus(output: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of output.split('\n')) {
    if (line.trim().length === 0) continue;
    const parts = line.split('\t');
    const status = parts[0];
    // Renames and copies list both the old and new path; key on the new one.
    const path = parts.length >= 3 ? parts[2] : parts[1];
    if (status !== undefined && path !== undefined) map.set(path, status);
  }
  return map;
}

function parseNumstat(output: string, statuses: Map<string, string>): DiffFile[] {
  const files: DiffFile[] = [];
  for (const line of output.split('\n')) {
    if (line.trim().length === 0) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;

    const [addedRaw, removedRaw] = parts;
    const pathPart = parts.slice(2);
    // Renames appear as `old\tnew` in the trailing columns.
    const previousPath = pathPart.length > 1 ? pathPart[0] : undefined;
    const path = (pathPart.length > 1 ? pathPart[1] : pathPart[0]) ?? '';
    if (path.length === 0) continue;

    files.push({
      // `-` in numstat means a binary file, which has no line counts.
      added: addedRaw === '-' ? 0 : Number.parseInt(addedRaw ?? '0', 10) || 0,
      removed: removedRaw === '-' ? 0 : Number.parseInt(removedRaw ?? '0', 10) || 0,
      path,
      status: statuses.get(path) ?? 'M',
      ...(previousPath === undefined ? {} : { previousPath }),
    });
  }
  return files;
}

export function formatDiffStat(snapshot: DiffSnapshot): string {
  if (snapshot.isEmpty) return 'no changes';
  const fileWord = snapshot.files.length === 1 ? 'file' : 'files';
  return `${snapshot.files.length} ${fileWord} changed, +${snapshot.additions} −${snapshot.deletions}`;
}

/** Formats the per-file summary Relay shows in the terminal and the summary file. */
export function formatFileList(snapshot: DiffSnapshot, limit = 40): string[] {
  const lines = snapshot.files.slice(0, limit).map((file) => {
    const label = file.previousPath === undefined ? file.path : `${file.previousPath} → ${file.path}`;
    return `${file.status.padEnd(3)} ${label} (+${file.added} −${file.removed})`;
  });
  if (snapshot.files.length > limit) {
    lines.push(`… and ${snapshot.files.length - limit} more files`);
  }
  return lines;
}
