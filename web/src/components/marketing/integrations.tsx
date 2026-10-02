'use client';

import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { getConnector } from '@/lib/connectors';
import { AppMark, PILL, Reveal, SectionHeading, useStudioEntry } from './primitives';

/** What a real run can use today, with what each does. Nothing here is a plan. */
const WORKING = [
  { id: 'github-issues', does: 'A label on an issue starts a run, and the summary is posted back on it.' },
  { id: 'slack', does: 'Connect an incoming webhook; an exported workflow posts to your channel.' },
  { id: 'discord', does: 'Connect a channel webhook; an exported workflow posts to it.' },
  { id: 'http', does: 'Call any URL from an exported workflow, with headers kept as a secret.' },
];

/** In the builder and in test runs, with their sign-in still to be built. */
const PLANNED = ['linear', 'jira', 'sentry', 'gitlab', 'bitbucket', 'zendesk', 'vercel', 'notion', 'figma'];

export function Integrations() {
  const entry = useStudioEntry();
  const working = WORKING.flatMap((item) => {
    const app = getConnector(item.id);
    return app === undefined ? [] : [{ app, does: item.does }];
  });
  const planned = PLANNED.flatMap((id) => {
    const app = getConnector(id);
    return app === undefined ? [] : [app];
  });

  return (
    <section id="integrations" className="scroll-mt-20 border-t py-16 sm:py-24">
      <div className="container max-w-6xl">
        <SectionHeading
          eyebrow="Integrations"
          title="What connects today, and what is drawn for later"
          description="A real run uses GitHub, Slack, Discord and any URL. The rest of the catalog is in the builder to design and test against, and says so."
        />
        {/* One ruled grid, not four cards: the apps are a list. */}
        <Reveal className="mt-12 grid grid-cols-1 gap-px overflow-hidden rounded-xl border bg-border shadow-panel sm:grid-cols-2 lg:grid-cols-4">
          {working.map(({ app, does }) => (
            <div key={app.id} className="flex flex-col gap-3 bg-card p-5">
              <div className="flex items-center gap-2.5">
                <AppMark connector={app} size={20} />
                <span className="text-sm font-medium">{app.name}</span>
              </div>
              <p className="text-sm leading-relaxed text-pretty text-muted-foreground">{does}</p>
            </div>
          ))}
        </Reveal>
        <Reveal className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-3">
          <span className="rounded-full border px-2.5 py-0.5 text-xs text-muted-foreground">Design and test now · sign-in planned</span>
          <ul className="flex flex-wrap items-center gap-x-5 gap-y-2">
            {planned.map((app) => (
              <li key={app.id} className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <AppMark connector={app} size={14} className="text-muted-foreground" />
                {app.name}
              </li>
            ))}
          </ul>
        </Reveal>
        <div className="mt-8 flex flex-col items-start gap-5 sm:flex-row sm:items-center sm:justify-between">
          <p className="max-w-xl text-sm leading-relaxed text-muted-foreground">
            Trackers, CI, error trackers, security scanners, support and chat are all in the catalog, so a workflow can be drawn around the tools you have. In an export, a planned app’s step is sent to an endpoint of
            your own.
          </p>
          <Button variant="outline" className={PILL} nativeButton={false} render={<Link href={entry.into('/integrations')} />}>
            Explore the integrations <ArrowRight data-icon="inline-end" />
          </Button>
        </div>
      </div>
    </section>
  );
}
