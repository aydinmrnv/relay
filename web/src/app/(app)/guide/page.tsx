import type { Metadata } from 'next';
import { GuideView } from '@/components/guide/guide-view';

export const metadata: Metadata = { title: 'Guide' };

/**
 * "What does everything do": the getting-started path, the anatomy of a
 * workflow, the pipeline's phases and every glossary entry, each with an
 * anchor the help popovers link to (/guide#<term>). Server-rendered, so a
 * link straight to an anchor lands on it before any script runs.
 */
export default function GuidePage() {
  return <GuideView />;
}
