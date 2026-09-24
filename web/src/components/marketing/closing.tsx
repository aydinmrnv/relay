'use client';

import Link from 'next/link';
import { ArrowRight, ArrowUpRight, LayoutTemplate } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { BorderBeam } from '@/components/21st/border-beam';
import { BrandMark } from '@/components/app/brand-mark';
import { useBrand } from '@/hooks/use-brand';
import { useAccount, useCapabilities } from '@/lib/cloud/account';
import { REPO_URL, Reveal, useCalmMotion } from './primitives';

export function FinalCta() {
  const reduce = useCalmMotion();
  const signedIn = useAccount((state) => state.status === 'signed-in');
  const invite = useCapabilities().enabled && !signedIn;
  return (
    <section className="border-t py-16 sm:py-24">
      <div className="container max-w-6xl">
        <Reveal>
          <div className="relative overflow-hidden rounded-3xl border bg-card px-6 py-14 text-center sm:px-12 sm:py-16">
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 bg-grid [mask-image:radial-gradient(ellipse_60%_70%_at_50%_100%,#000_30%,transparent_100%)]"
            />
            <div
              aria-hidden
              className="pointer-events-none absolute bottom-[-16rem] left-1/2 size-[36rem] -translate-x-1/2 rounded-full bg-[radial-gradient(circle,color-mix(in_oklch,var(--primary)_22%,transparent),transparent_65%)] blur-2xl"
            />
            <div className="relative mx-auto flex max-w-2xl flex-col items-center gap-4">
              <h2 className="text-3xl font-semibold tracking-tight text-balance sm:text-5xl">Your next ticket could be a pull request</h2>
              <p className="text-base leading-relaxed text-pretty text-muted-foreground">
                Start with a template. Try a simulated run. Connect your machine when you’re ready.
              </p>
              <div className="mt-4 flex w-full flex-col items-stretch gap-3 sm:w-auto sm:flex-row sm:items-center">
                <Button size="lg" className="h-11 px-5 text-[15px]" nativeButton={false} render={<Link href={invite ? '/sign-up' : '/dashboard'} />}>
                  {invite ? 'Create a free account' : signedIn ? 'Open your studio' : 'Open the studio'}
                  <ArrowRight data-icon="inline-end" />
                </Button>
                <Button
                  size="lg"
                  variant="outline"
                  className="h-11 px-5 text-[15px]"
                  nativeButton={false}
                  render={<Link href="/templates" />}
                >
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
      title: 'Product',
      links: [
        { label: 'Open the studio', href: '/dashboard' },
        { label: 'Templates', href: '/templates' },
        { label: 'Integrations', href: '/integrations' },
        { label: 'Pricing', href: '/#pricing' },
      ],
    },
    {
      title: 'Resources',
      links: [
        { label: 'Documentation', href: '/guide' },
        { label: 'Connect your machine', href: '/connect' },
        { label: 'Source on GitHub', href: REPO_URL },
        { label: 'FAQ', href: '/#faq' },
      ],
    },
    {
      title: 'Account',
      links: [
        { label: 'Create an account', href: '/sign-up' },
        { label: 'Sign in', href: '/sign-in' },
        { label: 'Privacy', href: '/privacy' },
        { label: 'Terms', href: '/terms' },
      ],
    },
  ];

  return (
    <footer className="border-t bg-muted/20">
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
        <p className="container max-w-6xl py-5 text-xs text-muted-foreground">
          © {new Date().getFullYear()} {brand.name}. Open-source orchestration for coding agents.
        </p>
      </div>
    </footer>
  );
}
