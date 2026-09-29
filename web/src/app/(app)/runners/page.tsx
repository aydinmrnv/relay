import type { Metadata } from 'next';
import { RunnersView } from '@/components/companion/runners-view';

export const metadata: Metadata = { title: 'Where your agents run', robots: { index: false } };

/**
 * The local-or-cloud question on its own page: your computer through
 * `relay connect`, or Relay Cloud. Reachable from the sidebar, the guide,
 * Settings and the connect page, so nobody has to guess which runner a run
 * would use.
 */
export default function RunnersPage() {
  return <RunnersView />;
}
