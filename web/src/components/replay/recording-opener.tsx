'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';
import { ArrowRight, CircleDollarSign, Clock3, FileUp, GitPullRequest, Video } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { BUILTIN_RECORDINGS } from '@/lib/replay/builtin';
import { formatUsd } from '@/lib/format';
import { LIMITS, parseRecordingText } from '@/lib/replay/parse';
import type { BuiltinRecording, Recording } from '@/lib/replay/types';
import { cn } from '@/lib/utils';
import { RichText } from '@/components/app/rich-text';
import { ReplayView } from './replay-view';

const OUTCOME: Record<BuiltinRecording['outcome'], { label: string; tone: string }> = {
  passed: { label: 'Passed', tone: 'border-success/40 text-success' },
  'checks-failed': { label: 'Checks failed', tone: 'border-destructive/40 text-destructive' },
  failed: { label: 'Failed', tone: 'border-destructive/40 text-destructive' },
};

/**
 * The recordings page: the runs that ship with the studio, and a way to play
 * one of your own. A file you open is read in this browser and goes nowhere:
 * it is not uploaded, saved or shared.
 */
export function RecordingOpener() {
  const [recording, setRecording] = useState<Recording | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const open = async (file: File | undefined) => {
    if (file === undefined) return;
    if (file.size > LIMITS.bytes) {
      setError('That file is too large to be a recording.');
      return;
    }
    const parsed = parseRecordingText(await file.text());
    if (parsed.ok) {
      setError(null);
      setRecording(parsed.recording);
    } else setError(parsed.error);
  };

  if (recording !== null) {
    return (
      <>
        <div className="border-b bg-muted/40">
          <div className="container flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-xs text-muted-foreground">
            <span>Opened from a file on this device. It stays in this tab: nothing was uploaded.</span>
            <button type="button" onClick={() => setRecording(null)} className="font-medium text-foreground underline underline-offset-4">
              Close it
            </button>
          </div>
        </div>
        <ReplayView recording={recording} />
      </>
    );
  }

  return (
    <div className="container flex flex-1 flex-col gap-10 py-10">
      <header className="flex max-w-3xl flex-col gap-3">
        <Badge variant="secondary" className="w-fit gap-1">
          <Video className="size-3" aria-hidden /> Recordings
        </Badge>
        <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">Watch a real run, start to finish</h1>
        <p className="text-pretty text-muted-foreground">
          These are runs Relay made on its own repository, exported and not edited: the plan, both debates between Claude Code and Codex, the diff, the tests, and the pull request each one opened. Drag the scrubber to any moment, and read the receipts: every claim an agent made, beside what
          was measured.
        </p>
      </header>

      <ul className="grid gap-4 md:grid-cols-3">
        {BUILTIN_RECORDINGS.map((meta) => (
          <li key={meta.slug} className="flex">
            <Link
              href={`/r/${meta.slug}`}
              className="group flex flex-1 flex-col gap-3 rounded-2xl border bg-card p-5 transition-colors outline-none hover:border-foreground/30 focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <div className="flex items-center gap-2">
                <span className={cn('rounded-full border px-2 py-0.5 text-[11px] font-medium', OUTCOME[meta.outcome].tone)}>{OUTCOME[meta.outcome].label}</span>
                <span className="font-mono text-[11px] text-muted-foreground">{meta.repository}</span>
              </div>
              <h2 className="font-medium text-pretty">{meta.title}</h2>
              <p className="text-sm text-pretty text-muted-foreground">{meta.blurb}</p>
              <p className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 pt-2 text-xs text-muted-foreground">
                {meta.pullRequest === null ? null : (
                  <span className="inline-flex items-center gap-1">
                    <GitPullRequest className="size-3.5" aria-hidden /> #{meta.pullRequest}
                  </span>
                )}
                <span className="inline-flex items-center gap-1">
                  <Clock3 className="size-3.5" aria-hidden /> {meta.minutes}m
                </span>
                {meta.costUsd === null ? null : (
                  <span className="inline-flex items-center gap-1">
                    <CircleDollarSign className="size-3.5" aria-hidden /> {formatUsd(meta.costUsd)}
                  </span>
                )}
                <span className="ml-auto inline-flex items-center gap-1 font-medium text-foreground">
                  Watch <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" aria-hidden />
                </span>
              </p>
            </Link>
          </li>
        ))}
      </ul>

      <section aria-labelledby="open-your-own" className="flex flex-col gap-3">
        <h2 id="open-your-own" className="text-lg font-semibold tracking-tight">
          Play one of your own
        </h2>
        <p className="max-w-3xl text-sm text-pretty text-muted-foreground">
          In a repository where Relay has run, <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">relay recording</span> writes the latest finished run to a file, with this machine’s paths and anything shaped like a credential taken out. Open it here to play it back. The file is read in
          this browser and is not uploaded.
        </p>
        <div
          onDragOver={(event) => {
            event.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(event) => {
            event.preventDefault();
            setOver(false);
            void open(event.dataTransfer.files[0]);
          }}
          className={cn('flex flex-col items-center gap-3 rounded-2xl border border-dashed p-8 text-center transition-colors', over ? 'border-foreground bg-muted/60' : 'bg-card/50')}
        >
          <FileUp className="size-5 text-muted-foreground" aria-hidden />
          <p className="text-sm text-muted-foreground">Drop a recording here, or</p>
          <Button variant="outline" onClick={() => input.current?.click()}>
            Choose a file
          </Button>
          <input
            ref={input}
            type="file"
            accept="application/json,.json"
            className="sr-only"
            aria-label="A recording file"
            onChange={(event) => {
              void open(event.target.files?.[0]);
              // The same file can be chosen again after an error.
              event.target.value = '';
            }}
          />
          {error === null ? null : (
            <p role="alert" className="max-w-md text-sm text-destructive">
              <RichText text={error} inline />
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
