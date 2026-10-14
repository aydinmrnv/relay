import type { Metadata } from 'next';
import { ProjectsView } from '@/components/projects/projects-view';

export const metadata: Metadata = { title: 'Projects', robots: { index: false } };

/** Every repository set up here: where each runs, what runs in it, and whether it is installed there. */
export default function ProjectsPage() {
  return <ProjectsView />;
}
