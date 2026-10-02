'use client';

import { use } from 'react';
import { RunDetail } from '@/components/runs/run-detail';

export default function RunDetailPage({ params }: PageProps<'/runs/[id]'>) {
  const { id } = use(params);
  return <RunDetail id={id} />;
}
