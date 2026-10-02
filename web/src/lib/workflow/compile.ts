/**
 * Graph → files a repository can use.
 *
 * Export writes the config the Relay CLI reads, plus a GitHub Actions
 * workflow that runs it on the repository's own minutes. The Action is
 * narrower than the canvas: it works on one GitHub issue per run, decides its
 * guardrails inside Relay, and cannot evaluate a Condition. So every step is
 * placed by where it sits in the graph — after delivery, on the budget
 * refusal, or not at all — and whatever the files cannot express is written
 * down as a warning rather than silently dropped or silently run.
 */
import { BRAND, slugify, type Brand } from '../brand';
import { getConnector, getNodeType, type NodeTypeDef } from '../connectors';
import { ACTION_REF, CLI_INSTALL_COMMAND } from '../links';
import { SIMULATED_ONLY } from './readiness';
import { isSecretField } from './redact';
import { isRepository, type AuthPreference, type Workflow, type WorkflowEdge, type WorkflowNode } from './schema';
import { isPlaceholderLogin, isUnattendedTrigger } from './validate';

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

/** What starts the exported Action, so the export dialog and SETUP.md can say it in the same words. */
export interface CompiledStart {
  /** `label`: adding the trigger label starts it. `event`: another issue event does, on an issue that carries the label. `dispatch`: a person does, with an issue number. */
  by: 'label' | 'event' | 'dispatch';
  /** The label Relay requires on the issue, whoever or whatever starts the Action. */
  label: string;
  /** The event, in words, when `by` is `event`. */
  event?: string;
}

export interface CompiledOutput {
  files: CompiledFile[];
  /** Reasons these files should not be used yet. The export dialog will not hand them over while there are any. */
  blockers: string[];
  warnings: string[];
  secrets: Array<{ name: string; why: string }>;
  start: CompiledStart;
}

interface Found {
  node: WorkflowNode;
  def: NodeTypeDef;
}

export function compileWorkflow(source: Workflow, brand: Brand = BRAND, options: CompileOptions = {}): CompiledOutput {
  // Nothing typed into a secret field may reach a file people are told to
  // commit: not the graph, not a step's payload. They are emptied here, once,
  // before anything reads the workflow.
  const workflow = stripSecrets(source);
  // Which HTTP requests had headers typed in: the copy below no longer says.
  const withHeaders = new Set(
    source.nodes
      .filter((node) => node.data.typeId === 'http.action.request')
      .filter((node) => {
        const value = node.data.config['headers'];
        return typeof value === 'string' ? value.trim().length > 0 && value.trim() !== '{}' : value !== undefined && value !== null;
      })
      .map((node) => node.id),
  );
  const warnings: string[] = [];
  const blockers: string[] = [];
  const auth = options.auth ?? { claude: 'subscription', codex: 'subscription' };
  const found = workflow.nodes
    .map((node) => ({ node, def: getNodeType(node.data.typeId) }))
    .filter((entry): entry is Found => entry.def !== undefined);

  const first = (id: string) => found.find((entry) => entry.def.id === id);

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

  // The per-run ceiling. The pipeline node has its own; the Budget gate's
  // applies to unattended runs in the engine, but a run somebody starts from
  // the studio or a terminal is the same money, so the lower of the two is
  // what every run is held to.
  const runCaps = [numberOrNull(cfg(pipeline, 'maxCostUsd', null)), numberOrNull(cfg(budget, 'maxRunCostUsd', null))].filter((value): value is number => value !== null);
  const label = triggerLabelFor(trigger, brand);

  // The templates fill the allowlist with example names so a test run has
  // somebody to allow. They never reach a config: `you` is not a login.
  const listed = { authors: lines(cfg(allowlist, 'authors', '')), teams: lines(cfg(allowlist, 'teams', '')) };
  const allowed = { authors: listed.authors.filter((login) => !isPlaceholderLogin(login)), teams: listed.teams.filter((team) => !isPlaceholderLogin(team)) };
  const examples = [...listed.authors, ...listed.teams].filter(isPlaceholderLogin);
  if (examples.length > 0) {
    blockers.push(`The Author allowlist still has the example names ${list(examples)}. Replace them with the GitHub logins (or org/team) of the people who may start runs.`);
  }
  if (!isRepository(workflow.repository)) {
    blockers.push('This workflow is not attached to a repository yet. Say which one, as owner/name.');
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
      maxCostUsd: runCaps.length === 0 ? null : Math.min(...runCaps),
      confirmAboveUsd: numberOrNull(cfg(budget, 'confirmAboveUsd', null)),
      primeReviewers: Boolean(cfg(pipeline, 'primeReviewers', true)),
      concurrentTests: Boolean(cfg(pipeline, 'concurrentTests', true)),
      typos: false,
      triggerLabel: label,
    },
    unattended: {
      // A paused workflow exports with its trigger switched off, so the
      // "Active" switch in the builder means the same thing in the repository.
      enabled: workflow.enabled !== false && (killSwitch === undefined ? unattended : Boolean(cfg(killSwitch, 'enabled', false))),
      authors: allowed.authors,
      teams: allowed.teams,
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

  if (workflow.enabled === false && unattended) {
    warnings.push('This workflow is paused, so the export has unattended.enabled set to false and a label starts nothing. Switch it to Active in the builder and export again when it should run by itself.');
  }
  if (unattended && (relayConfig.unattended as { authors: string[] }).authors.length === 0 && (relayConfig.unattended as { teams: string[] }).teams.length === 0) {
    // True whatever the trigger is: the Action starts from an issue, and the
    // engine asks who put the trigger label on it before it spends anything.
    warnings.push(`The allowlist is empty. The exported Action works on an issue labelled ${label}, and Relay refuses a label applied by anyone who is not on unattended.authors or unattended.teams. Add the logins who may start runs to an Author allowlist gate.`);
  }
  if (unattended && budget === undefined) {
    warnings.push('No budget gate: unattended.maxRunCostUsd and maxDailyCostUsd are unset, and the Action will refuse to start until they are.');
  }
  if (pipeline === undefined) {
    warnings.push('No agent pipeline in this workflow, so the exported Action runs no agent: it only performs the app steps that need no decision.');
  }
  const webhook = (relayConfig.notify as { webhook: string | null }).webhook;
  if (webhook !== null && CREDENTIAL_URL.test(webhook)) {
    warnings.push('The URL in “Post the run as JSON” looks like it carries a credential, and it is written to .relay/config.json, which you commit. Use an endpoint whose address is not itself the secret.');
  }
  const simulated = [...new Set(found.filter((entry) => entry.def.kind === 'action' && SIMULATED_ONLY.has(entry.def.id)).map((entry) => entry.def.name))];
  if (simulated.length > 0) {
    warnings.push(`${list(simulated)} ${simulated.length === 1 ? 'is' : 'are'} played in test runs only. The exported files do not perform ${simulated.length === 1 ? 'it' : 'them'}: Relay decides the allowlist and the budget itself, then runs the pipeline on the issue it is given.`);
  }

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

  const start = startFor(trigger, label, warnings);
  const placed = placeSteps({ workflow, found, trigger, pipeline, delivery, warnings });
  const yaml = renderActionYaml({ workflow, brand, trigger, pipeline, placed, secrets, warnings, deliver, auth, start, withHeaders });

  const files: CompiledFile[] = [
    { path: '.relay/config.json', language: 'json', content: JSON.stringify(relayConfig, null, 2) + '\n', description: 'What the CLI reads. Commit it to the repository this workflow is attached to.' },
    { path: `.github/workflows/${slugify(workflow.name)}.yml`, language: 'yaml', content: yaml, description: 'Runs the pipeline on your own GitHub Actions minutes.' },
    { path: `${brand.slug}-workflow.json`, language: 'json', content: JSON.stringify({ product: brand.name, exportedAt: new Date().toISOString(), workflow }, null, 2) + '\n', description: 'The graph itself, importable back into the builder. Secret fields are left empty.' },
    { path: 'SETUP.md', language: 'markdown', content: renderSetup({ workflow, brand, secrets, warnings, start, auth, agents: pipeline !== undefined }), description: 'What to add where.' },
  ];

  return { files, blockers, warnings, secrets: [...new Map(secrets.map((secret) => [secret.name, secret])).values()], start };
}

/* ------------------------------------------------------------------ */

/** A URL that is itself a credential: a chat webhook, user:password@, or a token in the query. */
const CREDENTIAL_URL = /hooks\.slack\.com|discord(?:app)?\.com\/api\/webhooks|\/\/[^/\s@]+:[^/\s@]+@|[?&](?:token|key|secret|sig|signature|access_token)=/i;

/** The workflow with every secret field removed from every node, so no file made from it can carry one. */
function stripSecrets(workflow: Workflow): Workflow {
  return {
    ...workflow,
    nodes: workflow.nodes.map((node) => {
      const kept = Object.entries(node.data.config).filter(([key]) => !isSecretField(node.data.typeId, key));
      return kept.length === Object.keys(node.data.config).length ? node : { ...node, data: { ...node.data, config: Object.fromEntries(kept) } };
    }),
  };
}

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

function list(names: string[]): string {
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** A value for a double-quoted YAML scalar. JSON's escapes are YAML's, so a newline stays a newline. */
function yamlString(value: string): string {
  return JSON.stringify(value);
}

/** A string literal inside a GitHub Actions expression. */
function expressionString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/* ------------------------------------------------------------------ */
/* What starts the Action                                              */
/* ------------------------------------------------------------------ */

interface StartPlan extends CompiledStart {
  /** Lines of the `on:` block. */
  on: string[];
  /** A job-level condition, so an event this workflow is not about costs no runner minutes. */
  jobIf: string | null;
}

/**
 * The `on:` block, from the trigger. Relay works on one GitHub issue per run
 * and requires its trigger label on that issue, so only GitHub issue events
 * can start the Action by themselves; everything else is started with an
 * issue number, by hand or by `repository_dispatch`.
 */
function startFor(trigger: Found | undefined, label: string, warnings: string[]): StartPlan {
  const dispatch = (): StartPlan => ({ by: 'dispatch', label, on: [], jobIf: null });
  if (trigger === undefined || trigger.def.id === 'logic.trigger.manual') return dispatch();

  const text = (key: string) => String(trigger.node.data.config[key] ?? '').trim();
  if (trigger.def.connectorId === 'github-issues') {
    switch (trigger.def.specId) {
      case 'issue-labelled':
        return { by: 'label', label, on: ['  issues:\n    types: [labeled]'], jobIf: `github.event_name != 'issues' || github.event.label.name == ${expressionString(label)}` };
      case 'issue-opened':
        warnings.push(`The Action fires when an issue is opened, and Relay then works on it only if it already carries ${label}, applied by someone on the allowlist.`);
        return { by: 'event', event: 'an issue is opened', label, on: ['  issues:\n    types: [opened]'], jobIf: null };
      case 'issue-assigned': {
        const assignee = text('assignee').replace(/^@/, '');
        warnings.push(`The Action fires when an issue is assigned${assignee.length > 0 ? ` to ${assignee}` : ''}, and Relay then works on it only if it also carries ${label}, applied by someone on the allowlist. Assignment alone starts nothing.`);
        return {
          by: 'event',
          event: `an issue is assigned${assignee.length > 0 ? ` to ${assignee}` : ''}`,
          label,
          on: ['  issues:\n    types: [assigned]'],
          jobIf: assignee.length > 0 ? `github.event_name != 'issues' || github.event.assignee.login == ${expressionString(assignee)}` : null,
        };
      }
      case 'issue-comment': {
        const mention = text('mention');
        warnings.push(`The Action fires on a comment${mention.length > 0 ? ` that mentions ${mention}` : ''}, and Relay then works on the issue only if it also carries ${label}, applied by someone on the allowlist. A comment alone starts nothing.`);
        const notPullRequest = '!github.event.issue.pull_request';
        return {
          by: 'event',
          event: `a comment${mention.length > 0 ? ` mentions ${mention}` : ' is added'}`,
          label,
          on: ['  issue_comment:\n    types: [created]'],
          jobIf: `github.event_name != 'issue_comment' || (${notPullRequest}${mention.length > 0 ? ` && contains(github.event.comment.body, ${expressionString(mention)})` : ''})`,
        };
      }
      default:
        break;
    }
  }

  warnings.push(
    trigger.def.connectorId === 'schedule'
      ? `A schedule has no issue to work on, and the exported Action works on one GitHub issue per run, so the clock does not start it. Start it with an issue number: Actions → Run workflow, or repository_dispatch.`
      : `Nothing in the export listens for “${trigger.def.name}” from ${trigger.def.connector.name}: the exported Action works on one GitHub issue per run. Start it with an issue number: Actions → Run workflow, or repository_dispatch from anything that can call GitHub.`,
  );
  return dispatch();
}

/* ------------------------------------------------------------------ */
/* Where each app step goes                                            */
/* ------------------------------------------------------------------ */

type When = 'always' | 'started' | 'delivered' | 'budget-refused';

interface Placed {
  entry: Found;
  when: When;
}

/** `if:` for each placement. `always()` so a step still reports after the pipeline step fails. */
const CONDITION: Record<When, string | null> = {
  always: null,
  started: "always() && steps.relay.outputs.started == 'true'",
  delivered: "always() && steps.result.outputs.status == 'succeeded'",
  'budget-refused': "always() && steps.relay.outputs.started != 'true' && steps.relay.outputs.stopped-by == 'budget'",
};

/**
 * Decides, from the edges, when each app step may run in the Action.
 *
 * The Action cannot follow the graph node by node: the gates are decided
 * inside Relay, and nothing there evaluates a Condition or waits for an
 * approval. What it does know afterwards is whether a run started, whether it
 * succeeded, and whether the budget is what stopped it. So:
 *
 * - a step after Delivery runs when the run succeeded;
 * - a step after the pipeline (or on the way to it) runs when a run started;
 * - a step on a Budget gate's "Refused" output runs when the budget refused;
 * - a step only reachable through something the Action cannot tell — an
 *   allowlist refusal, a rejected approval, a Condition's other branch — is
 *   left out, and a warning says so.
 */
function placeSteps(input: { workflow: Workflow; found: Found[]; trigger: Found | undefined; pipeline: Found | undefined; delivery: Found | undefined; warnings: string[] }): Placed[] {
  const { workflow, found, trigger, pipeline, delivery, warnings } = input;
  const defs = new Map(found.map((entry) => [entry.node.id, entry.def]));
  const out = new Map<string, WorkflowEdge[]>();
  for (const edge of workflow.edges) {
    if (!defs.has(edge.source) || !defs.has(edge.target)) continue;
    out.set(edge.source, [...(out.get(edge.source) ?? []), edge]);
  }

  const reachCache = new Map<string, Set<string>>();
  /** Everything downstream of a node, the node itself excluded. `skip` nodes are not walked through. */
  const reach = (from: string, skip?: (id: string) => boolean): Set<string> => {
    const cached = skip === undefined ? reachCache.get(from) : undefined;
    if (cached !== undefined) return cached;
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length > 0) {
      const id = stack.pop()!;
      for (const edge of out.get(id) ?? []) {
        if (seen.has(edge.target)) continue;
        seen.add(edge.target);
        if (skip?.(edge.target) !== true) stack.push(edge.target);
      }
    }
    if (skip === undefined) reachCache.set(from, seen);
    return seen;
  };

  const pipelineId = pipeline?.node.id;
  const afterPipeline = pipelineId === undefined ? new Set<string>() : reach(pipelineId);
  // Reachable from the pipeline without passing through a step the Action cannot evaluate.
  const opaque = (id: string) => ['logic.action.condition', 'logic.action.filter', 'gates.action.approval'].includes(defs.get(id)?.id ?? '');
  const clearlyAfterPipeline = pipelineId === undefined ? new Set<string>() : reach(pipelineId, opaque);
  const afterDelivery = delivery === undefined ? new Set<string>() : reach(delivery.node.id, opaque);

  // Before the pipeline: the best way each node can be reached from the
  // trigger. 0 = along the path a run takes, 1 = off it at a budget refusal,
  // 2 = off it somewhere the Action cannot tell.
  const best = new Map<string, number>();
  const elsewhere = new Set<string>();
  if (trigger !== undefined) {
    const queue: Array<{ id: string; state: number }> = [{ id: trigger.node.id, state: 0 }];
    while (queue.length > 0) {
      const { id, state } = queue.shift()!;
      if (state === 2) elsewhere.add(id);
      if ((best.get(id) ?? 3) <= state) continue;
      best.set(id, state);
      if (id === pipelineId) continue;
      const def = defs.get(id)!;
      for (const edge of out.get(id) ?? []) {
        const handle = edge.sourceHandle ?? def.outputs[0]?.id;
        let next = state;
        if (def.id === 'gates.action.budget' && handle === 'refused') next = state === 0 ? 1 : 2;
        else if ((def.id === 'gates.action.allowlist' && handle === 'refused') || (def.id === 'gates.action.approval' && handle === 'rejected')) next = 2;
        else if (def.id === 'logic.action.condition') {
          // The Action always runs the pipeline for the issue it is given, so
          // the branch that leads there is the one a run is on.
          const towardsPipeline = pipelineId !== undefined && (edge.target === pipelineId || reach(edge.target).has(pipelineId));
          if (!towardsPipeline) next = 2;
        }
        queue.push({ id: edge.target, state: next });
      }
    }
  }

  const steps = found.filter((entry) => entry.def.kind === 'action' && !['pipeline', 'gates', 'delivery', 'logic', 'schedule'].includes(entry.def.connectorId) && entry.def.id !== 'http.action.post-run-json');
  const order = new Map(found.map((entry, index) => [entry.node.id, index]));
  const placed: Placed[] = [];
  const leftOut: string[] = [];
  const partly: string[] = [];
  for (const entry of steps) {
    const id = entry.node.id;
    const name = stepName(entry);
    if (afterPipeline.has(id)) {
      if (!clearlyAfterPipeline.has(id)) leftOut.push(name);
      else placed.push({ entry, when: afterDelivery.has(id) ? 'delivered' : 'started' });
      continue;
    }
    const state = best.get(id);
    if (state === 0) placed.push({ entry, when: pipeline === undefined ? 'always' : 'started' });
    else if (state === 1 && pipeline !== undefined) {
      placed.push({ entry, when: 'budget-refused' });
      if (elsewhere.has(id)) partly.push(name);
    } else if (state !== undefined) leftOut.push(name);
    // Not reachable from the trigger at all: the validator already says it never runs.
  }
  if (leftOut.length > 0) {
    warnings.push(`Left out of the Action: ${list(leftOut.map((name) => `“${name}”`))}. ${leftOut.length === 1 ? 'It sits' : 'They sit'} behind a decision the Action cannot make (a Condition, an approval, or an allowlist refusal, which it cannot tell from an ignored issue). Test runs still play ${leftOut.length === 1 ? 'it' : 'them'}.`);
  }
  if (partly.length > 0) {
    warnings.push(`${list(partly.map((name) => `“${name}”`))} ${partly.length === 1 ? 'runs' : 'run'} in the Action when the budget refuses a run, but not for the other refusals wired to ${partly.length === 1 ? 'it' : 'them'}: the Action cannot tell those from an ignored issue.`);
  }
  const before = placed.filter((step) => step.when === 'started' && !afterPipeline.has(step.entry.node.id));
  if (before.length > 0) {
    warnings.push(`${list(before.map((step) => `“${stepName(step.entry)}”`))} ${before.length === 1 ? 'sits' : 'sit'} before the pipeline on the canvas, but in the Action ${before.length === 1 ? 'it runs' : 'they run'} once the run has finished: Relay decides the gates itself, so only then is it known that a run started.`);
  }
  return placed.sort((a, b) => (order.get(a.entry.node.id) ?? 0) - (order.get(b.entry.node.id) ?? 0));
}

function stepName(entry: Found): string {
  const custom = entry.node.data.label;
  if (typeof custom === 'string' && custom.trim().length > 0) return custom.trim();
  return `${getConnector(entry.def.connectorId)?.name ?? entry.def.connectorId}: ${entry.def.name}`;
}

/* ------------------------------------------------------------------ */
/* Messages                                                            */
/* ------------------------------------------------------------------ */

const EXPRESSIONS: Record<string, string> = {
  'issue.key': '#${{ steps.issue.outputs.number }}',
  'issue.id': '#${{ steps.issue.outputs.number }}',
  'issue.number': '${{ steps.issue.outputs.number }}',
  'issue.title': '${{ steps.issue.outputs.title }}',
  'issue.url': '${{ steps.issue.outputs.url }}',
  'issue.author': '${{ steps.issue.outputs.author }}',
  'issue.assignee': '${{ steps.issue.outputs.assignee }}',
  'issue.labels': '${{ steps.issue.outputs.labels }}',
  'run.id': '${{ steps.relay.outputs.run-id }}',
  'run.status': '${{ steps.result.outputs.status }}',
  'run.prUrl': '${{ steps.result.outputs.pr-url }}',
  'run.cost': '${{ steps.result.outputs.cost }}',
  'run.summary': '${{ steps.result.outputs.summary }}',
  'workflow.repository': '${{ github.repository }}',
};

/**
 * `{{issue.title}}` → the Actions expression that holds it. A variable the
 * Action has no value for stays readable as `[issue.commit]` and is reported,
 * rather than vanishing and leaving "red since  ()" in somebody's channel.
 */
function toActionsExpression(template: string, context: { workflow: Workflow; brand: Brand }, unknown: Set<string>): string {
  return template
    // Text somebody typed is text: `${{ … }}` in it must not become an expression in their workflow file.
    .replace(/\$\{\{/g, '$ {{')
    .replace(/\{\{\s*([a-zA-Z0-9_.\-]+)\s*\}\}/g, (_match, path: string) => {
      if (path === 'workflow.name') return context.workflow.name;
      if (path === 'product.name') return context.brand.name;
      const expression = EXPRESSIONS[path];
      if (expression !== undefined) return expression;
      unknown.add(path);
      return `[${path}]`;
    });
}

/* ------------------------------------------------------------------ */
/* The workflow file                                                   */
/* ------------------------------------------------------------------ */

const HTTP_METHODS = new Set(['POST', 'GET', 'PUT', 'PATCH', 'DELETE']);

function renderActionYaml(input: {
  workflow: Workflow;
  brand: Brand;
  trigger: Found | undefined;
  pipeline: Found | undefined;
  placed: Placed[];
  secrets: Array<{ name: string; why: string }>;
  warnings: string[];
  deliver: string;
  auth: { claude: AuthPreference; codex: AuthPreference };
  start: StartPlan;
  /** Ids of HTTP request nodes that had headers filled in. */
  withHeaders: Set<string>;
}): string {
  const { workflow, brand, trigger, pipeline, placed, secrets, warnings, auth, start, withHeaders } = input;
  const dispatchType = `${brand.slug}-${slugify(workflow.name)}`;
  const repo = workflow.repository !== undefined && workflow.repository.trim().length > 0 ? workflow.repository.trim() : '<owner>/<repo>';

  const on = [
    ...start.on,
    `  repository_dispatch:\n    types: [${dispatchType}]`,
    '  workflow_dispatch:\n    inputs:\n      issue:\n        description: Issue number to work on\n        required: true',
  ];

  const stepLines: string[] = [];
  let httpHeaders = 0;
  const httpWithHeaders = placed.filter((step) => withHeaders.has(step.entry.node.id)).length;

  for (const { entry, when } of placed) {
    const name = stepName(entry);
    const templates = entry.def.fields.filter((field) => field.type === 'template');
    const messageField = templates[0];
    const rawMessage = messageField === undefined ? `${brand.name} finished {{run.status}} for {{issue.title}} — {{run.prUrl}}` : String(entry.node.data.config[messageField.key] ?? messageField.default ?? '');
    const unknown = new Set<string>();
    const expression = (text: string) => toActionsExpression(text, { workflow, brand }, unknown);
    const message = expression(rawMessage);
    const condition = CONDITION[when];
    const head = `      - name: ${yamlString(name)}${condition === null ? '' : `\n        if: ${condition}`}`;

    if (entry.def.connectorId === 'slack') {
      secrets.push({ name: 'SLACK_WEBHOOK_URL', why: `Incoming webhook for “${name}”.` });
      stepLines.push(`${head}
        env:
          SLACK_WEBHOOK_URL: \${{ secrets.SLACK_WEBHOOK_URL }}
          TEXT: ${yamlString(message)}
        run: |
          curl -fsS -X POST -H 'content-type: application/json' \\
            --data "$(jq -n --arg text "$TEXT" '{text: $text}')" "$SLACK_WEBHOOK_URL"`);
    } else if (entry.def.connectorId === 'discord') {
      secrets.push({ name: 'DISCORD_WEBHOOK_URL', why: `Channel webhook for “${name}”.` });
      stepLines.push(`${head}
        env:
          DISCORD_WEBHOOK_URL: \${{ secrets.DISCORD_WEBHOOK_URL }}
          TEXT: ${yamlString(message)}
        run: |
          curl -fsS -X POST -H 'content-type: application/json' \\
            --data "$(jq -n --arg content "$TEXT" '{content: $content}')" "$DISCORD_WEBHOOK_URL"`);
    } else if (entry.def.id === 'http.action.request') {
      const url = expression(String(entry.node.data.config['url'] ?? ''));
      const configured = String(entry.node.data.config['method'] ?? 'POST').toUpperCase();
      const method = HTTP_METHODS.has(configured) ? configured : 'POST';
      const body = expression(String(entry.node.data.config['body'] ?? '{}'));
      // Headers are where an API's credential goes, so the export never
      // carries them: they come from a repository secret, as a JSON object.
      let headers = '';
      let headerEnv = '';
      if (withHeaders.has(entry.node.id)) {
        httpHeaders += 1;
        const secret = httpWithHeaders > 1 ? `HTTP_HEADERS_${httpHeaders}` : 'HTTP_HEADERS';
        secrets.push({ name: secret, why: `The headers for “${name}”, as a JSON object such as {"authorization": "Bearer …"}. They are not in the export, because that is where credentials go.` });
        headerEnv = `\n          HEADERS: \${{ secrets.${secret} }}`;
        headers = `
          if [ -n "$HEADERS" ]; then
            while IFS= read -r header; do args+=(-H "$header"); done < <(printf '%s' "$HEADERS" | jq -r 'to_entries[] | "\\(.key): \\(.value)"')
          fi`;
      }
      stepLines.push(`${head}
        env:
          URL: ${yamlString(url)}
          BODY: ${yamlString(body)}${headerEnv}
        run: |
          args=(-H 'content-type: application/json')${headers}
          curl -fsS -X ${method} "\${args[@]}"${method === 'GET' ? '' : ' --data "$BODY"'} "$URL"`);
    } else {
      // Every other app goes through one URL you run: anything that accepts
      // JSON (n8n, a Zapier catch hook, your own server). The step sends what
      // the node was set to do; without the URL it says so and does nothing.
      if (!secrets.some((secret) => secret.name === 'BRIDGE_WEBHOOK_URL')) {
        secrets.push({ name: 'BRIDGE_WEBHOOK_URL', why: `An endpoint of yours that accepts a JSON POST (n8n, a Zapier catch hook, your own server). It receives ${entry.def.connector.name} and every other app step that is not Slack, Discord or an HTTP request, and performs it. Without it those steps are skipped.` });
      }
      const payload = JSON.stringify({ connector: entry.def.connectorId, action: entry.def.specId, config: entry.node.data.config });
      stepLines.push(`${head}
        env:
          BRIDGE_WEBHOOK_URL: \${{ secrets.BRIDGE_WEBHOOK_URL }}
          RUN_ID: \${{ steps.relay.outputs.run-id }}
          PR_URL: \${{ steps.result.outputs.pr-url }}
          STATUS: \${{ steps.result.outputs.status }}
          MESSAGE: ${yamlString(message)}
          ACTION: ${yamlString(payload)}
        run: |
          # ${entry.def.connectorId}.${entry.def.specId}, sent to your bridge.
          [ -n "$BRIDGE_WEBHOOK_URL" ] || { echo "BRIDGE_WEBHOOK_URL is not set; skipping ${entry.def.connectorId}.${entry.def.specId}"; exit 0; }
          curl -fsS -X POST -H 'content-type: application/json' \\
            --data "$(jq -n --arg run "$RUN_ID" --arg pr "$PR_URL" --arg status "$STATUS" --arg message "$MESSAGE" --argjson action "$ACTION" \\
              '{run: $run, prUrl: $pr, status: $status, message: $message, action: $action, repository: env.GITHUB_REPOSITORY}')" \\
            "$BRIDGE_WEBHOOK_URL"`);
    }
    if (unknown.size > 0) {
      const names = [...unknown];
      warnings.push(`“${name}” uses ${list(names.map((path) => `{{${path}}}`))}, which the Action has no value for: ${names.length === 1 ? 'it appears' : 'they appear'} in the message as ${list(names.map((path) => `[${path}]`))}. The Action knows the GitHub issue (key, title, url, author, assignee, labels) and the run (id, status, prUrl, cost, summary).`);
    }
  }

  const issueRef = '${{ github.event.issue.number || inputs.issue || github.event.client_payload.issue }}';
  const steps: string[] = [];
  steps.push(`      - name: Read the issue
        id: issue
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          ISSUE: ${issueRef}
        run: |
          # The same fields whatever started the job: an issue event carries
          # them, a manual start or a dispatch carries only the number.
          file="$RUNNER_TEMP/issue.json"
          gh issue view "$ISSUE" -R "$GITHUB_REPOSITORY" --json number,title,url,author,assignees,labels > "$file" || echo '{}' > "$file"
          {
            echo "number=$(jq -r '.number // empty' "$file")"
            echo "title=$(jq -r '.title // empty' "$file" | tr -d '\\r\\n')"
            echo "url=$(jq -r '.url // empty' "$file")"
            echo "author=$(jq -r '.author.login // empty' "$file")"
            echo "assignee=$(jq -r '[.assignees[]?.login] | join(", ")' "$file")"
            echo "labels=$(jq -r '[.labels[]?.name] | join(", ")' "$file" | tr -d '\\r\\n')"
          } >> "$GITHUB_OUTPUT"`);

  if (pipeline !== undefined) {
    steps.push(`      # Pinned to a commit, with the release it is in the comment: a tag can be moved.
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0
          token: \${{ secrets.GITHUB_TOKEN }}

      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: 22

      - name: Install the reviewer sandbox
        # Claude Code's read-only turns (planning, reviewing) run under
        # bubblewrap on Linux, and the runner image does not ship it. Ubuntu
        # 24.04 also restricts the user namespaces it needs. A sandbox that is
        # installed and cannot start would fail every one of those turns, so
        # it is tried here, and if it does not work the run falls back to the
        # CLI's own deny list and says so in its log.
        run: |
          sudo apt-get update -q && sudo apt-get install -y -q bubblewrap || true
          sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0 || true
          if ! bwrap --ro-bind / / true 2>/dev/null; then
            echo "bubblewrap cannot start on this runner: reviewer turns rely on the deny list."
            echo "RELAY_NO_OS_SANDBOX=1" >> "$GITHUB_ENV"
          fi

      - name: Install the agent CLIs
        run: npm install -g @anthropic-ai/claude-code @openai/codex
${auth.codex === 'subscription' ? `
      - name: Restore the Codex sign-in
        # OpenAI's documented way to run Codex on a ChatGPT plan in CI: put the
        # file \`codex login\` wrote on the runner, where Codex looks for it
        # (~/.codex). Codex refreshes it itself. Not for public repositories,
        # per OpenAI's guidance.
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
        uses: ${ACTION_REF}
        with:
          issue: ${issueRef}
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          # Each vendor CLI reads its own variable. The orchestrator reads none of them.
${auth.claude === 'subscription' ? `          CLAUDE_CODE_OAUTH_TOKEN: \${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}   # from: claude setup-token (Pro / Max / Team / Enterprise)` : `          ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}`}${auth.codex === 'subscription' ? '' : `\n          OPENAI_API_KEY: \${{ secrets.OPENAI_API_KEY }}`}

      - name: Read the result
        id: result
        if: always()
        env:
          RUN_ID: \${{ steps.relay.outputs.run-id }}
          STARTED: \${{ steps.relay.outputs.started }}
          EXIT_CODE: \${{ steps.relay.outputs.exit-code }}
        run: |
          summary=".relay/runs/$RUN_ID/summary.md"
          pr_url=$(grep -oE 'https://github.com/[^ )]+/pull/[0-9]+' "$summary" 2>/dev/null | head -1 || true)
          cost=$(grep -oE '\\$[0-9]+\\.[0-9]{2}' "$summary" 2>/dev/null | head -1 || true)
          # "ignored" when Relay started nothing: the label, the allowlist or a budget said no.
          status="ignored"
          if [ "$STARTED" = "true" ]; then
            status="succeeded"; [ "$EXIT_CODE" = "0" ] || status="failed"
          fi
          delimiter="relay_$(date +%s)_$RANDOM"
          {
            echo "pr-url=$pr_url"
            echo "cost=$cost"
            echo "status=$status"
            echo "summary<<$delimiter"; head -c 3000 "$summary" 2>/dev/null || echo "(no summary)"; echo; echo "$delimiter"
          } >> "$GITHUB_OUTPUT"`);
  }

  // Relay comments on the issue and takes the trigger label off, whatever
  // delivery is allowed, so `issues: write` is always needed.
  const permissions =
    pipeline === undefined
      ? ['issues: read']
      : input.deliver === 'none' || input.deliver === 'branch'
        ? ['contents: read', 'issues: write']
        : input.deliver === 'push'
          ? ['contents: write', 'issues: write']
          : ['contents: write', 'pull-requests: write', 'issues: write'];

  const how =
    start.by === 'dispatch'
      ? [
          `# ${trigger === undefined || trigger.def.id === 'logic.trigger.manual' ? 'This workflow is started by hand, with an issue number:' : 'Nothing here listens for that event. The Action works on one GitHub issue per run, so it is started with an issue number:'}`,
          '#   Actions → this workflow → Run workflow, or from anything that can call GitHub:',
          `#   gh api repos/${repo}/dispatches -f event_type=${dispatchType} -F 'client_payload[issue]=142'`,
        ]
      : [`# GitHub is the source, so the Action fires on the event itself. Relay then works on the issue only if it carries ${start.label}.`];

  return `# Generated by ${brand.name} from the workflow "${workflow.name}".
#
# Trigger: ${trigger?.def.connector.name ?? 'manual'} → ${trigger?.def.name ?? 'run'}.
${how.join('\n')}
#
# Guardrails (allowlist, budgets, delivery ceiling) are read from .relay/config.json,
# never from this file: a workflow file is editable by anyone who can open a PR.
name: ${yamlString(`${brand.name} · ${workflow.name}`)}

on:
${on.join('\n')}

permissions:
  ${permissions.join('\n  ')}

concurrency:
  group: ${brand.slug}-\${{ github.event.issue.number || inputs.issue || github.event.client_payload.issue || github.run_id }}
  cancel-in-progress: false

jobs:
  ${brand.slug}:
    runs-on: ubuntu-latest
    timeout-minutes: 120${start.jobIf === null ? '' : `\n    if: ${yamlString(start.jobIf)}`}
    steps:
${steps.join('\n\n')}
${stepLines.length > 0 ? '\n' + stepLines.join('\n\n') + '\n' : ''}`;
}

function renderSetup(input: { workflow: Workflow; brand: Brand; secrets: Array<{ name: string; why: string }>; warnings: string[]; start: CompiledStart; auth: { claude: AuthPreference; codex: AuthPreference }; agents: boolean }): string {
  const { workflow, brand, secrets, warnings, auth, start } = input;
  const unique = new Map(secrets.map((secret) => [secret.name, secret]));
  const repo = workflow.repository !== undefined && workflow.repository.trim().length > 0 ? workflow.repository.trim() : 'OWNER/REPO';
  const file = `${slugify(workflow.name)}.yml`;
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
  const startHow =
    start.by === 'label'
      ? `Add the label \`${start.label}\` to an issue. The person who adds it must be on the allowlist in \`.relay/config.json\`.`
      : start.by === 'event'
        ? `The Action fires when ${start.event}. Relay works on that issue only if it also carries \`${start.label}\`, added by someone on the allowlist.`
        : `Label an issue \`${start.label}\` (the person who adds it must be on the allowlist), then start the Action with its number:

\`\`\`bash
gh workflow run ${file} -R ${repo} -f issue=142
\`\`\`

or Actions → ${brand.name} · ${workflow.name} → Run workflow.`;
  return `# ${brand.name} · ${workflow.name}

This bundle runs the workflow on your own GitHub Actions minutes. Nothing is hosted, nothing is billed by ${brand.name}.

## 1. Commit two files

- \`.relay/config.json\` — the agents, review level, guardrails and delivery ceiling.
- \`.github/workflows/${file}\` — the Action that runs the pipeline.

Treat \`.relay/config.json\` like code: it decides who may start a run and what it may spend, so changes to it deserve the same review as a change to CI.

## 2. Bring your own subscriptions

Runs use the same accounts you use on your laptop. Nothing is billed by ${brand.name}, and the orchestrator reads none of the model credentials: each value below is read by the vendor's own CLI inside its own process.

**Claude Code**

${claudeHow}

**Codex**

${codexHow}

All secrets this workflow references:

${[...unique.values()].map((secret) => `- \`${secret.name}\` — ${secret.why}`).join('\n')}

## 3. Start it

${startHow}

## 4. Try it on your own machine first

\`\`\`bash
${CLI_INSTALL_COMMAND}
relay start --dry-run        # walks the pipeline with no agent calls
\`\`\`
${warnings.length > 0 ? `\n## Things the canvas said that the files could not\n\n${warnings.map((warning) => `- ${warning}`).join('\n')}\n` : ''}
## What runs where

| Part | Where |
|---|---|
| Trigger | ${start.by === 'dispatch' ? 'You, with an issue number: Actions → Run workflow, or `repository_dispatch`' : `A GitHub issue event, on an issue labelled \`${start.label}\``} |
| Agents | ${input.agents ? 'The Actions runner. Claude Code’s read-only turns run under bubblewrap when it can start there, and under its deny list when it cannot; Codex runs in its own sandbox' : 'None: this workflow has no agent pipeline'} |
| Delivery | Your repository, as far as the policy in config.json allows |
| Notifications | Direct webhooks (Slack, Discord, HTTP), or an endpoint of yours for other apps |
`;
}
