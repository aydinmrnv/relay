'use client';

import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { useBrand } from '@/hooks/use-brand';
import { useStudio } from '@/lib/store';
import { blankWorkflow, instantiateTemplate } from '@/lib/workflow/templates';

/** Creates a workflow — blank or from a template — and opens it in the builder. */
export function useCreateWorkflow() {
  const router = useRouter();
  const brand = useBrand();
  const upsertWorkflow = useStudio((state) => state.upsertWorkflow);
  const repository = useStudio((state) => state.settings.defaultRepository);

  const blank = () => {
    const workflow = blankWorkflow(brand, repository);
    upsertWorkflow(workflow);
    router.push(`/workflows/${workflow.id}`);
    return workflow;
  };

  const fromTemplate = (templateId: string) => {
    const workflow = instantiateTemplate(templateId, brand, repository);
    if (workflow === undefined) return undefined;
    upsertWorkflow(workflow);
    toast.success(`Created “${workflow.name}”`, { description: 'It is yours to change; the template stays as it was.' });
    router.push(`/workflows/${workflow.id}`);
    return workflow;
  };

  return { blank, fromTemplate };
}
