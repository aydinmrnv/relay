'use client';

import { DemoBanner } from '@/components/app/demo-banner';
import { SiteHeader } from './site-header';
import { Hero } from './hero';
import { HowItWorks } from './how-it-works';
import { Features } from './features';
import { Integrations } from './integrations';
import { BuilderShowcase } from './builder-showcase';
import { Pricing } from './pricing';
import { Faq } from './faq';
import { FinalCta, SiteFooter } from './closing';

/**
 * The public landing page. It explains what the product does and how, then
 * hands off to the studio. Every section reads the brand, the catalog and the
 * compiler live, so renaming the product or adding a connector updates it.
 */
export function Landing() {
  return (
    <div className="flex min-h-full flex-col">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-lg focus:bg-background focus:px-4 focus:py-3 focus:text-sm focus:shadow-lg"
      >
        Skip to content
      </a>
      <DemoBanner />
      <SiteHeader />
      <main id="main-content" className="flex-1">
        <Hero />
        <HowItWorks />
        <BuilderShowcase />
        <Features />
        <Integrations />
        <Pricing />
        <Faq />
        <FinalCta />
      </main>
      <SiteFooter />
    </div>
  );
}
