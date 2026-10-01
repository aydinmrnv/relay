'use client';

import { ErrorScreen } from '@/components/app/error-screen';

/** Inside the studio: the sidebar and header stay, and only the page is replaced. */
export default function StudioError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <ErrorScreen error={error} retry={retry} studio />;
}
