'use client';

import { use } from 'react';
import { RunDetail } from '@/components/runs/run-detail';

/** A test run made in the playground, in full: the studio's run page, with the playground around it. */
export default function PlaygroundRunPage({ params }: PageProps<'/play/runs/[id]'>) {
  const { id } = use(params);
  return <RunDetail id={id} />;
}
