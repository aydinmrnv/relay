'use client';

import { useRouter } from 'next/navigation';
import { ArrowRight } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { ConnectorIcon } from '@/components/connectors/connector-icon';
import { useBrand } from '@/hooks/use-brand';
import { useStudio } from '@/lib/store';
import { getConnector } from '@/lib/connectors';
import { instantiateTemplate, TEMPLATES } from '@/lib/workflow/templates';

export default function TemplatesPage() {
  const router = useRouter();
  const brand = useBrand();
  const upsertWorkflow = useStudio((state) => state.upsertWorkflow);
  const repository = useStudio((state) => state.settings.defaultRepository);

  const use = (templateId: string) => {
    const workflow = instantiateTemplate(templateId, brand, repository);
    if (workflow === undefined) return;
    upsertWorkflow(workflow);
    toast.success(`Created "${workflow.name}"`);
    router.push(`/workflows/${workflow.id}`);
  };

  return (
    <div className="flex flex-1 flex-col gap-6 p-4 md:p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Templates</h1>
        <p className="text-sm text-muted-foreground">Starting points built from the live catalog. Every node in them is a real connector trigger or action.</p>
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {TEMPLATES.map((template) => (
          <Card key={template.id} className="flex flex-col">
            <CardHeader>
              <div className="mb-2 flex items-center gap-1.5">
                {template.connectors.map((id) => {
                  const connector = getConnector(id);
                  return connector === undefined ? null : <ConnectorIcon key={id} connector={connector} size={16} />;
                })}
              </div>
              <CardTitle>{template.name}</CardTitle>
              <CardDescription>{template.description}</CardDescription>
            </CardHeader>
            <CardContent className="mt-auto flex flex-wrap gap-1.5">
              {template.tags.map((tag) => (
                <Badge key={tag} variant="secondary">
                  {tag}
                </Badge>
              ))}
            </CardContent>
            <CardFooter>
              <Button className="w-full" onClick={() => use(template.id)}>
                Use this template <ArrowRight data-icon="inline-end" />
              </Button>
            </CardFooter>
          </Card>
        ))}
      </div>
    </div>
  );
}
