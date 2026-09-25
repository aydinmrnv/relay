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
        {/* One ruled grid, not twelve cards: the logos are a list, and the list is one link. */}
        <Reveal className="mt-12 grid grid-cols-2 border-t border-l sm:grid-cols-3 lg:grid-cols-6">
          {apps.map((app) => (
            <Link
              key={app.id}
              href="/integrations"
              className="flex min-h-20 flex-col justify-between gap-4 border-r border-b p-4 transition-colors hover:bg-muted/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
            >
              <AppMark connector={app} size={18} />
              <span className="text-sm">{app.name}</span>
            </Link>
          ))}
        </Reveal>
        <div className="mt-8 flex flex-col items-start gap-5 sm:flex-row sm:items-center sm:justify-between">
          <p className="max-w-xl text-sm leading-relaxed text-muted-foreground">
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
