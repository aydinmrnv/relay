import type { Metadata } from 'next';

// The page itself is a client component, which cannot name itself: the title lives here.
export const metadata: Metadata = { title: 'Workflow', robots: { index: false } };

export default function WorkflowsDetailLayout({ children }: { children: React.ReactNode }) {
  return children;
}
