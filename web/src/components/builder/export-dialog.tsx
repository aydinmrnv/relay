'use client';

import { useMemo, useState } from 'react';
import { AlertTriangle, Check, CircleAlert, Copy, Download, FileArchive, FileCode2, KeyRound } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { HelpTip } from '@/components/app/help-tip';
import { compileWorkflow } from '@/lib/workflow/compile';
import { validateWorkflow } from '@/lib/workflow/validate';
import { slugify } from '@/lib/brand';
import type { Workflow } from '@/lib/workflow/schema';
import { createZip, saveBlob } from '@/lib/zip';
import { useBrand } from '@/hooks/use-brand';
import { useStudio } from '@/lib/store';
import { cn } from '@/lib/utils';

interface Props {
  workflow: Workflow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Where each secret comes from, as a command somebody can paste. */
const SECRET_SOURCE: Record<string, string> = {
  CLAUDE_CODE_OAUTH_TOKEN: 'claude setup-token',
  CODEX_AUTH_JSON: 'cat ~/.codex/auth.json',
  ANTHROPIC_API_KEY: 'console.anthropic.com → API keys',
  OPENAI_API_KEY: 'platform.openai.com → API keys',
};

export function ExportDialog({ workflow, open, onOpenChange }: Props) {
  const brand = useBrand();
  const auth = useStudio((state) => state.settings.auth);
  const markExported = useStudio((state) => state.markExported);
  const compiled = useMemo(() => (workflow === null ? null : compileWorkflow(workflow, brand, { auth })), [workflow, brand, auth]);
  const errors = useMemo(() => (workflow === null ? [] : validateWorkflow(workflow).issues.filter((issue) => issue.level === 'error')), [workflow]);
  const [copied, setCopied] = useState<string | null>(null);

  if (workflow === null || compiled === null) return null;

  const secrets = [...new Map(compiled.secrets.map((secret) => [secret.name, secret])).values()];
  const triggerLabel = readTriggerLabel(compiled.files[0]?.content);

  const copy = async (path: string, content: string) => {
    await navigator.clipboard.writeText(content);
    setCopied(path);
    markExported(workflow.id);
    setTimeout(() => setCopied(null), 1500);
  };

  const downloadOne = (path: string, content: string) => {
    saveBlob(new Blob([content], { type: 'text/plain' }), path.split('/').pop() ?? path);
    markExported(workflow.id);
  };

  const downloadZip = () => {
    saveBlob(createZip(compiled.files), `${slugify(workflow.name)}-${brand.slug}.zip`);
    markExported(workflow.id);
    toast.success('Downloaded the export', { description: 'Unzip it at the root of your repository: the files land at the right paths.' });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] flex-col gap-4 sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileCode2 className="size-4" /> Export “{workflow.name}”
            <HelpTip term="export" detailed />
          </DialogTitle>
          <DialogDescription>
            The files a repository needs to run this workflow on its own GitHub Actions minutes, with your own Claude and ChatGPT subscriptions. Nothing is hosted or billed by {brand.name}.
          </DialogDescription>
        </DialogHeader>

        {errors.length > 0 ? (
          <div className="rounded-lg border border-destructive/40 bg-destructive/8 p-3 text-xs text-destructive">
            <p className="flex items-center gap-1.5 font-medium">
              <CircleAlert className="size-3.5" /> Fix {errors.length === 1 ? 'this' : `these ${errors.length}`} first — the CLI would refuse this config:
            </p>
            <ul className="mt-1 list-disc pl-6">
              {errors.map((issue, index) => (
                <li key={index}>{issue.message}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto md:grid-cols-[260px_1fr] md:overflow-visible">
          <ol className="flex min-h-0 flex-col gap-3 overflow-y-auto pr-1 text-sm">
            <Step n={1} title="Download">
              <Button size="sm" className="mt-1.5 w-full" onClick={downloadZip}>
                <FileArchive data-icon="inline-start" /> Download .zip
              </Button>
              <p className="mt-1.5 text-xs text-muted-foreground">Unzip at the root of {workflow.repository === undefined || workflow.repository === '' ? 'your repository' : <span className="font-mono">{workflow.repository}</span>}.</p>
            </Step>
            <Step n={2} title="Add the secrets">
              <ul className="mt-1 grid gap-1.5">
                {secrets.map((secret) => (
                  <li key={secret.name} className="rounded-md border p-2 text-xs">
                    <p className="flex items-center gap-1.5 font-mono text-[11px] font-medium">
                      <KeyRound className="size-3 text-muted-foreground" /> {secret.name}
                    </p>
                    <p className="mt-0.5 text-muted-foreground">{secret.why}</p>
                    {SECRET_SOURCE[secret.name] === undefined ? null : <p className="mt-1 font-mono text-[10px] text-muted-foreground">from: {SECRET_SOURCE[secret.name]}</p>}
                  </li>
                ))}
              </ul>
              <p className="mt-1.5 text-xs text-muted-foreground">
                Repository → Settings → Secrets and variables → Actions, or <span className="font-mono">gh secret set NAME</span>.
              </p>
            </Step>
            <Step n={3} title="Commit and push">
              <p className="mt-0.5 text-xs text-muted-foreground">The workflow file is picked up by GitHub on the next push to the default branch.</p>
            </Step>
            <Step n={4} title="Start it">
              <p className="mt-0.5 text-xs text-muted-foreground">
                {triggerLabel === null ? (
                  'Trigger it the way its first node describes.'
                ) : (
                  <>
                    Add the label <span className="rounded bg-muted px-1 font-mono">{triggerLabel}</span> to an issue, or run the workflow by hand from the Actions tab.
                  </>
                )}
              </p>
            </Step>
          </ol>

          <div className="flex min-h-0 min-w-0 flex-col gap-2">
            {compiled.warnings.length > 0 ? (
              <ul className="flex flex-col gap-1">
                {compiled.warnings.map((warning, index) => (
                  <li key={index} className="flex items-start gap-1.5 rounded-md border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-xs">
                    <AlertTriangle className="mt-0.5 size-3 shrink-0" /> {warning}
                  </li>
                ))}
              </ul>
            ) : null}
            <Tabs defaultValue={compiled.files[0]?.path} className="min-h-0 flex-1">
              <TabsList variant="line" className="h-auto! w-full flex-wrap justify-start gap-x-1 gap-y-0">
                {compiled.files.map((file) => (
                  <TabsTrigger key={file.path} value={file.path} className="flex-none px-2 font-mono text-[11px]">
                    {file.path}
                  </TabsTrigger>
                ))}
              </TabsList>
              {compiled.files.map((file) => (
                <TabsContent key={file.path} value={file.path} className="flex min-h-0 flex-col gap-2">
                  <p className="text-xs text-muted-foreground">{file.description}</p>
                  <div className="relative min-h-0 rounded-lg border bg-muted/40">
                    <div className="absolute top-2 right-2 z-10 flex gap-1">
                      <Button size="xs" variant="outline" className="bg-card" onClick={() => void copy(file.path, file.content)}>
                        {copied === file.path ? <Check data-icon="inline-start" className="text-success" /> : <Copy data-icon="inline-start" />}
                        {copied === file.path ? 'Copied' : 'Copy'}
                      </Button>
                      <Button size="icon-xs" variant="outline" className="bg-card" aria-label={`Download ${file.path}`} onClick={() => downloadOne(file.path, file.content)}>
                        <Download />
                      </Button>
                    </div>
                    <ScrollArea className="h-[42vh]">
                      <pre className="p-3 pr-28 font-mono text-[11px] leading-relaxed">{file.content}</pre>
                    </ScrollArea>
                  </div>
                </TabsContent>
              ))}
            </Tabs>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-2.5">
      <span className={cn('flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground')}>{n}</span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{title}</p>
        {children}
      </div>
    </li>
  );
}

function readTriggerLabel(configJson: string | undefined): string | null {
  if (configJson === undefined) return null;
  try {
    const parsed = JSON.parse(configJson) as { workflow?: { triggerLabel?: unknown } };
    return typeof parsed.workflow?.triggerLabel === 'string' && parsed.workflow.triggerLabel.length > 0 ? parsed.workflow.triggerLabel : null;
  } catch {
    return null;
  }
}
