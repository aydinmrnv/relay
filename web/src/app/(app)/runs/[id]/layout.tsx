import type { Metadata } from 'next';

// The page itself is a client component, which cannot name itself: the title lives here.
export const metadata: Metadata = { title: 'Run', robots: { index: false } };

export default function RunsDetailLayout({ children }: { children: React.ReactNode }) {
  return children;
}
