/**
 * Which nodes Relay performs for real, and what each one needs.
 *
 * One table, read by the engine (`relay workflow check` prints it, and a real
 * run skips what is not on it, out loud) and by the studio (which badges a
 * node "test runs only" exactly when this says so). The studio keeps a
 * byte-for-byte copy at `web/src/lib/workflow/engine/support.ts`; a test in
 * each package fails when the two differ, because a canvas that calls a step
 * real when the engine would skip it is the one lie this product cannot tell.
 *
 * "Real" means the engine does the thing: posts the message, moves the
 * ticket, waits for the person. It does not mean the app is signed in to: a
 * step that needs a credential names the environment variable it reads, and
 * without it the step fails, said, rather than being skipped in silence.
 */

export interface NodeSupport {
  /** Whether `relay workflow` performs this step itself. */
  real: boolean;
  /**
   * Whether a step Relay cannot perform is handed to the person's own bridge
   * instead: one URL of theirs that accepts JSON (n8n, a Zapier catch hook, a
   * server). True for an app's actions, never for a trigger or for logic.
   */
  bridge: boolean;
  /** Environment variables the step reads. Empty when it needs none. */
  needs: readonly string[];
  /** One sentence: how it is done, or why it is not. */
  note: string;
}

/** Where a step Relay has no connection for is sent, when the person has somewhere to send it. */
export const BRIDGE_VARIABLE = 'BRIDGE_WEBHOOK_URL';

const real = (note: string, ...needs: string[]): NodeSupport => ({ real: true, bridge: false, needs, note });
const unwired = (note: string): NodeSupport => ({ real: false, bridge: false, needs: [], note });
/** An app action Relay has no connection for: the bridge performs it, or nothing does. */
const bridged = (note: string): NodeSupport => ({
  real: false,
  bridge: true,
  needs: [BRIDGE_VARIABLE],
  note: `${note} A real run hands this step to ${BRIDGE_VARIABLE}, an endpoint of yours that accepts JSON; without one it is skipped, and the run says so.`,
});

const SLACK = 'SLACK_WEBHOOK_URL';
const DISCORD = 'DISCORD_WEBHOOK_URL';
const LINEAR = 'LINEAR_API_KEY';

const SLACK_NOTE = 'Posted through a Slack incoming webhook, to the channel that webhook was made for.';
const DISCORD_NOTE = 'Posted through a Discord channel webhook.';
const GH_NOTE = 'Done with the `gh` CLI, as whoever is signed in to it on the runner.';
const LINEAR_NOTE = 'Done through Linear’s API with a personal API key.';

const ACTIONS: Readonly<Record<string, NodeSupport>> = {
  'pipeline.action.run': real('Claude Code and Codex plan, cross-review, implement and test in an isolated worktree.'),
  'pipeline.action.fast': real('One agent plans and implements in a single session; the test suite checks the work.'),
  'pipeline.action.estimate': real('Priced from what earlier runs in this repository cost. With no earlier runs there is no estimate, and the step says so.'),

  'gates.action.budget': real('The daily total is summed from this machine’s run records; the per-run cap stops the run at a phase boundary.'),
  'gates.action.allowlist': real('Checks who the event says started it. A person starting the workflow by hand passes: they are at the controls.'),
  'gates.action.injection-screen': real('The engine’s own patterns, over the title and description the agents are about to read.'),
  'gates.action.approval': real('Waits for a person: `relay workflow approve`, the studio, or the terminal the workflow runs in. Nothing proceeds until then, and it gives up after the timeout.'),
  'gates.action.concurrency': real('Counts the runs in flight in this repository before starting another.'),
  'gates.action.kill-switch': real('Read from the workflow, and from `.relay/STOP` in the repository, before every start.'),

  'delivery.action.deliver': real('Commit, secret scan, push and pull request, as far as the policy allows. A run nobody started by hand never merges.'),
  'delivery.action.comment-summary': real('Posted on the issue by the run itself, once.'),

  'schedule.action.delay': real('A real wait, in the process running the workflow.'),
  'schedule.action.business-hours': real('Held until the window opens in the time zone given.'),

  'http.action.request': real('A real request. Headers come from HTTP_HEADERS, a JSON object, so no credential is written into the workflow.'),
  'http.action.post-run-json': real('Posts the run document to the URL.'),

  'logic.action.condition': real('Evaluated against the event and the run.'),
  'logic.action.filter': real('The expression is evaluated; a false or unreadable one stops that path.'),
  'logic.action.merge-paths': real('Waits for every path that is still coming.'),
  'logic.action.note': real('A note. Nothing to run.'),
  'logic.action.ai-step': real('One read-only turn of a coding CLI signed in on the runner: Claude Code for a Claude model, Codex for GPT. Relay calls no model API of its own.'),
  'logic.action.transform': unwired('Running JavaScript from a canvas needs a sandbox Relay does not have yet. The payload passes through unchanged.'),

  'slack.action.post-message': real(SLACK_NOTE, SLACK),
  'slack.action.share-pr': real(SLACK_NOTE, SLACK),
  'slack.action.post-run-summary': real(SLACK_NOTE, SLACK),
  'slack.action.reply-in-thread': real(`${SLACK_NOTE} A webhook cannot reply in a thread, so the reply is a new message there.`, SLACK),
  'slack.action.add-reaction': bridged('Adding a reaction needs a Slack app with a bot token, which Relay does not hold.'),
  'slack.action.send-dm': bridged('A direct message needs a Slack app with a bot token, which Relay does not hold.'),

  'discord.action.send-message': real(DISCORD_NOTE, DISCORD),
  'discord.action.share-pr': real(DISCORD_NOTE, DISCORD),
  'discord.action.reply-to-thread': real(`${DISCORD_NOTE} A webhook posts to its own channel, not into a thread.`, DISCORD),

  'github-issues.action.comment': real(GH_NOTE),
  'github-issues.action.add-label': real(GH_NOTE),
  'github-issues.action.remove-label': real(GH_NOTE),
  'github-issues.action.assign': real(GH_NOTE),
  'github-issues.action.close-issue': real(GH_NOTE),
  'github-issues.action.create-issue': real(GH_NOTE),
  'github.action.comment': real(`${GH_NOTE} On the pull request the run opened.`),
  'github.action.add-label': real(`${GH_NOTE} On the pull request the run opened.`),
  'github.action.request-review': real(`${GH_NOTE} On the pull request the run opened.`),

  'linear.action.comment': real(LINEAR_NOTE, LINEAR),
  'linear.action.update-state': real(LINEAR_NOTE, LINEAR),
  'linear.action.attach-pr': real(LINEAR_NOTE, LINEAR),
  'linear.action.add-label': real(`${LINEAR_NOTE} The label has to exist already.`, LINEAR),
  'linear.action.create-issue': real(LINEAR_NOTE, LINEAR),
};

const WEBHOOK_SECRET = 'RELAY_WEBHOOK_SECRET';
const APP_HOOK = 'on a machine of yours that the app can reach, and takes only deliveries signed with the secret you gave the app.';
const GITHUB_HOOK = `\`relay workflow serve\` reads GitHub’s own webhook ${APP_HOOK}`;
const LINEAR_HOOK = `\`relay workflow serve\` reads Linear’s own webhook ${APP_HOOK}`;
const SENTRY_HOOK = `\`relay workflow serve\` reads Sentry’s own webhook ${APP_HOOK}`;

const TRIGGERS: Readonly<Record<string, NodeSupport>> = {
  'logic.trigger.manual': real('Started by a person: `relay workflow run`, or Run on your computer in the studio.'),
  'http.trigger.webhook': real('`relay workflow serve` listens for it. With RELAY_WEBHOOK_SECRET set, deliveries must be signed with it. Without it, only a script on the same machine can deliver, and an allowlist that names people refuses what it sends.', 'RELAY_WEBHOOK_SECRET'),
  'schedule.trigger.cron': real('`relay workflow serve` keeps the clock, in the time zone given.'),
  'schedule.trigger.interval': real('`relay workflow serve` keeps the clock.'),
  'github-issues.trigger.issue-labelled': real('`relay workflow serve` watches for the label with `gh`; the exported Action fires on the event itself.'),

  'github-issues.trigger.issue-opened': real(GITHUB_HOOK, WEBHOOK_SECRET),
  'github-issues.trigger.issue-assigned': real(GITHUB_HOOK, WEBHOOK_SECRET),
  'github-issues.trigger.issue-comment': real(GITHUB_HOOK, WEBHOOK_SECRET),
  'github-actions.trigger.workflow-failed': real(`${GITHUB_HOOK} The failing run’s id is handed to the agents, who read its log with \`gh\`.`, WEBHOOK_SECRET),
  'codeql.trigger.alert-created': real(GITHUB_HOOK, WEBHOOK_SECRET),
  'dependabot.trigger.alert-created': real(GITHUB_HOOK, WEBHOOK_SECRET),

  'linear.trigger.issue-assigned': real(LINEAR_HOOK, WEBHOOK_SECRET),
  'linear.trigger.issue-created': real(LINEAR_HOOK, WEBHOOK_SECRET),
  'linear.trigger.issue-labelled': real(LINEAR_HOOK, WEBHOOK_SECRET),
  'linear.trigger.issue-state-changed': real(LINEAR_HOOK, WEBHOOK_SECRET),

  'sentry.trigger.issue-created': real(`${SENTRY_HOOK} A threshold such as “more than five users” belongs in a Sentry alert rule, whose deliveries start this too.`, WEBHOOK_SECRET),
  'sentry.trigger.issue-regressed': real(SENTRY_HOOK, WEBHOOK_SECRET),
  'sentry.trigger.issue-assigned': real(SENTRY_HOOK, WEBHOOK_SECRET),
};

/** What an app's own events need before they can start a workflow by themselves. */
const TRIGGER_UNWIRED = 'Nothing listens for this app’s events yet. Point the app’s webhook at this workflow’s Incoming webhook, or start the workflow by hand.';

function appOf(type: string): string {
  return type.split('.')[0] ?? type;
}

/** What Relay does with a node of this type in a real run. */
export function nodeSupport(type: string): NodeSupport {
  const kind = type.split('.')[1];
  if (kind === 'trigger') return TRIGGERS[type] ?? unwired(TRIGGER_UNWIRED);
  return ACTIONS[type] ?? bridged(`Relay has no connection to ${appOf(type)} yet.`);
}

/** Whether a real run performs this node itself. */
export function runsForReal(type: string): boolean {
  return nodeSupport(type).real;
}

/**
 * Whether nothing but a test run plays this node: Relay does not perform it,
 * and there is no bridge to hand it to. What the studio badges "test runs only".
 */
export function testRunsOnly(type: string): boolean {
  // A trigger nothing listens for is not this: the workflow still runs for real, started by hand.
  if (type.split('.')[1] !== 'action') return false;
  const support = nodeSupport(type);
  return !support.real && !support.bridge;
}

/** Every node type the table names as real, for the tests that hold the catalog to it. */
export const REAL_NODE_TYPES: readonly string[] = [...Object.entries(ACTIONS), ...Object.entries(TRIGGERS)].filter(([, support]) => support.real).map(([type]) => type);
