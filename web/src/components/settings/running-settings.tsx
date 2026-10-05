'use client';

import { useState } from 'react';
import { Check, Copy, Workflow as WorkflowIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { HelpTip } from '@/components/app/help-tip';
import { ConnectorIcon } from '@/components/connectors/connector-icon';
import { AGENT_MARKS } from '@/lib/agents/marks';
import { useStudio } from '@/lib/store';
import { isRepository, type AuthPreference } from '@/lib/workflow/schema';
import { SettingBlock } from './settings-section';

type AgentKey = 'claude' | 'codex';

interface Credential {
  secret: string;
  what: string;
  commands: (repo: string) => string;
}

/** What each agent needs in GitHub Actions for each choice. Mirrors the secrets compileWorkflow asks for. */
const CREDENTIALS: Record<AgentKey, { name: string } & Record<AuthPreference, Credential>> = {
  claude: {
    name: 'Claude Code',
    subscription: {
      secret: 'CLAUDE_CODE_OAUTH_TOKEN',
      what: 'A one-year token from claude setup-token, tied to the Claude Pro, Max, Team or Enterprise plan of whoever creates it. Runs count against that plan’s usage.',
      commands: (repo) => `claude setup-token\ngh secret set CLAUDE_CODE_OAUTH_TOKEN -R ${repo}   # paste the token when asked`,
    },
    'api-key': {
      secret: 'ANTHROPIC_API_KEY',
      what: 'A key from the Anthropic Console. Runs are billed per token to that Console account.',
      commands: (repo) => `gh secret set ANTHROPIC_API_KEY -R ${repo}   # paste the key when asked`,
    },
  },
  codex: {
    name: 'Codex',
    subscription: {
      secret: 'CODEX_AUTH_JSON',
      what: 'The sign-in file Codex keeps at ~/.codex/auth.json after codex login with a ChatGPT plan. OpenAI documents this for CI but asks that it not be used on public repositories. The file rotates: if runs stop signing in, log in again and re-seed the secret.',
      commands: (repo) => `codex login\ngh secret set CODEX_AUTH_JSON -R ${repo} < ~/.codex/auth.json`,
    },
    'api-key': {
      secret: 'OPENAI_API_KEY',
      what: 'A key from the OpenAI Platform. Runs are billed per token to that account.',
      commands: (repo) => `gh secret set OPENAI_API_KEY -R ${repo}   # paste the key when asked`,
    },
  },
};

export function RunningSettings() {
  return (
    <Card className="gap-0 py-0">
      {/* A statement, not a setting: there is one place an export runs today, and a picker with one live option changed nothing. */}
      <SettingBlock
        title={
          <span className="inline-flex items-center gap-1.5">
            Where exported workflows run <HelpTip term="execution" />
          </span>
        }
        description={
          <>
            On your repository’s own GitHub Actions: free on public repositories, included minutes on private ones. A label on a GitHub issue starts an exported workflow there. On a machine of your own, relay workflow serve
            keeps any trigger it can read and runs the whole workflow. A run you press in the builder happens on the runner you picked in{' '}
            <a href="/runners" className="font-medium text-foreground underline underline-offset-4">
              Where agents run
            </a>
            , and a test run is played back in this browser.
          </>
        }
      >
        <p className="flex items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2 text-sm">
          <WorkflowIcon className="size-4 text-muted-foreground" aria-hidden /> Your GitHub Actions
        </p>
      </SettingBlock>
      <Separator />
      <RepositorySetting />
      <Separator />
      <Credentials />
    </Card>
  );
}

function RepositorySetting() {
  const saved = useStudio((state) => state.settings.defaultRepository);
  const updateSettings = useStudio((state) => state.updateSettings);
  const [value, setValue] = useState(saved);
  const trimmed = value.trim();
  const valid = isRepository(trimmed);

  const commit = () => {
    if (trimmed === saved) return;
    if (!valid) return;
    updateSettings({ defaultRepository: trimmed });
    toast.success(`New workflows will attach to ${trimmed}.`);
  };

  return (
    <SettingBlock
      htmlFor="default-repository"
      title="Default repository"
      description="New workflows and templates attach to this repository, and the commands below use it. Workflows you already have keep their own."
    >
      <form
        className="grid max-w-sm gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          commit();
        }}
      >
        <Input
          id="default-repository"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onBlur={commit}
          placeholder="owner/repo"
          spellCheck={false}
          autoComplete="off"
          aria-invalid={trimmed.length > 0 && !valid ? true : undefined}
          aria-describedby="default-repository-hint"
          className="font-mono"
        />
        <p id="default-repository-hint" className={trimmed.length > 0 && !valid ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>
          {trimmed.length > 0 && !valid ? 'Use the owner/repo form, for example acme/api. Not saved yet.' : 'Saved when you press Enter or leave the field.'}
        </p>
      </form>
    </SettingBlock>
  );
}

function Credentials() {
  const auth = useStudio((state) => state.settings.auth);
  const repository = useStudio((state) => state.settings.defaultRepository);
  const updateSettings = useStudio((state) => state.updateSettings);
  const repo = repository.trim() || 'owner/repo';

  return (
    <SettingBlock
      id="credentials"
      title={
        <span className="inline-flex items-center gap-1.5">
          Credentials in exported workflows <HelpTip term="secrets" />
        </span>
      }
      description="GitHub’s runners cannot click a sign-in page, so each agent needs a repository secret. Pick what the next export should ask for; SETUP.md in the export lists the same names."
    >
      <div className="grid grid-cols-1 gap-3">
        {(Object.keys(CREDENTIALS) as AgentKey[]).map((key) => {
          const agent = CREDENTIALS[key];
          const choice = auth[key];
          const credential = agent[choice];
          return (
            <div key={key} className="grid grid-cols-1 gap-3 rounded-lg border p-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <ConnectorIcon icon={AGENT_MARKS[key].icon} name={agent.name} size={14} />
                <p className="text-sm font-medium">{agent.name}</p>
                <ToggleGroup
                  aria-label={`How ${agent.name} signs in on GitHub Actions`}
                  value={[choice]}
                  onValueChange={(next) => {
                    // A toggle group lets you un-press the current item; one of the two must stay chosen.
                    const picked = next[0] as AuthPreference | undefined;
                    if (picked !== undefined && picked !== choice) updateSettings({ auth: { ...auth, [key]: picked } });
                  }}
                  variant="outline"
                  size="sm"
                  spacing={0}
                  className="ml-auto"
                >
                  <ToggleGroupItem value="subscription" className="aria-pressed:bg-primary/10 aria-pressed:text-foreground">
                    Subscription
                  </ToggleGroupItem>
                  <ToggleGroupItem value="api-key" className="aria-pressed:bg-primary/10 aria-pressed:text-foreground">
                    API key
                  </ToggleGroupItem>
                </ToggleGroup>
              </div>
              <div className="grid gap-1">
                <p className="text-xs text-muted-foreground">
                  Needs the secret <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px] text-foreground">{credential.secret}</code>
                </p>
                <p className="text-sm text-pretty text-muted-foreground">{credential.what}</p>
              </div>
              <CommandBlock label={`Set up ${credential.secret} for ${repo}, in your own terminal`} command={credential.commands(repo)} />
            </div>
          );
        })}
        <p className="text-xs text-pretty text-muted-foreground">
          The studio never sees these values: you run the commands yourself, or add the secrets under the repository’s Settings → Secrets and variables → Actions. Slack, Discord and bridged actions add their own
          webhook secrets, listed in SETUP.md.
        </p>
      </div>
    </SettingBlock>
  );
}

/** A copyable shell snippet. */
export function CommandBlock({ label, command }: { label: string; command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="overflow-hidden rounded-md border bg-muted/40">
      <div className="flex items-center justify-between gap-2 border-b px-2.5 py-1">
        <p className="truncate text-[11px] text-muted-foreground">{label}</p>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={copied ? 'Copied' : 'Copy the commands'}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(command);
              setCopied(true);
              setTimeout(() => setCopied(false), 1400);
            } catch {
              toast.error('The browser blocked the clipboard. Select the text and copy it instead.');
            }
          }}
        >
          {copied ? <Check className="text-success" /> : <Copy />}
        </Button>
      </div>
      <pre className="overflow-x-auto p-2.5 font-mono text-[11.5px] leading-relaxed">{command}</pre>
    </div>
  );
}
