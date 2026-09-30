'use client';

import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { BrandMark } from '@/components/app/brand-mark';
import { Hero1Art, Hero1Cta } from '@/components/watermelon/hero-1';
import { useBrand } from '@/hooks/use-brand';
import { cn } from '@/lib/utils';
import { AppMark, PILL, REPO_URL, Reveal, useStudioEntry } from './primitives';

/** The page's last word: one framed band, lit by the hero's glow, with the same two ways in. */
export function FinalCta() {
  const entry = useStudioEntry();
  return (
    <section className="pb-20 sm:pb-28">
      <div className="container max-w-6xl">
        <Reveal>
          <div className="relative isolate overflow-hidden rounded-2xl border bg-background px-6 py-14 shadow-panel sm:px-12 sm:py-20">
            {/* Anchored below the band, as in the hero, so only the glow's softer upper half shows. */}
            <Hero1Art
              side="right"
              className="absolute top-0 right-0 -bottom-28 -z-10 w-full mask-[linear-gradient(to_left,black_35%,transparent)] md:w-3/4"
            />
            <div className="flex max-w-2xl flex-col gap-4">
              <h2 className="text-4xl leading-[1.04] font-semibold tracking-[-0.035em] text-balance sm:text-[3.5rem]">
                Your next ticket could be a pull request.
              </h2>
              <p className="max-w-lg text-base leading-relaxed text-pretty text-muted-foreground sm:text-lg">
                Start with a template. Try a simulated run. Pick a runner when you’re ready.
              </p>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <Hero1Cta href={entry.href}>{entry.label}</Hero1Cta>
                <Button
                  variant="outline"
                  className={cn(PILL, 'h-11 bg-background/70 px-5 backdrop-blur-sm')}
                  nativeButton={false}
                  render={<Link href={entry.into('/templates')} />}
                >
                  Start from a template
                </Button>
              </div>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

export function SiteFooter() {
  const brand = useBrand();
  const entry = useStudioEntry();

  const columns = [
    {
      title: 'Product',
      links: [
        { label: entry.label, href: entry.href },
        { label: 'Templates', href: entry.into('/templates') },
        { label: 'Integrations', href: entry.into('/integrations') },
        { label: 'Pricing', href: '/#pricing' },
      ],
    },
    {
      title: 'Resources',
      links: [
        { label: 'Documentation', href: '/guide' },
        { label: 'Your computer or Relay Cloud', href: '/runners' },
        { label: 'Source on GitHub', href: REPO_URL },
        { label: 'FAQ', href: '/#faq' },
      ],
    },
    {
      title: 'Account',
      links: [
        { label: 'Create an account', href: '/sign-up' },
        { label: 'Sign in', href: '/sign-in' },
      ],
    },
  ];

  return (
    <footer className="border-t">
      <div className="container max-w-6xl grid grid-cols-1 gap-10 py-14 md:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))]">
        <div className="flex flex-col gap-3">
          <Link href="/" className="flex w-fit items-center gap-2">
            <BrandMark className="size-7" />
            <span className="font-semibold tracking-tight">{brand.name}</span>
          </Link>
          <p className="max-w-xs text-sm leading-relaxed text-pretty text-muted-foreground">{brand.tagline}</p>
        </div>
        <div className="grid grid-cols-2 gap-8 sm:grid-cols-3 md:contents">
          {columns.map((column) => (
            <nav key={column.title} aria-label={column.title} className="flex flex-col gap-3">
              <p className="text-sm font-semibold">{column.title}</p>
              <ul className="flex flex-col gap-2">
                {column.links.map((link) => (
                  <li key={link.href}>
                    {link.href.startsWith('http') ? (
                      <a
                        href={link.href}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
                      >
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
        <div className="container flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-3 py-5 text-xs text-muted-foreground">
          <p className="mr-auto">
            © {new Date().getFullYear()} {brand.name}. Open-source orchestration for coding agents.
          </p>
          <nav aria-label="Legal" className="flex items-center gap-5">
            <Link href="/privacy" className="hover:text-foreground">
              Privacy
            </Link>
            <Link href="/terms" className="hover:text-foreground">
              Terms
            </Link>
            <a
              href={REPO_URL}
              target="_blank"
              rel="noreferrer"
              aria-label={`${brand.name} on GitHub`}
              className="inline-flex size-7 items-center justify-center rounded-full border hover:border-foreground/30"
            >
              <AppMark connector="github" size={13} />
            </a>
          </nav>
        </div>
      </div>
    </footer>
  );
}
