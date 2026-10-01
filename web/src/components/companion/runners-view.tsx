'use client';

import Link from 'next/link';
import { Settings } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FadeIn } from '@/components/motion/fade-in';
import { PageHeader } from '@/components/app/page-header';
import { CloudCard } from '@/components/companion/cloud-card';
import { MachineCard } from '@/components/companion/machine-card';
import { RunnerCards, RunnerComparison } from '@/components/companion/runner-compare';
import { useCompanion } from '@/lib/companion/client';
import { useBrand } from '@/hooks/use-brand';

/**
 * "/runners": the whole local-or-cloud question on one page. Every other
 * screen links here rather than restating the choice, so the answer cannot
 * drift — the settings picker, the guide and the sidebar all point at this.
 */
export function RunnersView() {
  const brand = useBrand();
  const target = useCompanion((state) => state.target);
  const hub = useCompanion((state) => state.cloudHub);

  return (
    <div className="flex flex-1 flex-col gap-6 p-4 pb-16 md:p-6 md:pb-24">
      <div className="mx-auto grid w-full max-w-4xl grid-cols-1 gap-8">
        <PageHeader
          title="Where your agents run"
          term="runner"
          description={
            hub === null
              ? `A real run happens wherever your coding agents are signed in: on your own computer, through relay connect. ${brand.name} Cloud, a machine Relay makes for you, is an invite-only beta that this studio does not offer; it is described below so you know what it is.`
              : `A real run happens wherever your coding agents are signed in. ${brand.name} has two places for that: your own computer, and Relay Cloud, a machine Relay makes for you, in invite-only beta. Same plans, same pull request either way — what changes is which machine has to be awake, and where your code and sign-ins sit.`
          }
          actions={
            <Button variant="outline" nativeButton={false} render={<Link href="/settings#machine" />}>
              <Settings data-icon="inline-start" /> Settings
            </Button>
          }
        />

        <FadeIn className="grid gap-6">
          <RunnerCards />
          <div className="grid gap-4">
            <p className="text-sm font-medium">{target === 'cloud' ? 'Relay Cloud, in detail' : 'Your computer, in detail'}</p>
            {target === 'cloud' ? (
              hub === null ? (
                <p className="text-sm text-pretty text-muted-foreground">
                  Relay Cloud is selected, and this studio does not offer it. Pairing your computer with relay connect puts you back on it, and nothing else about your work changes.
                </p>
              ) : (
                <CloudCard />
              )
            ) : (
              <MachineCard />
            )}
          </div>
          <RunnerComparison />
        </FadeIn>
      </div>
    </div>
  );
}
