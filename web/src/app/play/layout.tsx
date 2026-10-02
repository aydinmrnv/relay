import type { Metadata } from 'next';
import { PlaygroundFrame } from '@/components/playground/playground';
import { BRAND } from '@/lib/brand';

export const metadata: Metadata = {
  title: 'Playground',
  description: `Build a ${BRAND.name} workflow and test-run it in your browser. No account, nothing to install, and nothing is called or billed.`,
  alternates: { canonical: '/play' },
};

/**
 * The playground: the studio's builder for someone without an account, with
 * their work kept in their browser. It is deliberately outside
 * `STUDIO_ROUTES` and the proxy's matcher, so it opens for everyone and never
 * waits on sign-in; the studio's own screens still need an account.
 */
export default function PlaygroundLayout({ children }: LayoutProps<'/play'>) {
  return <PlaygroundFrame>{children}</PlaygroundFrame>;
}
