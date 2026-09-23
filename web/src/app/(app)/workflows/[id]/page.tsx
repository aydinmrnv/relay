'use client';

import Link from 'next/link';
import { use } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Builder } from '@/components/builder/builder';
import { useStudio } from '@/lib/store';

export default function WorkflowBuilderPage({ params }: PageProps<'/workflows/[id]'>) {
  const { id } = use(params);
  const hydrated = useStudio((state) => state.hydrated);
  const exists = useStudio((state) => state.workflows[id] !== undefined);

  if (!hydrated) return null;
  if (!exists) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm text-muted-foreground">That workflow is not in this browser.</p>
        <Button variant="outline" nativeButton={false} render={<Link href="/workflows" />}>
          <ArrowLeft data-icon="inline-start" /> All workflows
        </Button>
      </div>
    );
  }
  return <Builder key={id} workflowId={id} />;
}
