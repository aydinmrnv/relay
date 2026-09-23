'use client';

import { useMemo, useState } from 'react';
import { Check, Copy, Download, FileCode2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { compileWorkflow } from '@/lib/workflow/compile';
import type { Workflow } from '@/lib/workflow/schema';
import { useBrand } from '@/hooks/use-brand';
import { useStudio } from '@/lib/store';

interface Props {
  workflow: Workflow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ExportDialog({ workflow, open, onOpenChange }: Props) {
  const brand = useBrand();
  const auth = useStudio((state) => state.settings.auth);
  const compiled = useMemo(() => (workflow === null ? null : compileWorkflow(workflow, brand, { auth })), [workflow, brand, auth]);
  const [copied, setCopied] = useState<string | null>(null);

  const copy = async (path: string, content: string) => {
    await navigator.clipboard.writeText(content);
    setCopied(path);
    setTimeout(() => setCopied(null), 1500);
  };

  const download = (path: string, content: string) => {
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = path.split('/').pop() ?? path;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const downloadAll = () => {
    if (compiled === null) return;
    for (const file of compiled.files) download(file.path, file.content);
    toast.success(`Downloaded ${compiled.files.length} files`);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileCode2 className="size-4" /> Export “{workflow?.name}”
          </DialogTitle>
          <DialogDescription>
            Files a repository needs to run this on your own GitHub Actions minutes, with your own Claude and ChatGPT subscriptions. Nothing is hosted or billed by {brand.name}.
          </DialogDescription>
        </DialogHeader>
        {compiled === null ? null : (
          <>
            {compiled.warnings.length > 0 ? (
              <ul className="flex flex-col gap-1">
                {compiled.warnings.map((warning, index) => (
                  <li key={index} className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-800 dark:text-amber-200">
                    {warning}
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <span>Secrets to add:</span>
              {[...new Map(compiled.secrets.map((secret) => [secret.name, secret])).values()].map((secret) => (
                <Badge key={secret.name} variant="outline" className="font-mono text-[10px]" title={secret.why}>
                  {secret.name}
                </Badge>
              ))}
            </div>
            <Tabs defaultValue={compiled.files[0]?.path} className="min-h-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <TabsList variant="line" className="h-auto! flex-wrap gap-1">
                  {compiled.files.map((file) => (
                    <TabsTrigger key={file.path} value={file.path} className="font-mono text-xs">
                      {file.path}
                    </TabsTrigger>
                  ))}
                </TabsList>
                <Button size="sm" onClick={downloadAll}>
                  <Download data-icon="inline-start" /> Download all
                </Button>
              </div>
              {compiled.files.map((file) => (
                <TabsContent key={file.path} value={file.path} className="min-h-0 flex-1">
                  <p className="mb-2 text-xs text-muted-foreground">{file.description}</p>
                  <div className="relative rounded-lg border bg-muted/40">
                    <div className="absolute right-2 top-2 flex gap-1">
                      <Button size="icon-xs" variant="outline" aria-label="Copy" onClick={() => void copy(file.path, file.content)}>
                        {copied === file.path ? <Check /> : <Copy />}
                      </Button>
                      <Button size="icon-xs" variant="outline" aria-label="Download" onClick={() => download(file.path, file.content)}>
                        <Download />
                      </Button>
                    </div>
                    <ScrollArea className="h-[40vh]">
                      <pre className="p-3 pr-20 font-mono text-[11px] leading-relaxed">{file.content}</pre>
                    </ScrollArea>
                  </div>
                </TabsContent>
              ))}
            </Tabs>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
