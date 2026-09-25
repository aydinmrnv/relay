'use client';

import Link from 'next/link';
import { ArrowRight, ArrowUpRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useBrand } from '@/hooks/use-brand';
import { useAccount, useCapabilities } from '@/lib/cloud/account';
import { PipelinePreview } from './pipeline-preview';
import { REPO_URL } from './primitives';

const TRUST = ['Runs on your machine', 'Uses the AI subscriptions you already have', 'Free to start'];

export function Hero() {
  const brand = useBrand();
  const signedIn = useAccount((state) => state.status === 'signed-in');
  const accounts = useCapabilities().enabled;
  // Signed out, the first button makes an account and the second is the no-sign-up way in.
  const invite = accounts && !signedIn;
  return (
    <section>
      <div className="container max-w-6xl pt-16 pb-12 sm:pt-24 sm:pb-16">
        <p className="font-mono text-xs text-muted-foreground">The workflow layer for coding agents</p>
        <h1 className="mt-5 max-w-4xl text-[clamp(2.5rem,9vw,5.25rem)] leading-[1.02] font-semibold tracking-[-0.045em] text-balance">
          Ticket in.
          <br />
          <span className="text-muted-foreground">Reviewed PR out.</span>
        </h1>
        <p className="mt-6 max-w-xl text-base leading-relaxed text-pretty text-muted-foreground sm:text-lg">
          Claude Code and Codex, working together on your repository. {brand.name} connects the plan, the code, and the
          review. You decide what ships.
        </p>
        <div className="mt-8 flex w-full max-w-sm flex-col gap-3 sm:w-auto sm:max-w-none sm:flex-row">
          <Button size="lg" className="h-11 px-5" nativeButton={false} render={<Link href={invite ? '/sign-up' : '/dashboard'} />}>
            {invite ? 'Get started free' : signedIn ? 'Open your studio' : 'Open the studio'}
            <ArrowRight data-icon="inline-end" />
          </Button>
          <Button
            size="lg"
            variant="outline"
            className="h-11 px-5"
            nativeButton={false}
            render={<Link href={invite ? '/dashboard' : '/guide'} />}
          >
            {invite ? 'Try it without an account' : 'Read the docs'}
          </Button>
        </div>
        <ul className="mt-8 flex flex-wrap gap-x-5 gap-y-2 text-sm text-muted-foreground">
          {TRUST.map((text) => (
            <li key={text}>{text}</li>
          ))}
          <li>
            <a href={REPO_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-foreground underline-offset-4 hover:underline">
              Open source on GitHub
              <ArrowUpRight className="size-3.5" />
            </a>
          </li>
        </ul>
      </div>
      <div className="container max-w-6xl pb-16 sm:pb-24">
        <PipelinePreview />
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          A sample workflow, step by step. Connect your machine to run your own.
        </p>
      </div>
    </section>
  );
}
