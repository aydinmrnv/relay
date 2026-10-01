'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { AlertTriangle, CircleAlert, Download, FileArchive, FileCode2, FolderInput, KeyRound } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { HelpTip } from '@/components/app/help-tip';
import { CopyConfirmButton } from '@/components/watermelon/copy-confirm';
import { compileWorkflow } from '@/lib/workflow/compile';
import { validateWorkflow } from '@/lib/workflow/validate';
import { slugify } from '@/lib/brand';
import { isRepository, type Workflow } from '@/lib/workflow/schema';
import { createZip, saveBlob } from '@/lib/zip';
import { useBrand } from '@/hooks/use-brand';
import { useStudio } from '@/lib/store';
import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';
import { companionFetch, useCompanion, useCompanionCan } from '@/lib/companion/client';
import { repositoryLabel, type InstallResponse } from '@/lib/companion/types';

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
  const updateWorkflowMeta = useStudio((state) => state.updateWorkflowMeta);
  const compiled = useMemo(() => (workflow === null ? null : compileWorkflow(workflow, brand, { auth })), [workflow, brand, auth]);
  // What stands between this workflow and files worth committing: the
  // validator's errors, and what only the export can know (a repository, an
  // allowlist of real logins). While there is any, nothing is handed over.
  const errors = useMemo(
    () => (workflow === null || compiled === null ? [] : [...validateWorkflow(workflow).issues.filter((issue) => issue.level === 'error').map((issue) => issue.message), ...compiled.blockers]),
    [workflow, compiled],
  );
  const canInstall = useCompanionCan('install');
  const machine = useCompanion((state) => state.hello);
  const [installing, setInstalling] = useState(false);

  if (workflow === null || compiled === null) return null;

  const secrets = [...new Map(compiled.secrets.map((secret) => [secret.name, secret])).values()];
  const blocked = errors.length > 0;
  const needsRepository = !isRepository(workflow.repository);

  const downloadOne = (path: string, content: string) => {
    saveBlob(new Blob([content], { type: 'text/plain' }), path.split('/').pop() ?? path);
    markExported(workflow.id);
  };

  const machineRepo = repositoryLabel(machine?.repository);

  /** Writes the export into the repository `relay connect` runs in. SETUP.md stays here: its steps are on this screen. */
  const install = async () => {
    setInstalling(true);
    try {
      const files = compiled.files.filter((file) => file.path !== 'SETUP.md').map((file) => ({ path: file.path, content: file.content }));
      const result = await companionFetch<InstallResponse>('/v1/install', { method: 'POST', body: { files } });
      markExported(workflow.id);
      const changed = result.files.filter((file) => file.status !== 'unchanged');
      toast.success(changed.length === 0 ? `${machineRepo ?? 'The repository'} already had this export` : `Installed into ${machineRepo ?? 'your repository'}`, {
        description:
          changed.length === 0
            ? 'Every file was already up to date.'
            : `${changed.map((file) => `${file.status} ${file.path}`).join(', ')}. Review, commit and push them. The existing config was merged, not replaced.`,
      });
    } catch (error) {
      toast.error('Could not install the export', { description: error instanceof Error ? error.message : String(error) });
    } finally {
      setInstalling(false);
    }
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
              <CircleAlert className="size-3.5" /> Fix {errors.length === 1 ? 'this' : `these ${errors.length}`} first. The files below are a preview; they cannot be downloaded, copied or installed until then.
            </p>
            <ul className="mt-1 list-disc pl-6">
              {errors.map((message, index) => (
                <li key={index}>{message}</li>
              ))}
            </ul>
            {needsRepository ? (
              <label className="mt-2 flex flex-wrap items-center gap-2 text-foreground">
                <span className="font-medium">Repository</span>
                <Input
                  className="h-7 w-56 bg-background font-mono text-xs"
                  placeholder="owner/name"
                  autoComplete="off"
                  spellCheck={false}
                  defaultValue={workflow.repository ?? ''}
                  onChange={(event) => updateWorkflowMeta(workflow.id, { repository: event.target.value.trim() })}
                />
              </label>
            ) : null}
          </div>
        ) : null}

        <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto md:grid-cols-[260px_1fr] md:overflow-visible">
          <ol className="flex min-h-0 flex-col gap-3 overflow-y-auto pr-1 text-sm">
            <Step n={1} title={canInstall ? 'Put it in the repository' : 'Download'}>
              {canInstall ? (
                <>
                  <Button size="sm" className="mt-1.5 w-full" onClick={() => void install()} disabled={installing || blocked}>
                    {installing ? <Spinner data-icon="inline-start" /> : <FolderInput data-icon="inline-start" />} Install into {machineRepo ?? 'the repository'}
                  </Button>
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    Written by relay connect on {machine?.machine ?? 'your computer'}; an existing config is merged, not replaced.{' '}
                    <button type="button" className="underline underline-offset-2 disabled:cursor-not-allowed disabled:no-underline disabled:opacity-60" onClick={downloadZip} disabled={blocked}>
                      Download the .zip
                    </button>{' '}
                    instead.
                  </p>
                </>
              ) : (
                <>
                  <Button size="sm" className="mt-1.5 w-full" onClick={downloadZip} disabled={blocked}>
                    <FileArchive data-icon="inline-start" /> Download .zip
                  </Button>
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    Unzip at the root of {workflow.repository === undefined || workflow.repository === '' ? 'your repository' : <span className="font-mono">{workflow.repository}</span>}, or{' '}
                    <Link href="/connect" className="underline underline-offset-2">
                      connect your machine
                    </Link>{' '}
                    to install it there directly.
                  </p>
                </>
              )}
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
                {compiled.start.by === 'label' ? (
                  <>
                    Add the label <Mono>{compiled.start.label}</Mono> to an issue. Whoever adds it must be on the allowlist.
                  </>
                ) : compiled.start.by === 'event' ? (
                  <>
                    The Action fires when {compiled.start.event}. Relay works on that issue only if it also carries <Mono>{compiled.start.label}</Mono>, added by someone on the allowlist.
                  </>
                ) : (
                  <>
                    Nothing starts this one by itself: its trigger is not a GitHub issue event. Label an issue <Mono>{compiled.start.label}</Mono>, then run the workflow from the Actions tab with that issue’s number.
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
              {/* One row that scrolls sideways: the paths are long, and wrapped tabs spilled onto the line below. */}
              <TabsList variant="line" className="w-full justify-start gap-x-1 overflow-x-auto overflow-y-hidden">
                {compiled.files.map((file) => (
                  <TabsTrigger key={file.path} value={file.path} title={file.path} className="flex-none px-2 font-mono text-[11px]">
                    {file.path.split('/').pop()}
                  </TabsTrigger>
                ))}
              </TabsList>
              {compiled.files.map((file) => (
                <TabsContent key={file.path} value={file.path} className="flex min-h-0 flex-col gap-2">
                  <p className="text-xs text-pretty text-muted-foreground">
                    <span className="font-mono text-[11px] text-foreground">{file.path}</span> · {file.description}
                  </p>
                  <div className="relative min-h-0 rounded-lg border bg-muted/40">
                    <div className="absolute top-2 right-2 z-10 flex gap-1">
                      <CopyConfirmButton value={file.content} onCopied={() => markExported(workflow.id)} disabled={blocked} />
                      <Button size="icon-xs" variant="outline" className="bg-card" aria-label={`Download ${file.path}`} onClick={() => downloadOne(file.path, file.content)} disabled={blocked}>
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

function Mono({ children }: { children: React.ReactNode }) {
  return <span className="rounded bg-muted px-1 font-mono">{children}</span>;
}
