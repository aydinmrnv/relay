'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { ArrowUpRight, Check, CircleAlert, Download, FolderInput, Loader2, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { CloudCard } from '@/components/companion/cloud-card';
import { ConnectSteps } from '@/components/companion/machine-card';
import { CommandBlock } from '@/components/settings/running-settings';
import { useBrand } from '@/hooks/use-brand';
import { AGENT_CREDENTIALS, agentOfSecret, type AgentKey } from '@/lib/agent-credentials';
import { slugify } from '@/lib/brand';
import { useCapabilities } from '@/lib/cloud/account';
import { companionFetch, useCompanion, useCompanionCan } from '@/lib/companion/client';
import { repositoryLabel, type InstallResponse } from '@/lib/companion/types';
import { repositoryHasFile, type FileCheck } from '@/lib/github-public';
import { sameRepository, workflowsOf } from '@/lib/projects';
import { shellPath, shellQuote } from '@/lib/shell';
import { useStudio } from '@/lib/store';
import { compileWorkflow } from '@/lib/workflow/compile';
import type { AuthPreference, Project, Workflow } from '@/lib/workflow/schema';
import { validateWorkflow } from '@/lib/workflow/validate';
import { createZip, saveBlob } from '@/lib/zip';
import { cn } from '@/lib/utils';

/**
 * What stands between a workflow and its first real run, for the runner its
 * project chose, as steps somebody can do in order: a short list of what there
 * is to do, with one step open at a time, so the page is the size of the task
 * and not of every command in it.
 *
 * On GitHub Actions that is four things nobody else can do for them: add the
 * agents' sign-ins as secrets, commit the files, let Actions open pull
 * requests, and label an issue. The sign-in comes first because the workflow
 * file is written for it. The files and secret names come from the compiler,
 * so this guide and the export dialog cannot disagree; every command is
 * quoted for a shell, since a workflow's name and label are anybody's text.
 */
export function InstallGuide({ workflow, project }: { workflow: Workflow; project: Project }) {
  if (project.runner === 'machine') return <MachineInstall workflow={workflow} project={project} />;
  if (project.runner === 'cloud') return <CloudInstall workflow={workflow} />;
  return <ActionsInstall workflow={workflow} project={project} />;
}

/** The agents a workflow's pipeline names. Both, when a step leaves the choice to the runner. */
function agentsUsed(workflow: Workflow): Set<AgentKey> {
  const used = new Set<AgentKey>();
  for (const node of workflow.nodes) {
    const config = node.data.config;
    const roles =
      node.data.typeId === 'pipeline.action.run'
        ? [config['planner'], config['planReviewer'], config['implementer'], config['codeReviewer']]
        : node.data.typeId === 'pipeline.action.fast'
          ? [config['implementer']]
          : node.data.typeId === 'logic.action.ai-step'
            ? ['claude', 'codex']
            : [];
    for (const role of roles) if (role === 'claude' || role === 'codex') used.add(role);
  }
  return used;
}

/** One line on what a secret is, beside the command that sets it. */
const SECRET_HINT: Record<string, string> = {
  CLAUDE_CODE_OAUTH_TOKEN: 'Uses your Claude plan. The first command prints a token; paste it when the second asks.',
  ANTHROPIC_API_KEY: 'Billed to your Anthropic Console account. Paste the key when asked.',
  CODEX_AUTH_JSON: 'Uses your ChatGPT plan, from the sign-in file Codex keeps.',
  OPENAI_API_KEY: 'Billed to your OpenAI Platform account. Paste the key when asked.',
};

const SIGN_IN: ReadonlyArray<{ id: AuthPreference; name: string }> = [
  { id: 'subscription', name: 'My subscription' },
  { id: 'api-key', name: 'API key' },
];

function ActionsInstall({ workflow, project }: { workflow: Workflow; project: Project }) {
  const brand = useBrand();
  const auth = useStudio((state) => state.settings.auth);
  const updateSettings = useStudio((state) => state.updateSettings);
  const markExported = useStudio((state) => state.markExported);
  const markInstalled = useStudio((state) => state.markInstalled);
  const toggleWorkflow = useStudio((state) => state.toggleWorkflow);
  const all = useStudio((state) => state.workflows);
  const canInstall = useCompanionCan('install');
  const machine = useCompanion((state) => state.hello);
  const [installing, setInstalling] = useState(false);
  const [checking, setChecking] = useState(false);
  const [found, setFound] = useState<Record<string, FileCheck> | null>(null);
  // How the agents signed in when the files were last handed over. The workflow file is written for one way or the other.
  const [handedOver, setHandedOver] = useState<string | null>(null);

  const compiled = useMemo(() => compileWorkflow(workflow, brand, { auth }), [workflow, brand, auth]);
  const errors = useMemo(() => [...validateWorkflow(workflow).issues.filter((issue) => issue.level === 'error').map((issue) => issue.message), ...compiled.blockers], [workflow, compiled]);
  const blocked = errors.length > 0;
  // What belongs in the repository. The export's SETUP.md and the importable copy of the graph are for people, not for the runner.
  const files = useMemo(() => compiled.files.filter((file) => file.path.startsWith('.relay/') || file.path.startsWith('.github/')), [compiled]);
  const action = files.find((file) => file.language === 'yaml');
  const repo = project.repository;
  const folder = repo.split('/')[1] ?? repo;
  const zipName = `${slugify(workflow.name)}-${brand.slug}.zip`;
  const branch = project.defaultBranch ?? 'main';
  const used = useMemo(() => agentsUsed(workflow), [workflow]);
  const opensPullRequests = action !== undefined && /pull-requests: write/.test(action.content);
  const machineRepo = repositoryLabel(machine?.repository);
  const writesHere = canInstall && sameRepository(machineRepo, repo);
  const installed = workflow.installedAt !== undefined;
  const others = useMemo(() => workflowsOf(project, Object.values(all)).filter((entry) => entry.id !== workflow.id), [project, all, workflow.id]);
  const signIn = `${auth.claude}/${auth.codex}`;
  const stale = handedOver !== null && handedOver !== signIn;
  const label = compiled.start.label;
  // The secrets somebody has to set: an agent that does no step of this workflow needs none.
  const secrets = compiled.secrets.filter((secret) => {
    const agent = agentOfSecret(secret.name);
    return agent === null || used.has(agent);
  });

  const download = () => {
    saveBlob(createZip(files.map((file) => ({ path: file.path, content: file.content }))), zipName);
    markExported(workflow.id);
    setHandedOver(signIn);
  };

  const install = async () => {
    setInstalling(true);
    try {
      // An older relay connect refuses a path it does not know, and with it the whole install.
      const takesWorkflows = (machine?.capabilities ?? []).includes('workflow');
      const sent = files.filter((file) => takesWorkflows || !file.path.startsWith('.relay/workflows/')).map((file) => ({ path: file.path, content: file.content }));
      const result = await companionFetch<InstallResponse>('/v1/install', { method: 'POST', body: { files: sent } });
      markExported(workflow.id);
      setHandedOver(signIn);
      const changed = result.files.filter((file) => file.status !== 'unchanged');
      toast.success(changed.length === 0 ? `${repo} already had these files` : `Written into ${repo}`, {
        description: changed.length === 0 ? 'Every file was already up to date.' : `${changed.map((file) => `${file.status} ${file.path}`).join(', ')}. Review, commit and push them.`,
      });
    } catch (error) {
      toast.error('Could not write the files', { description: error instanceof Error ? error.message : String(error) });
    } finally {
      setInstalling(false);
    }
  };

  const check = async () => {
    setChecking(true);
    const results = await Promise.all(files.map(async (file) => [file.path, await repositoryHasFile(repo, file.path, project.defaultBranch)] as const));
    setFound(Object.fromEntries(results));
    setChecking(false);
    if (results.length > 0 && results.every(([, state]) => state === 'present')) {
      markInstalled(workflow.id, true);
      markExported(workflow.id);
      toast.success(`“${workflow.name}” is in ${repo}`, { description: `All ${results.length} files are on ${branch}.` });
    }
  };

  const setAuth = (agent: AgentKey, choice: AuthPreference) => updateSettings({ auth: { ...auth, [agent]: choice } });
  const missing = found === null ? [] : Object.entries(found).filter(([, state]) => state !== 'present');

  return (
    <div className="flex flex-col gap-4">
      {blocked ? (
        <div className="rounded-xl border border-destructive/40 bg-destructive/8 p-4 text-sm text-destructive">
          <p className="flex items-center gap-1.5 font-medium">
            <CircleAlert className="size-4" /> Fix {errors.length === 1 ? 'this' : `these ${errors.length}`} in the builder first
          </p>
          <ul className="mt-1.5 list-disc pl-6 text-xs">
            {errors.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
          <Button size="sm" variant="outline" className="mt-3" nativeButton={false} render={<Link href={`/workflows/${workflow.id}`} />}>
            Open “{workflow.name}”
          </Button>
        </div>
      ) : null}

      {!workflow.enabled ? (
        <Notice
          action={
            <Button size="sm" onClick={() => toggleWorkflow(workflow.id, true)}>
              Switch it on
            </Button>
          }
        >
          This workflow is paused, so its files would start nothing. Switch it on before you get them.
        </Notice>
      ) : null}

      {others.length > 0 ? (
        <Notice>
          {repo} already has “{others[0]!.name}”{others.length > 1 ? ` and ${others.length - 1} more` : ''}. On GitHub Actions a repository starts one workflow by itself: installing this one replaces the other’s label, allowlist and
          budget.
        </Notice>
      ) : null}

      <div className="overflow-hidden rounded-xl border bg-card">
        {/* Closed to begin with: first a list of what there is to do, then each step when somebody gets to it. */}
        <Accordion>
          <Step value="secrets" n={1} title={secrets.length === 1 ? 'Add one secret' : `Add ${secrets.length} secrets`}>
            <p className="text-muted-foreground">How your agents sign in on GitHub’s runners. Set from your own terminal; {brand.name} never sees them.</p>
            {secrets.map((secret) => {
              const agent = agentOfSecret(secret.name);
              if (agent === null) return <Secret key={secret.name} name={secret.name} hint="Paste the value when asked." command={`gh secret set ${secret.name} -R ${repo}`} />;
              const choice = auth[agent];
              const credential = AGENT_CREDENTIALS[agent][choice];
              return (
                <Secret
                  key={secret.name}
                  name={AGENT_CREDENTIALS[agent].name}
                  hint={SECRET_HINT[credential.secret] ?? credential.what}
                  command={credential.commands(repo)}
                  warning={agent === 'codex' && choice === 'subscription' && project.private === false ? `${repo} is public, and OpenAI asks that a ChatGPT sign-in not be used on public repositories. Use an API key.` : undefined}
                  control={<Segments label={`How ${AGENT_CREDENTIALS[agent].name} signs in on GitHub Actions`} value={choice} onChange={(next) => setAuth(agent, next)} options={SIGN_IN} />}
                />
              );
            })}
            <p className="text-xs text-muted-foreground">
              No <span className="font-mono">gh</span>? Add them under <External href={`https://github.com/${repo}/settings/secrets/actions`}>Settings → Secrets → Actions</External>.
            </p>
          </Step>

          <Step value="files" n={2} title={`Commit ${files.length} files`} done={installed}>
            <p className="text-muted-foreground">
              Download them, unzip at the root of your checkout, and push to <span className="font-mono text-foreground">{branch}</span>.
            </p>
            {stale ? (
              <p className="flex gap-1.5 text-xs text-pretty text-amber-700 dark:text-warning">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                You changed how an agent signs in after getting these files. Get them again, and commit the new workflow file.
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {writesHere ? (
                <Button size="sm" onClick={() => void install()} disabled={blocked || installing}>
                  {installing ? <Loader2 className="animate-spin" data-icon="inline-start" /> : <FolderInput data-icon="inline-start" />} Write them into {machineRepo}
                </Button>
              ) : null}
              <Button size="sm" variant={writesHere ? 'outline' : 'default'} onClick={download} disabled={blocked}>
                <Download data-icon="inline-start" /> Download
              </Button>
            </div>
            <CommandBlock
              label="In your terminal"
              command={[
                `cd ${shellPath(folder)}`,
                ...(writesHere ? [] : [`unzip -o ~/Downloads/${zipName}`]),
                `git add .relay ${action?.path ?? '.github/workflows'}`,
                `git commit -m ${shellQuote(`Add ${brand.name}: ${workflow.name}`)}`,
                'git push',
              ].join('\n')}
            />
          </Step>

          {opensPullRequests ? (
            <Step value="pulls" n={3} title="Let Actions open pull requests">
              <p className="text-pretty text-muted-foreground">
                Off by default on new repositories. Under <External href={`https://github.com/${repo}/settings/actions`}>Settings → Actions → General</External>, tick “Allow GitHub Actions to create and approve pull requests”, or run:
              </p>
              <CommandBlock label="In your terminal" command={`gh api -X PUT repos/${repo}/actions/permissions/workflow -F can_approve_pull_request_reviews=true`} />
            </Step>
          ) : null}

          <Step value="start" n={opensPullRequests ? 4 : 3} title={compiled.start.by === 'dispatch' ? 'Start a run' : 'Label an issue'}>
            {compiled.start.by === 'label' ? (
              <>
                <p className="text-pretty text-muted-foreground">
                  Put the label <Code>{label}</Code> on <External href={`https://github.com/${repo}/issues`}>an issue</External> and the run starts. Watch it under the <External href={`https://github.com/${repo}/actions`}>Actions tab</External>.
                </p>
                <CommandBlock
                  label="Or in your terminal, with your issue’s number in place of ISSUE_NUMBER"
                  command={`gh label create ${shellQuote(label)} -R ${repo}\ngh issue edit ISSUE_NUMBER -R ${repo} --add-label ${shellQuote(label)}`}
                />
              </>
            ) : compiled.start.by === 'event' ? (
              <p className="text-pretty text-muted-foreground">
                It starts when {compiled.start.event}, on an issue that also carries the label <Code>{label}</Code>.
              </p>
            ) : (
              <>
                <p className="text-pretty text-muted-foreground">
                  GitHub Actions runs this one on one issue at a time. Label the issue <Code>{label}</Code>, then press Run workflow under the <External href={`https://github.com/${repo}/actions`}>Actions tab</External>, or:
                </p>
                <CommandBlock label="With your issue’s number in place of ISSUE_NUMBER" command={action === undefined ? '' : `gh workflow run ${action.path.split('/').pop()} -R ${repo} -f issue=ISSUE_NUMBER`} />
              </>
            )}
          </Step>
        </Accordion>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-1 text-sm">
        {installed ? (
          <>
            <p className="flex items-center gap-1.5 font-medium text-success">
              <Check className="size-4" aria-hidden /> Installed in {repo}
            </p>
            <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => markInstalled(workflow.id, false)}>
              Not yet, actually
            </Button>
          </>
        ) : (
          <>
            <p className="text-pretty text-muted-foreground">
              {missing.length === 0
                ? 'Pushed the files?'
                : missing.some(([, state]) => state === 'unknown')
                  ? 'GitHub did not answer. Try again in a few minutes.'
                  : `${missing.length} of ${files.length} files are not on ${branch} yet.`}
            </p>
            {project.private === false ? (
              <Button size="sm" variant="outline" onClick={() => void check()} disabled={checking || files.length === 0}>
                {checking ? <Loader2 className="animate-spin" data-icon="inline-start" /> : null} Check {repo}
              </Button>
            ) : (
              <Button size="sm" variant="outline" onClick={() => markInstalled(workflow.id, true)}>
                <Check data-icon="inline-start" /> Mark as installed
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function MachineInstall({ workflow, project }: { workflow: Workflow; project: Project }) {
  const connected = useCompanion((state) => state.status === 'connected' && state.pairing !== null);
  const machine = useCompanion((state) => state.hello);
  const machineRepo = repositoryLabel(machine?.repository);
  const elsewhere = connected && machineRepo !== null && !sameRepository(machineRepo, project.repository);
  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl border bg-card p-4">
        <ConnectSteps />
      </div>
      <p className={cn('flex items-start gap-1.5 px-1 text-sm text-pretty', connected && !elsewhere ? 'font-medium text-success' : elsewhere ? 'text-amber-700 dark:text-warning' : 'text-muted-foreground')}>
        {connected && !elsewhere ? <Check className="mt-0.5 size-4 shrink-0" aria-hidden /> : elsewhere ? <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden /> : <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />}
        {connected && !elsewhere
          ? `Connected to ${machine?.machine ?? 'your computer'}. Open “${workflow.name}” and press Run.`
          : elsewhere
            ? `relay connect is running in ${machineRepo}, not ${project.repository}. Start it again in the right folder.`
            : `Waiting for relay connect in your checkout of ${project.repository}.`}
      </p>
    </div>
  );
}

function CloudInstall({ workflow }: { workflow: Workflow }) {
  const offered = useCapabilities().cloudHub != null;
  return (
    <div className="flex flex-col gap-4">
      {offered ? (
        <CloudCard />
      ) : (
        <p className="text-sm text-pretty text-muted-foreground">
          Relay Cloud is not offered on this studio. Change where this project runs under{' '}
          <Link href="/projects" className="font-medium text-foreground underline underline-offset-4">
            Projects
          </Link>
          .
        </p>
      )}
      <p className="px-1 text-sm text-pretty text-muted-foreground">Then open “{workflow.name}” and press Run. The machine wakes, checks the repository out and opens the pull request as you.</p>
    </div>
  );
}

/** One thing to do: a numbered line that opens onto how to do it. */
function Step({ value, n, title, done = false, children }: { value: string; n: number; title: string; done?: boolean; children: React.ReactNode }) {
  return (
    <AccordionItem value={value}>
      <AccordionTrigger className="items-center gap-3 rounded-none px-4 py-3.5 hover:bg-muted/40 hover:no-underline">
        <span className={cn('flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold', done ? 'bg-success text-white' : 'bg-muted text-muted-foreground')} aria-hidden>
          {done ? <Check className="size-3.5" strokeWidth={3} /> : n}
        </span>
        <span className="flex-1">
          {title}
          {done ? <span className="sr-only"> (done)</span> : null}
        </span>
      </AccordionTrigger>
      <AccordionContent className="flex flex-col gap-3 pr-4 pb-4 pl-[3.25rem] [&_p:not(:last-child)]:mb-0">{children}</AccordionContent>
    </AccordionItem>
  );
}

/** A secret: what it is, how it is chosen where there is a choice, and the command that sets it. */
function Secret({ name, hint, command, control, warning }: { name: string; hint: string; command: string; control?: React.ReactNode; warning?: string }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <p className="font-medium">{name}</p>
        {control}
      </div>
      <p className="text-xs text-pretty text-muted-foreground">{hint}</p>
      {warning === undefined ? null : (
        <p className="flex gap-1.5 text-xs text-pretty text-amber-700 dark:text-warning">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {warning}
        </p>
      )}
      <CommandBlock label="In your terminal" command={command} />
    </div>
  );
}

/** A few named options side by side, exactly one of them pressed. */
function Segments<T extends string>({ label, value, onChange, options }: { label: string; value: T; onChange: (value: T) => void; options: ReadonlyArray<{ id: T; name: string }> }) {
  return (
    <ToggleGroup
      aria-label={label}
      value={[value]}
      onValueChange={(next) => {
        const picked = next[0] as T | undefined;
        if (picked !== undefined && picked !== value) onChange(picked);
      }}
      variant="outline"
      size="sm"
      spacing={0}
    >
      {options.map((option) => (
        <ToggleGroupItem key={option.id} value={option.id} className="aria-pressed:bg-primary/10 aria-pressed:text-foreground">
          {option.name}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

/** Something to know before going on, with at most one thing to do about it. */
function Notice({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm">
      <TriangleAlert className="size-4 shrink-0 text-amber-700 dark:text-warning" aria-hidden />
      <p className="min-w-0 flex-1 text-pretty">{children}</p>
      {action}
    </div>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return <code className="rounded bg-muted px-1 py-0.5 font-mono text-[12px] text-foreground">{children}</code>;
}

function External({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 font-medium text-foreground underline underline-offset-4">
      {children}
      <ArrowUpRight className="size-3" aria-hidden />
    </a>
  );
}
