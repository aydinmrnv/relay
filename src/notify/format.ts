import type { WebhookFormat } from '../storage/config.ts';
import { issueHeadline } from '../issues/identity.ts';
import type { RunState } from '../workflow/state.ts';
import { phaseTimings } from '../workflow/timeline.ts';
import { formatUsage } from '../workflow/usage.ts';
import { buildWebhookPayload } from './payload.ts';

/**
 * What a finished run looks like to a person: one line that says how it went,
 * and a handful of facts. Every chat format below is rendered from this, so
 * Slack, Discord, Teams and the desktop banner never disagree about a run.
 *
 * It is as narrow as the JSON payload on purpose — no file names, no paths, no
 * agent output — because a channel is a wider audience than a terminal.
 */
export interface RunDigest {
  outcome: 'succeeded' | 'failed' | 'cancelled' | 'stopped';
  /** `ENG-142 Fix the retry`, `#35 Notify`, or the task's own title. */
  subject: string;
  /** `Relay run succeeded: #35 Notify`. */
  headline: string;
  /** The link a reader wants first: the pull request, else the issue. */
  url: string | null;
  facts: Array<{ label: string; value: string }>;
  runId: string;
}

export function digestRun(state: RunState): RunDigest {
  const outcome: RunDigest['outcome'] =
    state.phase === 'COMPLETE'
      ? state.stopped === undefined ? 'succeeded' : 'stopped'
      : state.phase === 'CANCELLED' ? 'cancelled' : state.phase === 'FAILED' ? 'failed' : 'stopped';
  const subject = state.issue !== undefined ? issueHeadline(state.issue) : state.task?.title ?? state.issueRef;

  const facts: RunDigest['facts'] = [];
  if (state.pullRequest?.url !== undefined) facts.push({ label: 'Pull request', value: state.pullRequest.url });
  if (state.issue?.url) facts.push({ label: 'Issue', value: state.issue.url });
  if (state.diff !== undefined) {
    facts.push({ label: 'Changes', value: `${state.diff.fileCount} file(s), +${state.diff.additions} −${state.diff.deletions}` });
  }
  if (state.tests !== undefined) {
    facts.push({
      label: 'Tests',
      value: state.tests.skippedReason ?? (state.tests.passed ? 'passed' : `failed (exit ${state.tests.exitCode ?? 'unknown'})`),
    });
  }
  if (state.delivery !== undefined) facts.push({ label: 'Delivered', value: `${state.delivery.reached} (asked for ${state.delivery.policy})` });
  const total = phaseTimings(state).reduce((sum, phase) => sum + phase.ms, 0);
  if (total > 0) facts.push({ label: 'Took', value: formatDuration(total) });
  if (state.usage !== undefined) facts.push({ label: 'Cost', value: formatUsage(state.usage.total) });
  if (state.error !== undefined) facts.push({ label: 'Error', value: `${truncate(state.error.message, 300)} (in ${state.error.phase.toLowerCase()})` });
  else if (state.stopped !== undefined) facts.push({ label: 'Stopped', value: truncate(state.stopped.detail, 300) });

  return {
    outcome,
    subject,
    headline: `Relay run ${outcome}: ${subject}`,
    url: state.pullRequest?.url ?? (state.issue?.url || null),
    facts,
    runId: state.runId,
  };
}

/**
 * Which body a webhook URL wants. Slack, Discord and Teams each reject — or
 * silently drop — a JSON document that is not their own message shape, which
 * is what made pasting a Slack webhook into `notify.webhook` look configured
 * while delivering nothing.
 */
export function detectWebhookFormat(url: string): Exclude<WebhookFormat, 'auto'> {
  let host: string;
  let path: string;
  try {
    const parsed = new URL(url);
    host = parsed.hostname.toLowerCase();
    path = parsed.pathname;
  } catch {
    return 'json';
  }
  if (host === 'hooks.slack.com') return 'slack';
  if (/(^|\.)discord(app)?\.com$/.test(host) && path.startsWith('/api/webhooks/')) return 'discord';
  if (host.endsWith('.webhook.office.com') || host.endsWith('.logic.azure.com') || host.endsWith('.powerplatform.com')) return 'teams';
  return 'json';
}

export function resolveWebhookFormat(url: string, configured: WebhookFormat | undefined): Exclude<WebhookFormat, 'auto'> {
  return configured === undefined || configured === 'auto' ? detectWebhookFormat(url) : configured;
}

const COLORS = { succeeded: 0x2da44e, failed: 0xcf222e, cancelled: 0x6e7781, stopped: 0xbf8700 } as const;
const MARKS = { succeeded: '✅', failed: '❌', cancelled: '⏹️', stopped: '⚠️' } as const;

/** The request body for a webhook in the given format. */
export function webhookBody(state: RunState, format: Exclude<WebhookFormat, 'auto'>): object {
  if (format === 'json') return buildWebhookPayload(state);
  const digest = digestRun(state);
  switch (format) {
    case 'slack':
      return slackMessage(digest);
    case 'discord':
      return discordMessage(digest);
    case 'teams':
      return teamsMessage(digest);
  }
}

function slackMessage(digest: RunDigest): object {
  const title = digest.url === null ? escapeSlack(digest.subject) : `<${digest.url}|${escapeSlack(digest.subject)}>`;
  return {
    // `text` is what notifications and screen readers use; blocks are what the channel shows.
    text: `${MARKS[digest.outcome]} ${digest.headline}`,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `${MARKS[digest.outcome]} *Relay run ${digest.outcome}*\n${title}` } },
      ...(digest.facts.length === 0
        ? []
        : [{
            type: 'section',
            fields: digest.facts.slice(0, 10).map((fact) => ({
              type: 'mrkdwn',
              text: `*${fact.label}*\n${/^https?:\/\//.test(fact.value) ? `<${fact.value}>` : escapeSlack(fact.value)}`,
            })),
          }]),
      { type: 'context', elements: [{ type: 'mrkdwn', text: `run \`${digest.runId}\`` }] },
    ],
  };
}

function discordMessage(digest: RunDigest): object {
  return {
    username: 'Relay',
    // Links and mentions in a run title must never ping a channel.
    allowed_mentions: { parse: [] },
    embeds: [{
      title: truncate(`${MARKS[digest.outcome]} ${digest.headline}`, 256),
      ...(digest.url === null ? {} : { url: digest.url }),
      color: COLORS[digest.outcome],
      fields: digest.facts.slice(0, 25).map((fact) => ({ name: fact.label, value: truncate(fact.value, 1024), inline: fact.value.length <= 40 })),
      footer: { text: `run ${digest.runId}` },
    }],
  };
}

function teamsMessage(digest: RunDigest): object {
  return {
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      content: {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        type: 'AdaptiveCard',
        version: '1.4',
        body: [
          { type: 'TextBlock', size: 'Medium', weight: 'Bolder', wrap: true, text: `${MARKS[digest.outcome]} ${digest.headline}` },
          { type: 'FactSet', facts: digest.facts.map((fact) => ({ title: fact.label, value: fact.value })) },
          { type: 'TextBlock', isSubtle: true, size: 'Small', text: `run ${digest.runId}` },
        ],
        ...(digest.url === null ? {} : { actions: [{ type: 'Action.OpenUrl', title: 'Open', url: digest.url }] }),
      },
    }],
  };
}

/** One line for a desktop banner, which truncates anything longer anyway. */
export function desktopBody(state: RunState): string {
  const digest = digestRun(state);
  const link = state.pullRequest?.url === undefined ? '' : ` — PR ${state.pullRequest.url.replace(/^https?:\/\/(www\.)?github\.com\//, '')}`;
  return truncate(`${digest.outcome[0]!.toUpperCase()}${digest.outcome.slice(1)}: ${digest.subject}${link}`, 200);
}

function escapeSlack(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
