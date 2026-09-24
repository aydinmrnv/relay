import { discoverRepository } from '../../git/repository.ts';
import { notifyRun } from '../../notify/index.ts';
import { notifyCompletion } from '../../notify/completion.ts';
import { resolveWebhookFormat } from '../../notify/format.ts';
import { loadConfig, type RelayConfig } from '../../storage/config.ts';
import { resolveRun } from '../../storage/runs.ts';
import { RecordingObserver } from '../../workflow/observer.ts';
import { createRunState, type RunState } from '../../workflow/state.ts';
import { EXIT } from '../exit.ts';
import { emitJson } from '../json.ts';
import { command, dim, fail, hint, ok, out, warn } from '../output.ts';

export interface NotifyOptions {
  json?: boolean;
}

type Channel = 'webhook' | 'system' | 'command';

/**
 * `relay notify [run]` — sends exactly what a finished run sends, now.
 *
 * With no run it sends a clearly-labelled test, which is the only way to find
 * out that a webhook URL was mistyped before the first real run lands silently.
 * With a run it re-sends that run's notification, for the channel that was down
 * when it finished. Nothing here is written back to the run.
 */
export async function notifyCommand(ref: string | undefined, options: NotifyOptions = {}): Promise<number> {
  const repo = await discoverRepository(process.cwd());
  const config = await loadConfig(repo.root);

  const configured = configuredChannels(config);
  if (configured.length === 0) {
    if (options.json === true) {
      emitJson('notify', { sent: [], configured: [] });
      return EXIT.preconditions;
    }
    warn('No notification channel is configured, so a finished run tells nobody.');
    hint('Add any of these to .relay/config.json under "notify":');
    command('"webhook": "https://hooks.slack.com/services/…"   # Slack, Discord, Teams or any JSON endpoint');
    command('"system": true                                     # a desktop notification');
    command('"command": ["say", "{{headline}}"]                # any program, no shell');
    return EXIT.preconditions;
  }

  // A real run carries the config it ran with; the channels are today's.
  const state = ref === undefined ? sampleRun(repo, config) : { ...structuredClone(await resolveRun(repo.root, ref)), config };
  state.notification = {};
  const observer = new RecordingObserver();
  await notifyRun({ state, observer });
  await notifyCompletion({ state, observer });

  const results = configured.map((channel) => ({ channel, ...(state.notification?.[channel] ?? { status: 'skipped', detail: 'not attempted' }) }));
  const failed = results.some((result) => result.status !== 'done');

  if (options.json === true) {
    emitJson('notify', { runId: state.runId, test: ref === undefined, sent: results });
    return failed ? EXIT.error : EXIT.success;
  }

  out(dim(ref === undefined ? 'Sending a test notification on every configured channel.' : `Re-sending the notification for ${state.runId}.`));
  for (const result of results) {
    const label = describeChannel(result.channel, config);
    if (result.status === 'done') ok(`${label}  ${dim(result.detail)}`);
    else fail(`${label}  ${dim(`${result.status}: ${result.detail}`)}`);
  }
  if (failed) {
    out();
    hint('A webhook that answered 4xx has the wrong URL or format: set "webhookFormat" to slack, discord, teams or json to override detection.');
  }
  return failed ? EXIT.error : EXIT.success;
}

function configuredChannels(config: RelayConfig): Channel[] {
  const channels: Channel[] = [];
  if (config.notify.webhook != null) channels.push('webhook');
  if (config.notify.system === true) channels.push('system');
  if (Array.isArray(config.notify.command)) channels.push('command');
  return channels;
}

function describeChannel(channel: Channel, config: RelayConfig): string {
  if (channel === 'webhook') {
    const url = config.notify.webhook!;
    return `Webhook (${resolveWebhookFormat(url, config.notify.webhookFormat)}, ${new URL(url).host})`;
  }
  return channel === 'system' ? 'Desktop' : `Command (${config.notify.command![0]})`;
}

/** A finished, successful run that says on its face that it is a test. */
function sampleRun(repo: Awaited<ReturnType<typeof discoverRepository>>, config: RelayConfig): RunState {
  const now = new Date();
  const state = createRunState({
    runId: `test-${now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`,
    shortId: 'test',
    issueRef: 'test',
    repository: { root: repo.root, owner: repo.owner, name: repo.name, defaultBranch: repo.defaultBranch },
    config,
    now,
  });
  state.issue = {
    id: 'local:relay-notification-test',
    number: null,
    title: 'Notification test — no work was done',
    url: repo.owner !== null && repo.name !== null ? `https://github.com/${repo.owner}/${repo.name}` : '',
    state: 'open',
  };
  state.diff = { fileCount: 3, additions: 42, deletions: 7, files: [], patchFile: '', at: now.toISOString() };
  state.phase = 'COMPLETE';
  state.history.push({ phase: 'COMPLETE', at: now.toISOString(), note: 'notification test' });
  state.finishedAt = now.toISOString();
  return state;
}
