/**
 * Graph → files a repository can actually use today.
 *
 * The prototype does not host anything, so "deploy" means: write the config the
 * Relay CLI already reads, plus a GitHub Actions workflow that runs it on the
 * customer's own minutes. Everything the canvas cannot express in those two
 * files is written down as a warning rather than silently dropped.
 */
import type { Brand } from '../brand';
import { getConnector, getNodeType, type NodeTypeDef } from '../connectors';
import { slugify } from '../brand';
import type { AuthPreference, Workflow, WorkflowNode } from './schema';
import { isUnattendedTrigger } from './validate';

export interface CompileOptions {
  /** Which credential each agent carries into GitHub Actions. Defaults to the vendors' subscription methods. */
  auth?: { claude: AuthPreference; codex: AuthPreference };
}

export interface CompiledFile {
  path: string;
  language: 'json' | 'yaml' | 'markdown';
  content: string;
  description: string;
}

export interface CompiledOutput {
  files: CompiledFile[];
  warnings: string[];
  secrets: Array<{ name: string; why: string }>;
}

interface Found {
  node: WorkflowNode;
  def: NodeTypeDef;
}

export function compileWorkflow(workflow: Workflow, brand: Brand, options: CompileOptions = {}): CompiledOutput {
  const warnings: string[] = [];
  const auth = options.auth ?? { claude: 'subscription', codex: 'subscription' };
  const found = workflow.nodes
    .map((node) => ({ node, def: getNodeType(node.data.typeId) }))
    .filter((entry): entry is Found => entry.def !== undefined);

  const first = (id: string) => found.find((entry) => entry.def.id === id);
  const all = (predicate: (entry: Found) => boolean) => found.filter(predicate);

  const trigger = found.find((entry) => entry.def.kind === 'trigger');
  const pipeline = first('pipeline.action.run') ?? first('pipeline.action.fast');
  const fast = pipeline?.def.id === 'pipeline.action.fast';
  const delivery = first('delivery.action.deliver');
  const budget = first('gates.action.budget');
  const allowlist = first('gates.action.allowlist');
  const concurrency = first('gates.action.concurrency');
  const killSwitch = first('gates.action.kill-switch');
  const commentSummary = first('delivery.action.comment-summary');
  const postJson = first('http.action.post-run-json');
  const unattended = trigger !== undefined && isUnattendedTrigger(trigger.node);

  const cfg = (entry: Found | undefined, key: string, fallback: unknown): unknown => {
    const value = entry?.node.data.config[key];
    return value === undefined || value === '' ? fallback : value;
  };

  let deliver = String(cfg(delivery, 'policy', 'pr'));
  if (unattended && deliver === 'merge') {
    warnings.push('Delivery was capped at "pr": an unattended run may never merge. The kill switch, allowlist and budgets are what make it safe to start at all.');
    deliver = 'pr';
  }

  const relayConfig: Record<string, unknown> = {
    version: 1,
    agents: {
      planner: cfg(pipeline, 'planner', 'claude'),
      planReviewer: cfg(pipeline, 'planReviewer', 'codex'),
      implementer: cfg(pipeline, 'implementer', 'codex'),
      codeReviewer: cfg(pipeline, 'codeReviewer', 'claude'),
    },
    models: {},
    workflow: {
      maxConcurrentRuns: Number(cfg(concurrency, 'maxConcurrentRuns', 1)),
      review: fast ? 'light' : cfg(pipeline, 'review', 'standard'),
      plan: fast ? 'inline' : 'review',
      reviewCode: !fast,
      maxPlanReviewRounds: Number(cfg(pipeline, 'maxPlanReviewRounds', 2)),
      maxCodeReviewRounds: Number(cfg(pipeline, 'maxCodeReviewRounds', 2)),
      baseBranch: String(cfg(pipeline, 'baseBranch', '')) === 'main' ? '' : String(cfg(pipeline, 'baseBranch', '')),
      branchPrefix: String(cfg(pipeline, 'branchPrefix', brand.slug)),
      runTests: Boolean(cfg(pipeline, 'runTests', true)),
      deliver,
      mergeMethod: cfg(delivery, 'mergeMethod', 'squash'),
      offerMerge: false,
      maxTransientRetries: 2,
      maxCostUsd: numberOrNull(cfg(pipeline, 'maxCostUsd', null)),
      confirmAboveUsd: numberOrNull(cfg(budget, 'confirmAboveUsd', null)),
      primeReviewers: Boolean(cfg(pipeline, 'primeReviewers', true)),
      concurrentTests: Boolean(cfg(pipeline, 'concurrentTests', true)),
      typos: false,
      triggerLabel: triggerLabelFor(trigger, brand),
    },
    unattended: {
      enabled: killSwitch === undefined ? unattended : Boolean(cfg(killSwitch, 'enabled', false)),
      authors: lines(cfg(allowlist, 'authors', '')),
      teams: lines(cfg(allowlist, 'teams', '')),
      maxDailyCostUsd: numberOrNull(cfg(budget, 'maxDailyCostUsd', null)),
      maxRunCostUsd: numberOrNull(cfg(budget, 'maxRunCostUsd', null)),
      pollSeconds: 60,
      deliver: deliver === 'merge' ? 'pr' : deliver,
    },
    github: {
      autoPush: deliver === 'push' || deliver === 'pr' || deliver === 'merge',
      autoPr: deliver === 'pr' || deliver === 'merge',
      autoMerge: deliver === 'merge',
      mergeMethod: cfg(delivery, 'mergeMethod', 'squash'),
      deleteBranchOnMerge: Boolean(cfg(delivery, 'deleteBranchOnMerge', true)),
      protectedBranches: ['main', 'master'],
    },
    tests: { command: splitCommand(cfg(pipeline, 'testCommand', '')) },
    delivery: { comment: commentSummary !== undefined || unattended },
    notify: {
      webhook: postJson === undefined ? null : String(cfg(postJson, 'url', '')) || null,
      bell: false,
      system: false,
      command: null,
    },
  };

  if (unattended && (relayConfig.unattended as { authors: string[] }).authors.length === 0 && (relayConfig.unattended as { teams: string[] }).teams.length === 0) {
    warnings.push('The allowlist is empty, so `relay serve` and the Action will refuse every trigger. Add logins to an Author allowlist gate.');
  }
  if (unattended && budget === undefined) {
    warnings.push('No budget gate: unattended.maxRunCostUsd and maxDailyCostUsd are unset, and the Action will refuse to start until they are.');
  }
  if (pipeline === undefined) {
    warnings.push('No agent pipeline in this workflow, so the config describes defaults and the Action will not run any agent.');
  }

  const downstream = all((entry) => entry.def.kind === 'action' && !['pipeline', 'gates', 'delivery', 'logic', 'schedule'].includes(entry.def.connectorId) && entry.def.id !== 'http.action.post-run-json');
  const secrets: Array<{ name: string; why: string }> = [
    auth.claude === 'subscription'
      ? { name: 'CLAUDE_CODE_OAUTH_TOKEN', why: 'Your Claude subscription, as a one-year token from `claude setup-token`. Read by Claude Code, never by the orchestrator.' }
      : { name: 'ANTHROPIC_API_KEY', why: 'An Anthropic Console key. Read by Claude Code, never by the orchestrator.' },
    auth.codex === 'subscription'
      ? { name: 'CODEX_AUTH_JSON', why: 'Your ChatGPT sign-in, as the contents of ~/.codex/auth.json. Restored onto the runner for Codex, never read by the orchestrator.' }
      : { name: 'OPENAI_API_KEY', why: 'An OpenAI Platform key. Read by Codex, never by the orchestrator.' },
  ];
  if (auth.codex === 'subscription') {
    warnings.push('Codex runs on your ChatGPT subscription via ~/.codex/auth.json. OpenAI documents this for CI but asks that it not be used on public repositories, and the file rotates: if runs start failing to sign in, run `codex login` again and re-seed the secret.');
  }
  const yaml = renderActionYaml({ workflow, brand, trigger, downstream, secrets, warnings, deliver, unattended, auth });

  const files: CompiledFile[] = [
    { path: '.relay/config.json', language: 'json', content: JSON.stringify(relayConfig, null, 2) + '\n', description: 'What the CLI reads. Commit it to the repository this workflow is attached to.' },
    { path: `.github/workflows/${slugify(workflow.name)}.yml`, language: 'yaml', content: yaml, description: 'Runs the pipeline on your own GitHub Actions minutes. Free on public repos, 3,000 min/month on private with Pro.' },
    { path: `${brand.slug}-workflow.json`, language: 'json', content: JSON.stringify({ product: brand.name, exportedAt: new Date().toISOString(), workflow }, null, 2) + '\n', description: 'The graph itself, importable back into the builder.' },
    { path: 'SETUP.md', language: 'markdown', content: renderSetup({ workflow, brand, secrets, warnings, unattended, auth }), description: 'What to add where.' },
  ];

  return { files, warnings, secrets };
}

/* ------------------------------------------------------------------ */

function triggerLabelFor(trigger: Found | undefined, brand: Brand): string {
  const label = trigger?.node.data.config['label'];
  if (typeof label === 'string' && label.trim().length > 0) return label.trim();
  return `${brand.slug}:go`;
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function lines(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((s) => s.trim()).filter(Boolean);
  return String(value ?? '')
    .split(/[\n,]/)
    .map((s) => s.trim().replace(/^@/, ''))
    .filter(Boolean);
}

function splitCommand(value: unknown): string[] | null {
  const text = String(value ?? '').trim();
  if (text.length === 0) return null;
  return text.split(/\s+/);
}

/** `{{issue.title}}` → `${{ github.event.issue.title }}` and friends, for a message rendered inside the Action. */
function toActionsExpression(template: string): string {
  return template
    .replace(/\{\{\s*issue\.key\s*\}\}/g, '#${{ github.event.issue.number }}')
    .replace(/\{\{\s*issue\.title\s*\}\}/g, '${{ github.event.issue.title }}')
    .replace(/\{\{\s*issue\.url\s*\}\}/g, '${{ github.event.issue.html_url }}')
    .replace(/\{\{\s*issue\.assignee\s*\}\}/g, '${{ github.event.issue.assignee.login }}')
    .replace(/\{\{\s*issue\.labels\s*\}\}/g, '${{ join(github.event.issue.labels.*.name, \', \') }}')
    .replace(/\{\{\s*run\.id\s*\}\}/g, '${{ steps.relay.outputs.run-id }}')
    .replace(/\{\{\s*run\.status\s*\}\}/g, '${{ steps.result.outputs.status }}')
    .replace(/\{\{\s*run\.prUrl\s*\}\}/g, '${{ steps.result.outputs.pr-url }}')
    .replace(/\{\{\s*run\.cost\s*\}\}/g, '${{ steps.result.outputs.cost }}')
    .replace(/\{\{\s*run\.summary\s*\}\}/g, '${{ steps.result.outputs.summary }}')
    .replace(/\{\{\s*workflow\.repository\s*\}\}/g, '${{ github.repository }}')
    .replace(/\{\{\s*[a-zA-Z0-9_.\-]+\s*\}\}/g, '');
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function renderActionYaml(input: {
  workflow: Workflow;
  brand: Brand;
  trigger: Found | undefined;
  downstream: Found[];
  secrets: Array<{ name: string; why: string }>;
  warnings: string[];
  deliver: string;
  unattended: boolean;
  auth: { claude: AuthPreference; codex: AuthPreference };
}): string {
  const { workflow, brand, trigger, downstream, secrets, auth } = input;
  const triggerConnector = trigger?.def.connectorId ?? 'manual';
  const githubNative = triggerConnector === 'github' || triggerConnector === 'github-issues';
  const scheduled = triggerConnector === 'schedule';
  const cron = String(trigger?.node.data.config['cron'] ?? '0 9 * * 1-5');

  const on: string[] = [];
  if (githubNative) on.push('  issues:\n    types: [labeled, assigned]');
  if (scheduled) on.push(`  schedule:\n    - cron: ${yamlString(cron)}`);
  on.push(`  repository_dispatch:\n    types: [${brand.slug}-${slugify(workflow.name)}]`);
  on.push('  workflow_dispatch:\n    inputs:\n      issue:\n        description: Issue number to work on\n        required: true');

  const steps: string[] = [];
  const notifyLines: string[] = [];

  for (const entry of downstream) {
    const connector = getConnector(entry.def.connectorId);
    const name = `${connector?.name ?? entry.def.connectorId}: ${entry.def.name}`;
    const templates = entry.def.fields.filter((field) => field.type === 'template');
    const messageField = templates[0];
    const rawMessage = messageField === undefined ? `${brand.name} finished {{run.status}} for {{issue.title}} — {{run.prUrl}}` : String(entry.node.data.config[messageField.key] ?? messageField.default ?? '');
    const message = toActionsExpression(rawMessage).replace(/\n/g, '\\n');

    if (entry.def.connectorId === 'slack') {
      secrets.push({ name: 'SLACK_WEBHOOK_URL', why: `Incoming webhook for "${name}".` });
      notifyLines.push(`      - name: ${yamlString(name)}
        if: always()
        env:
          SLACK_WEBHOOK_URL: \${{ secrets.SLACK_WEBHOOK_URL }}
          TEXT: ${yamlString(message)}
        run: |
          curl -fsS -X POST -H 'content-type: application/json' \\
            --data "$(jq -n --arg text "$TEXT" '{text: $text}')" "$SLACK_WEBHOOK_URL"`);
    } else if (entry.def.connectorId === 'discord') {
      secrets.push({ name: 'DISCORD_WEBHOOK_URL', why: `Channel webhook for "${name}".` });
      notifyLines.push(`      - name: ${yamlString(name)}
        if: always()
        env:
          DISCORD_WEBHOOK_URL: \${{ secrets.DISCORD_WEBHOOK_URL }}
          TEXT: ${yamlString(message)}
        run: |
          curl -fsS -X POST -H 'content-type: application/json' \\
            --data "$(jq -n --arg content "$TEXT" '{content: $content}')" "$DISCORD_WEBHOOK_URL"`);
    } else if (entry.def.connectorId === 'http' && entry.def.specId === 'request') {
      const url = String(entry.node.data.config['url'] ?? '');
      const method = String(entry.node.data.config['method'] ?? 'POST');
      notifyLines.push(`      - name: ${yamlString(name)}
        if: always()
        env:
          BODY: ${yamlString(toActionsExpression(String(entry.node.data.config['body'] ?? '{}')))}
        run: curl -fsS -X ${method} -H 'content-type: application/json' --data "$BODY" ${yamlString(url)}`);
    } else {
      // Every other app goes through a bridge URL: the hosted product would own
      // this; locally it is any endpoint that accepts JSON (n8n, a Zapier catch
      // hook, your own server). The step says exactly what it would have done.
      if (!secrets.some((secret) => secret.name === 'BRIDGE_WEBHOOK_URL')) {
        secrets.push({ name: 'BRIDGE_WEBHOOK_URL', why: `Receives ${entry.def.connectorId} and any other non-GitHub action as JSON. In the hosted product this is ${brand.name} itself.` });
      }
      const payload = JSON.stringify({ connector: entry.def.connectorId, action: entry.def.specId, config: entry.node.data.config });
      notifyLines.push(`      - name: ${yamlString(name)}
        if: always()
        env:
          BRIDGE_WEBHOOK_URL: \${{ secrets.BRIDGE_WEBHOOK_URL }}
          RUN_ID: \${{ steps.relay.outputs.run-id }}
          PR_URL: \${{ steps.result.outputs.pr-url }}
          STATUS: \${{ steps.result.outputs.status }}
          MESSAGE: ${yamlString(message)}
          ACTION: ${yamlString(payload)}
        run: |
          # ${brand.name} bridge: ${entry.def.connectorId}.${entry.def.specId}
          [ -n "$BRIDGE_WEBHOOK_URL" ] || { echo "BRIDGE_WEBHOOK_URL not set; skipping ${entry.def.connectorId}"; exit 0; }
          curl -fsS -X POST -H 'content-type: application/json' \\
            --data "$(jq -n --arg run "$RUN_ID" --arg pr "$PR_URL" --arg status "$STATUS" --arg message "$MESSAGE" --argjson action "$ACTION" \\
              '{run: $run, prUrl: $pr, status: $status, message: $message, action: $action, repository: env.GITHUB_REPOSITORY}')" \\
            "$BRIDGE_WEBHOOK_URL"`);
    }
  }

  steps.push(`      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          token: \${{ secrets.GITHUB_TOKEN }}

      - uses: actions/setup-node@v4
        with:
          node-version: 22

      - name: Install the reviewer sandbox
        # Read-only reviewer turns run under bubblewrap on Linux. The runner image
        # does not ship it; without it the pipeline still runs and says the
        # sandbox was unavailable.
        run: sudo apt-get update -q && sudo apt-get install -y -q bubblewrap jq

      - name: Install the agent CLIs
        run: npm install -g @anthropic-ai/claude-code @openai/codex
${auth.codex === 'subscription' ? `
      - name: Restore the Codex sign-in
        # OpenAI's documented way to run Codex on a ChatGPT plan in CI: put the
        # file \`codex login\` wrote on the runner. Codex refreshes it itself. Not
        # for public repositories, per OpenAI's guidance.
        env:
          CODEX_AUTH_JSON: \${{ secrets.CODEX_AUTH_JSON }}
        run: |
          [ -n "$CODEX_AUTH_JSON" ] || { echo "CODEX_AUTH_JSON secret is not set; Codex will not be signed in." ; exit 0; }
          mkdir -p "$HOME/.codex"
          umask 077
          printf '%s' "$CODEX_AUTH_JSON" > "$HOME/.codex/auth.json"
          codex login status
` : ''}
      - name: ${yamlString(`Run ${brand.name}`)}
        id: relay
        uses: aydinmrnv/relay@main
        with:
          issue: \${{ github.event.issue.number || inputs.issue || github.event.client_payload.issue }}
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          # Each vendor CLI reads its own variable. The orchestrator reads none of them.
${auth.claude === 'subscription' ? `          CLAUDE_CODE_OAUTH_TOKEN: \${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}   # from: claude setup-token (Pro / Max / Team / Enterprise)` : `          ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}`}
${auth.codex === 'subscription' ? `          CODEX_HOME: \${{ env.HOME }}/.codex` : `          OPENAI_API_KEY: \${{ secrets.OPENAI_API_KEY }}`}

      - name: Read the result
        id: result
        if: always()
        run: |
          run_id="\${{ steps.relay.outputs.run-id }}"
          summary=".relay/runs/$run_id/summary.md"
          pr_url=$(grep -oE 'https://github.com/[^ )]+/pull/[0-9]+' "$summary" 2>/dev/null | head -1 || true)
          cost=$(grep -oE '\\$[0-9]+\\.[0-9]{2}' "$summary" 2>/dev/null | head -1 || true)
          status="succeeded"; [ "\${{ steps.relay.outputs.exit-code }}" = "0" ] || status="failed"
          {
            echo "pr-url=$pr_url"
            echo "cost=$cost"
            echo "status=$status"
            echo "summary<<EOF"; head -c 3000 "$summary" 2>/dev/null || echo "(no summary)"; echo; echo "EOF"
          } >> "$GITHUB_OUTPUT"`);

  const permissions = input.deliver === 'none' || input.deliver === 'branch' ? 'contents: read' : 'contents: write\n  pull-requests: write\n  issues: write';

  return `# Generated by ${brand.name} from the workflow "${workflow.name}".
#
# Trigger: ${trigger?.def.connector.name ?? 'manual'} → ${trigger?.def.name ?? 'run'}.
# ${githubNative ? 'GitHub is the source, so the Action fires on the issue event directly.' : `The source is ${trigger?.def.connector.name ?? 'external'}; the hosted product bridges it to \`repository_dispatch\`. Until then, dispatch from anywhere with:`}
# ${githubNative ? '' : `  gh api repos/OWNER/REPO/dispatches -f event_type=${brand.slug}-${slugify(workflow.name)} -F 'client_payload[issue]=142'`}
#
# Guardrails (allowlist, budgets, delivery ceiling) are read from .relay/config.json,
# never from this file: a workflow file is editable by anyone who can open a PR.
name: ${yamlString(`${brand.name} · ${workflow.name}`)}

on:
${on.join('\n')}

permissions:
  ${permissions.replace(/\n/g, '\n  ')}

concurrency:
  group: ${brand.slug}-\${{ github.event.issue.number || inputs.issue || github.run_id }}
  cancel-in-progress: false

jobs:
  ${brand.slug}:
    runs-on: ubuntu-latest
    timeout-minutes: 120
    steps:
${steps.join('\n\n')}
${notifyLines.length > 0 ? '\n' + notifyLines.join('\n\n') + '\n' : ''}`;
}

function renderSetup(input: { workflow: Workflow; brand: Brand; secrets: Array<{ name: string; why: string }>; warnings: string[]; unattended: boolean; auth: { claude: AuthPreference; codex: AuthPreference } }): string {
  const { workflow, brand, secrets, warnings, auth } = input;
  const unique = new Map(secrets.map((secret) => [secret.name, secret]));
  const repo = workflow.repository ?? 'OWNER/REPO';
  const claudeHow = auth.claude === 'subscription'
    ? `\`\`\`bash
claude setup-token                                   # opens a sign-in page; prints a one-year token
gh secret set CLAUDE_CODE_OAUTH_TOKEN -R ${repo}     # paste the token when asked
\`\`\`
The token is tied to the person who created it and usage counts against that plan (Pro, Max, Team or Enterprise).`
    : `\`\`\`bash
gh secret set ANTHROPIC_API_KEY -R ${repo}           # paste a key from the Anthropic Console
\`\`\``;
  const codexHow = auth.codex === 'subscription'
    ? `\`\`\`bash
codex login                                          # sign in with ChatGPT if you have not already
gh secret set CODEX_AUTH_JSON -R ${repo} < ~/.codex/auth.json
\`\`\`
This is OpenAI's documented method for CI. Treat the file like a password, do not use it on a public repository, and re-seed the secret if runs stop signing in.`
    : `\`\`\`bash
gh secret set OPENAI_API_KEY -R ${repo}              # paste a key from the OpenAI Platform
\`\`\``;
  return `# ${brand.name} · ${workflow.name}

This bundle runs the workflow on your own GitHub Actions minutes. Nothing is hosted, nothing is billed by ${brand.name}.

## 1. Commit two files

- \`.relay/config.json\` — the agents, review level, guardrails and delivery ceiling.
- \`.github/workflows/${slugify(workflow.name)}.yml\` — the Action that runs the pipeline.

## 2. Bring your own subscriptions

Runs use the same accounts you use on your laptop. Nothing is billed by ${brand.name}, and the orchestrator never reads a credential: each value below is read by the vendor's own CLI inside its own process.

**Claude Code**

${claudeHow}

**Codex**

${codexHow}

All secrets this workflow references:

${[...unique.values()].map((secret) => `- \`${secret.name}\` — ${secret.why}`).join('\n')}

## 3. Try it

\`\`\`bash
npm install -g relay-orchestrator
relay start --dry-run        # walks the pipeline with no agent calls
\`\`\`
${warnings.length > 0 ? `\n## Things the canvas said that the files could not\n\n${warnings.map((warning) => `- ${warning}`).join('\n')}\n` : ''}
## What runs where

| Part | Where |
|---|---|
| Trigger | ${input.unattended ? 'GitHub issue event, schedule, or `repository_dispatch` from the source app' : 'You, by hand'} |
| Agents | The Actions runner, under bubblewrap for reviewer turns |
| Delivery | Your repository, as far as the policy in config.json allows |
| Notifications | Direct webhooks (Slack, Discord, HTTP) or the bridge URL |
`;
}
