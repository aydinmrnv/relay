import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { after } from 'next/server';
import { cache } from 'react';
import { SharedWorkflowView } from '@/components/share/shared-workflow-view';
import { DEFAULT_BRAND } from '@/lib/brand';
import { databaseConfigured } from '@/server/db';
import { countShare, getPublicShare } from '@/server/studio';

// One database read for the metadata and the page.
const load = cache(async (slug: string) => (databaseConfigured() ? getPublicShare(slug) : null));

export async function generateMetadata({ params }: PageProps<'/s/[slug]'>): Promise<Metadata> {
  const { slug } = await params;
  const share = await load(slug);
  if (share === null) return { title: 'Workflow not found' };
  const description = share.workflow.description.trim().length > 0 ? share.workflow.description : `A ${DEFAULT_BRAND.name} workflow by ${share.authorName}. Open it, test-run it, and remix it into your own studio.`;
  return {
    title: share.workflow.name,
    description,
    openGraph: { title: `${share.workflow.name} · a ${DEFAULT_BRAND.name} workflow`, description, type: 'article' },
  };
}

/** A workflow someone published: anyone can read it, test it in their own studio, and remix it. */
export default async function SharedWorkflowPage({ params }: PageProps<'/s/[slug]'>) {
  const { slug } = await params;
  const share = await load(slug);
  if (share === null) notFound();
  after(() => countShare(slug, 'views').catch((error: unknown) => console.error('[share] view count', error)));
  return <SharedWorkflowView share={share} />;
}
