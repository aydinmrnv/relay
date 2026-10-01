import type { Metadata } from 'next';
import { BRAND } from '@/lib/brand';

// The page is a client component, which cannot name itself: the title lives here until the builder knows the
// workflow's name. Absolute, because the list's layout above has a title of its own and so passes no template down.
export const metadata: Metadata = { title: { absolute: `Workflow · ${BRAND.name}` }, robots: { index: false } };

export default function WorkflowsDetailLayout({ children }: { children: React.ReactNode }) {
  return children;
}
