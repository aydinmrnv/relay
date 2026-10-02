'use client';

import { ErrorScreen } from '@/components/app/error-screen';

export default function RootError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <main className="flex min-h-dvh flex-1 flex-col">
      <ErrorScreen error={error} retry={retry} />
    </main>
  );
}
