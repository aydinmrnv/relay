'use client';

import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { PILL, useStudioEntry } from './primitives';

/** The showcase's way into the builder: the one part of it that knows who is signed in. */
export function OpenBuilderButton() {
  const entry = useStudioEntry();
  return (
    <Button className={cn('mt-6', PILL)} variant="outline" nativeButton={false} render={<Link href={entry.into('/workflows')} />}>
      Open the builder
      <ArrowRight data-icon="inline-end" />
    </Button>
  );
}
