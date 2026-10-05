'use client';

import { useMemo, useState } from 'react';
import { ChevronRight, FileDiff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { RecordingPatch } from '@/lib/replay/types';

interface PatchFile {
  path: string;
  additions: number;
  deletions: number;
  lines: string[];
}

/** The per-file parts of a patch, with their counts. Only the hunks are kept: the header lines say what the path already does. */
function filesOf(patch: string): PatchFile[] {
  const files: PatchFile[] = [];
  let current: PatchFile | null = null;
  for (const line of patch.split('\n')) {
    const start = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (start !== null) {
      current = { path: start[2]!.trim(), additions: 0, deletions: 0, lines: [] };
      files.push(current);
      continue;
    }
    if (current === null) continue;
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('index ') || line.startsWith('new file') || line.startsWith('deleted file') || line.startsWith('similarity ') || line.startsWith('rename ')) continue;
    if (line.startsWith('+')) current.additions += 1;
    else if (line.startsWith('-')) current.deletions += 1;
    current.lines.push(line);
  }
  return files;
}

const PATCH_NAMES: Record<string, string> = { implementation: 'First implementation' };

function patchName(label: string): string {
  const round = /^revision-round-(\d+)$/.exec(label)?.[1];
  return PATCH_NAMES[label] ?? (round === undefined ? label : `After review round ${round}`);
}

/** The most lines of one file drawn before it asks: a recording is for reading, and a lockfile is not reading. */
const FOLD_AT = 160;

/**
 * The diff the run captured from git at each stage: after the implementation,
 * and again after each round of code review. `omitted` is set when the
 * recording was exported without its patches.
 */
export function PatchView({ patches, omitted }: { patches: RecordingPatch[]; omitted: boolean }) {
  const [chosen, setChosen] = useState<string | null>(null);
  const patch = patches.find((entry) => entry.label === chosen) ?? patches.at(-1);
  const files = useMemo(() => (patch === undefined ? [] : filesOf(patch.patch)), [patch]);

  if (patch === undefined) {
    return (
      <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
        {omitted ? 'This recording was exported without its patches (relay recording --no-patches). The receipts still say which files changed.' : 'No code has been written yet at this point in the run.'}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {patches.map((entry) => (
          <Button key={entry.label} size="xs" variant={entry.label === patch.label ? 'default' : 'outline'} onClick={() => setChosen(entry.label)}>
            {patchName(entry.label)}
          </Button>
        ))}
        <span className="text-xs text-muted-foreground">
          {files.length} {files.length === 1 ? 'file' : 'files'} · <span className="text-success">+{files.reduce((sum, file) => sum + file.additions, 0)}</span>{' '}
          <span className="text-destructive">−{files.reduce((sum, file) => sum + file.deletions, 0)}</span> · computed from git, not from what the agent said it did
        </span>
      </div>
      {patch.truncated ? <p className="text-xs text-muted-foreground">This patch was cut where it grew past what a recording keeps.</p> : null}
      <ul className="flex flex-col gap-2">
        {files.map((file) => (
          // Keyed by the patch too, so choosing another stage closes what was open.
          <li key={`${patch.label}:${file.path}`}>
            <FileSection file={file} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function FileSection({ file }: { file: PatchFile }) {
  const [all, setAll] = useState(false);
  const lines = all ? file.lines : file.lines.slice(0, FOLD_AT);
  return (
    <details className="group overflow-hidden rounded-lg border bg-card">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-sm outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" aria-hidden />
        <FileDiff className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={file.path}>
          {file.path}
        </span>
        <span className="shrink-0 font-mono text-xs tabular-nums">
          <span className="text-success">+{file.additions}</span> <span className="text-destructive">−{file.deletions}</span>
        </span>
      </summary>
      <pre className="max-h-[32rem] overflow-auto border-t bg-muted/30 py-2 font-mono text-[11px] leading-relaxed">
        {lines.map((line, index) => (
          <span
            key={index}
            className={cn(
              'block min-w-max px-3 whitespace-pre',
              line.startsWith('+') ? 'bg-success/10 text-success' : line.startsWith('-') ? 'bg-destructive/10 text-destructive' : line.startsWith('@@') ? 'text-signal' : 'text-foreground/80',
            )}
          >
            {line.length === 0 ? ' ' : line}
          </span>
        ))}
      </pre>
      {!all && file.lines.length > FOLD_AT ? (
        <div className="border-t px-3 py-1.5">
          <Button size="xs" variant="ghost" onClick={() => setAll(true)}>
            Show the other {file.lines.length - FOLD_AT} lines
          </Button>
        </div>
      ) : null}
    </details>
  );
}
