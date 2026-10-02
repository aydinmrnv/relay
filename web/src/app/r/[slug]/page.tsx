import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { BuiltinReplay } from '@/components/replay/recording-loader';
import { BRAND } from '@/lib/brand';
import { BUILTIN_RECORDINGS, builtinRecording } from '@/lib/replay/builtin';

/** Only the recordings that ship with the studio have a page of their own; any other address is not found. */
export function generateStaticParams() {
  return BUILTIN_RECORDINGS.map((recording) => ({ slug: recording.slug }));
}

export const dynamicParams = false;

export async function generateMetadata({ params }: PageProps<'/r/[slug]'>): Promise<Metadata> {
  const { slug } = await params;
  const meta = builtinRecording(slug);
  if (meta === undefined) return { title: 'Recording not found', robots: { index: false } };
  const description = `A recording of a real ${BRAND.name} run on ${meta.repository}${meta.pullRequest === null ? '' : `, which opened pull request #${meta.pullRequest}`}. ${meta.blurb}`;
  return {
    title: `Recording: ${meta.title}`,
    description,
    alternates: { canonical: `/r/${slug}` },
    openGraph: { title: `${meta.title} · a ${BRAND.name} run, played back`, description, type: 'article', siteName: BRAND.name, url: `/r/${slug}` },
  };
}

export default async function RecordingPage({ params }: PageProps<'/r/[slug]'>) {
  const { slug } = await params;
  const meta = builtinRecording(slug);
  if (meta === undefined) notFound();
  return <BuiltinReplay meta={meta} />;
}
