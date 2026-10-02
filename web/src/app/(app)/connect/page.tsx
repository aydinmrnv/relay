import type { Metadata } from 'next';
import { ConnectView } from '@/components/companion/connect-view';

export const metadata: Metadata = { title: 'Connect your computer', robots: { index: false } };

/** Where `relay connect`'s pairing link lands, and how to get one. */
export default function ConnectPage() {
  return <ConnectView />;
}
