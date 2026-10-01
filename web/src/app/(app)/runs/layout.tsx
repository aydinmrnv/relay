import type { Metadata } from 'next';

// The page itself is a client component, which cannot name itself: the title lives here.
export const metadata: Metadata = { title: 'Runs', robots: { index: false } };

export default function RunsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
