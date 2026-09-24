'use client';

import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CATALOG_STATS, getConnector } from '@/lib/connectors';
import { AppMark, Reveal, SectionHeading } from './primitives';

const FEATURED_APPS = ['github', 'linear', 'slack', 'sentry', 'discord', 'notion', 'jira', 'gitlab', 'bitbucket', 'zendesk', 'vercel', 'figma'];

export function Integrations() {
  const apps = FEATURED_APPS.flatMap((id) => {
    const app = getConnector(id);
    return app === undefined ? [] : [app];
  });

  return (
    <section id="integrations" className="scroll-mt-20 border-t py-16 sm:py-24">
      <div className="container max-w-6xl">
        <SectionHeading
          eyebrow="Integrations"
          title="Keep the tools your team already uses"
          description="Connect triggers and actions on the canvas. Bring tickets into a workflow and send results back to your team."
        />
        <Reveal className="mx-auto mt-10 grid max-w-4xl grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {apps.map((app) => (
            <Link
              key={app.id}
              href="/integrations"
              className="flex min-h-16 items-center gap-3 rounded-xl border bg-card px-4 py-3 transition-colors hover:border-primary/30 hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted/60">
                <AppMark connector={app} size={18} />
              </span>
              <span className="text-sm font-medium">{app.name}</span>
            </Link>
          ))}
        </Reveal>
        <div className="mx-auto mt-7 flex max-w-2xl flex-col items-center gap-5 text-center">
          <p className="text-sm leading-relaxed text-muted-foreground">
            {CATALOG_STATS.connectors} apps in the catalog. GitHub and Slack work through exported Actions; other connectors may need a
            bridge.
          </p>
          <Button variant="outline" nativeButton={false} render={<Link href="/integrations" />}>
            Explore the integrations <ArrowRight data-icon="inline-end" />
          </Button>
        </div>
      </div>
    </section>
  );
}
