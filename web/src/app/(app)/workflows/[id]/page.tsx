'use client';

import Link from 'next/link';
import { use } from 'react';
import { ArrowLeft, SearchX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Builder } from '@/components/builder/builder';
import { useStudio } from '@/lib/store';

export default function WorkflowBuilderPage({ params }: PageProps<'/workflows/[id]'>) {
  const { id } = use(params);
  const hydrated = useStudio((state) => state.hydrated);
  const exists = useStudio((state) => state.workflows[id] !== undefined);

  if (!hydrated) return null;
  if (!exists) {
    return (
      <Empty className="m-4 flex-1 border md:m-6">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <SearchX />
          </EmptyMedia>
          <EmptyTitle>That workflow isn’t in this browser</EmptyTitle>
          <EmptyDescription>Workflows live in the browser that created them. It may have been deleted, or made somewhere else — import its JSON from the Workflows page to bring it here.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button variant="outline" nativeButton={false} render={<Link href="/workflows" />}>
            <ArrowLeft data-icon="inline-start" /> All workflows
          </Button>
        </EmptyContent>
      </Empty>
    );
  }
  return <Builder key={id} workflowId={id} />;
}
