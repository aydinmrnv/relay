'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { builtinRecordingUrl } from '@/lib/replay/builtin';
import { parseRecordingText } from '@/lib/replay/parse';
import type { BuiltinRecording, Recording } from '@/lib/replay/types';
import { ReplayView } from './replay-view';

type State = { status: 'loading' } | { status: 'ready'; recording: Recording } | { status: 'failed'; error: string };

/** One of the recordings that ship with the studio: fetched as the file it is, checked like any other, and played. */
export function BuiltinReplay({ meta }: { meta: BuiltinRecording }) {
  const [state, setState] = useState<State>({ status: 'loading' });
  useEffect(() => {
    let cancelled = false;
    fetch(builtinRecordingUrl(meta.slug))
      .then((response) => (response.ok ? response.text() : Promise.reject(new Error(`The server answered ${response.status}.`))))
      .then((text) => {
        if (cancelled) return;
        const parsed = parseRecordingText(text);
        setState(parsed.ok ? { status: 'ready', recording: parsed.recording } : { status: 'failed', error: parsed.error });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ status: 'failed', error: error instanceof Error ? error.message : 'The recording could not be fetched.' });
      });
    return () => {
      cancelled = true;
    };
  }, [meta.slug]);

  if (state.status === 'ready') return <ReplayView recording={state.recording} />;
  return (
    <div className="container flex flex-1 flex-col items-center justify-center gap-3 py-16 text-center" aria-busy={state.status === 'loading'}>
      {state.status === 'loading' ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden /> Loading the recording of “{meta.title}”…
        </p>
      ) : (
        <>
          <h1 className="text-lg font-semibold tracking-tight">This recording could not be played</h1>
          <p className="max-w-md text-sm text-pretty text-muted-foreground">{state.error}</p>
          <Button variant="outline" nativeButton={false} render={<Link href="/r" />}>
            <ArrowLeft data-icon="inline-start" /> All recordings
          </Button>
        </>
      )}
    </div>
  );
}
