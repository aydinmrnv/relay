'use client';

import Link from 'next/link';
import { ArrowRight, ArrowUpRight, LayoutTemplate } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { BorderBeam } from '@/components/21st/border-beam';
import { BrandMark } from '@/components/app/brand-mark';
import { useBrand } from '@/hooks/use-brand';
import { REPO_URL, Reveal, SECTIONS, useCalmMotion } from './primitives';

export function FinalCta() {
  const reduce = useCalmMotion();
  return (
    <section className="border-t py-20 sm:py-28">
      <div className="container">
        <Reveal>
          <div className="relative overflow-hidden rounded-3xl border bg-card px-6 py-14 text-center sm:px-12 sm:py-20">
            <div aria-hidden className="pointer-events-none absolute inset-0 bg-grid [mask-image:radial-gradient(ellipse_60%_70%_at_50%_100%,#000_30%,transparent_100%)]" />
            <div
              aria-hidden
              className="pointer-events-none absolute bottom-[-16rem] left-1/2 size-[36rem] -translate-x-1/2 rounded-full bg-[radial-gradient(circle,color-mix(in_oklch,var(--primary)_22%,transparent),transparent_65%)] blur-2xl"
            />
            <div className="relative mx-auto flex max-w-2xl flex-col items-center gap-4">
              <h2 className="text-3xl font-semibold tracking-tight text-balance sm:text-5xl">Build the flow you wish your team had</h2>
              <p className="text-base text-pretty text-muted-foreground sm:text-lg">
                Ticket in, reviewed pull request out, with your guardrails in between. It takes a minute to try and costs nothing.
              </p>
              <div className="mt-4 flex w-full flex-col items-stretch gap-3 sm:w-auto sm:flex-row sm:items-center">
                <Button size="lg" className="h-11 px-5 text-[15px]" nativeButton={false} render={<Link href="/dashboard" />}>
                  Open the studio
                  <ArrowRight data-icon="inline-end" />
                </Button>
                <Button size="lg" variant="outline" className="h-11 px-5 text-[15px]" nativeButton={false} render={<Link href="/templates" />}>
                  <LayoutTemplate data-icon="inline-start" />
                  Start from a template
                </Button>
              </div>
            </div>
            {reduce ? null : <BorderBeam size={160} duration={12} colorFrom="#8b5cf6" colorTo="#38bdf8" />}
          </div>
        </Reveal>
      </div>
    </section>
  );
}

export function SiteFooter() {
  const brand = useBrand();

  const columns = [
    {
      title: 'Studio',
      links: [
        { label: 'Dashboard', href: '/dashboard' },
        { label: 'Workflows', href: '/workflows' },
        { label: 'Templates', href: '/templates' },
        { label: 'Integrations', href: '/integrations' },
        { label: 'Runs', href: '/runs' },
        { label: 'Guide', href: '/guide' },
        { label: 'Settings', href: '/settings' },
      ],
    },
    {
      title: 'On this page',
      // Page order; the builder showcase has no header link of its own.
      links: [...SECTIONS.slice(0, 3), { id: 'builder', label: 'The builder' }, ...SECTIONS.slice(3)].map((section) => ({ label: section.label, href: `#${section.id}` })),
    },
    {
      title: 'Built with',
      links: [
        { label: `The ${brand.name} CLI`, href: REPO_URL },
        { label: 'shadcn/ui', href: 'https://ui.shadcn.com' },
        { label: 'Watermelon UI', href: 'https://ui.watermelon.sh' },
        { label: '21st.dev', href: 'https://21st.dev' },
        { label: 'Motion', href: 'https://motion.dev' },
        { label: 'React Flow', href: 'https://reactflow.dev' },
      ],
    },
  ];

  return (
    <footer className="border-t bg-muted/20">
      <div className="container grid grid-cols-1 gap-10 py-14 md:grid-cols-[minmax(0,1.4fr)_repeat(3,minmax(0,1fr))]">
        <div className="flex flex-col gap-3">
          <Link href="/" className="flex w-fit items-center gap-2">
            <BrandMark className="size-7" />
            <span className="font-semibold tracking-tight">{brand.name}</span>
          </Link>
          <p className="max-w-xs text-sm text-pretty text-muted-foreground">{brand.tagline}</p>
        </div>
        <div className="grid grid-cols-2 gap-8 sm:grid-cols-3 md:contents">
          {columns.map((column) => (
            <nav key={column.title} aria-label={column.title} className="flex flex-col gap-3">
              <p className="text-sm font-semibold">{column.title}</p>
              <ul className="flex flex-col gap-2">
                {column.links.map((link) => (
                  <li key={link.href}>
                    {link.href.startsWith('http') ? (
                      <a href={link.href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
                        {link.label}
                        <ArrowUpRight className="size-3" />
                      </a>
                    ) : link.href.startsWith('#') ? (
                      <a href={link.href} className="text-sm text-muted-foreground hover:text-foreground">
                        {link.label}
                      </a>
                    ) : (
                      <Link href={link.href} className="text-sm text-muted-foreground hover:text-foreground">
                        {link.label}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>
      </div>
      <div className="border-t">
        <p className="container py-5 text-xs text-muted-foreground">
          {brand.name} studio is a prototype. Nothing here is hosted or billed. The connector counts and the export preview are generated from the live catalog and compiler.
        </p>
      </div>
    </footer>
  );
}
