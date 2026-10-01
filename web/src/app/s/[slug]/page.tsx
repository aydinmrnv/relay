import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import { SharedWorkflowView } from '@/components/share/shared-workflow-view';
import { BRAND } from '@/lib/brand';
import { describeForLog } from '@/server/api';
import { databaseConfigured } from '@/server/db';
import { getPublicShare } from '@/server/studio';

// One database read for the metadata and the page. A database that cannot be
// reached is an error for `error.tsx` to show, not a workflow that is not there.
const load = cache(async (slug: string) => {
  if (!databaseConfigured()) return null;
  try {
    return await getPublicShare(slug);
  } catch (error) {
    console.error('[share] could not load a shared workflow:', describeForLog(error));
    throw new Error('This shared workflow could not be loaded right now.');
  }
});

/** One line for a link preview: the author's own words, cut to what a card shows. */
function summary(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 200 ? `${flat.slice(0, 199).trimEnd()}…` : flat;
}

export async function generateMetadata({ params }: PageProps<'/s/[slug]'>): Promise<Metadata> {
  const { slug } = await params;
  const share = await load(slug);
  if (share === null) return { title: 'Workflow not found', robots: { index: false } };
  const description = share.workflow.description.trim().length > 0 ? summary(share.workflow.description) : `A ${BRAND.name} workflow by ${share.authorName}. Open it, test-run it, and remix it into your own studio.`;
  return {
    title: share.workflow.name,
    description,
    alternates: { canonical: `/s/${slug}` },
    // Anyone can publish one of these, and nobody reviews them first: they
    // unfurl when shared, and stay out of search results.
    robots: { index: false, follow: true },
    openGraph: { title: `${share.workflow.name} · a ${BRAND.name} workflow`, description, type: 'article', siteName: BRAND.name, url: `/s/${slug}` },
  };
}

/** A workflow someone published: anyone can read it, test it in their own studio, and remix it. */
export default async function SharedWorkflowPage({ params }: PageProps<'/s/[slug]'>) {
  const { slug } = await params;
  const share = await load(slug);
  if (share === null) notFound();
  return <SharedWorkflowView share={share} />;
}
