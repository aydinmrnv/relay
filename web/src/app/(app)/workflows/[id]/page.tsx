'use client';

import Link from 'next/link';
import { use } from 'react';
import { ArrowLeft, SearchX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Builder } from '@/components/builder/builder';
import { useStudio } from '@/lib/store';
import { useAccount } from '@/lib/cloud/account';

export default function WorkflowBuilderPage({ params }: PageProps<'/workflows/[id]'>) {
  const { id } = use(params);
  const hydrated = useStudio((state) => state.hydrated);
  const exists = useStudio((state) => state.workflows[id] !== undefined);
  // Remount when the workspace is swapped (signing in or out), so the canvas never edits a copy that is gone.
  const owner = useStudio((state) => state.owner);
  const signedIn = useAccount((state) => state.status === 'signed-in');
  const epoch = useAccount((state) => state.epoch);

  if (!hydrated) return null;
  if (!exists) {
    return (
      <Empty className="m-4 flex-1 border md:m-6">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <SearchX />
          </EmptyMedia>
          <EmptyTitle>{signedIn ? 'That workflow isn’t in your account' : 'That workflow isn’t in this browser'}</EmptyTitle>
          <EmptyDescription>
            {signedIn
              ? 'It may have been deleted, or it belongs to someone else. If it was shared with you, open its share link and remix it.'
              : 'As a guest, workflows live in the browser that created them. Sign in if it is in your account, or import its JSON from the Workflows page.'}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button variant="outline" nativeButton={false} render={<Link href="/workflows" />}>
            <ArrowLeft data-icon="inline-start" /> All workflows
          </Button>
        </EmptyContent>
      </Empty>
    );
  }
  return <Builder key={`${id}:${owner ?? 'guest'}:${epoch}`} workflowId={id} />;
}
