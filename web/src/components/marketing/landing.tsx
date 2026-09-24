'use client';

import { DemoBanner } from '@/components/app/demo-banner';
import { SiteHeader } from './site-header';
import { Hero } from './hero';
import { HowItWorks } from './how-it-works';
import { Features } from './features';
import { Different } from './different';
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
      <DemoBanner site />
      <SiteHeader />
      <main className="flex-1">
        <Hero />
        <HowItWorks />
        <Features />
        <Different />
        <Integrations />
        <BuilderShowcase />
        <Pricing />
        <Faq />
        <FinalCta />
      </main>
      <SiteFooter />
    </div>
  );
}
