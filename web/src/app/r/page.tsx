import type { Metadata } from 'next';
import { RecordingOpener } from '@/components/replay/recording-opener';
import { BRAND } from '@/lib/brand';

export const metadata: Metadata = {
  title: 'Recordings',
  description: `Real ${BRAND.name} runs, played back: the plan, the debates between Claude Code and Codex, the diff, the tests, and every claim beside what was measured.`,
  alternates: { canonical: '/r' },
};

export default function RecordingsPage() {
  return <RecordingOpener />;
}
