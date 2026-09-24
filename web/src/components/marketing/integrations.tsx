'use client';

import Link from 'next/link';
import { motion } from 'motion/react';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { NumberTicker } from '@/components/21st/number-ticker';
import { CATALOG_STATS, CONNECTORS, type Connector } from '@/lib/connectors';
import { AppMark, Reveal, SectionHeading, useCalmMotion } from './primitives';

// Vendor apps only (the pipeline, gates and delivery are not integrations), popular ones first.
const APPS = CONNECTORS.filter((connector) => connector.category !== 'core').sort((a, b) => Number(b.popular === true) - Number(a.popular === true));
const ROW_ONE = APPS.slice(0, 22);
const ROW_TWO = APPS.slice(22, 44);

const STATS = [
  { value: CATALOG_STATS.connectors, label: 'apps' },
  { value: CATALOG_STATS.triggers, label: 'triggers' },
  { value: CATALOG_STATS.actions, label: 'actions' },
  { value: CATALOG_STATS.categories, label: 'categories' },
];

export function Integrations() {
  const reduce = useCalmMotion();
  return (
    <section id="integrations" className="scroll-mt-16 border-t py-20 sm:py-28">
      <div className="container">
        <SectionHeading
          eyebrow="Integrations"
          title="Wired to the tools your team already uses"
          description="Every app's triggers and actions are nodes in the palette, with typed ports and generated forms. A connection is a switch for now, so you can design against all of them today."
        />

        <Reveal className="mx-auto mt-12 grid max-w-3xl grid-cols-2 gap-px overflow-hidden rounded-2xl border bg-border sm:grid-cols-4">
          {STATS.map((stat) => (
            <div key={stat.label} className="flex flex-col items-center gap-1 bg-card px-4 py-6">
              {/* The ticker counts up with a spring; reduced motion shows the number at rest. */}
              {reduce ? (
                <span className="text-3xl font-semibold tracking-wider tabular-nums sm:text-4xl">{stat.value}</span>
              ) : (
                <NumberTicker value={stat.value} className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl dark:text-foreground" />
              )}
              <span className="text-sm text-muted-foreground">{stat.label}</span>
            </div>
          ))}
        </Reveal>
      </div>

      <div
        className="mt-12 flex flex-col gap-3 [mask-image:linear-gradient(to_right,transparent,#000_8%,#000_92%,transparent)]"
        role="list"
        aria-label="Some of the apps in the catalog"
      >
        <Marquee apps={ROW_ONE} />
        <Marquee apps={ROW_TWO} reverse />
      </div>

      <div className="container mt-10 flex justify-center">
        <Button variant="outline" nativeButton={false} render={<Link href="/integrations" />}>
          Browse all {CATALOG_STATS.connectors} integrations
          <ArrowRight data-icon="inline-end" />
        </Button>
      </div>
    </section>
  );
}

/**
 * One endless row. The list is rendered twice and slid by exactly half its
 * width, so the loop has no seam. With reduced motion it simply sits still.
 */
function Marquee({ apps, reverse = false }: { apps: Connector[]; reverse?: boolean }) {
  const reduce = useCalmMotion();
  const from = reverse ? '-50%' : '0%';
  const to = reverse ? '0%' : '-50%';
  return (
    <div className="overflow-hidden">
      <motion.div
        className="flex w-max gap-3"
        initial={{ x: from }}
        animate={reduce ? { x: from } : { x: [from, to] }}
        transition={reduce ? { duration: 0 } : { duration: 60, ease: 'linear', repeat: Infinity }}
      >
        {[0, 1].map((copy) =>
          apps.map((app) => (
            <div
              key={`${copy}-${app.id}`}
              role={copy === 0 ? 'listitem' : undefined}
              aria-hidden={copy === 1 ? true : undefined}
              className="flex shrink-0 items-center gap-2 rounded-full border bg-card py-1.5 pr-3.5 pl-2 text-sm shadow-xs"
            >
              <span className="inline-flex size-6 items-center justify-center rounded-full bg-muted/60">
                <AppMark connector={app} size={14} />
              </span>
              <span className="font-medium whitespace-nowrap">{app.name}</span>
            </div>
          )),
        )}
      </motion.div>
    </div>
  );
}
