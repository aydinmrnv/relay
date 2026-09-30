/**
 * Asking an app whether a credential works, without doing anything visible:
 * a Slack webhook sent an empty message answers `no_text` while it is alive
 * and `no_service` once it is removed; a Discord webhook describes itself to
 * a GET. Sending a test message is separate, and only on request.
 *
 * Every URL is matched against its pattern again here, so this module only
 * ever talks to Slack's and Discord's webhook hosts, and never follows a
 * redirect elsewhere.
 */
import type { CredentialKind } from '@/lib/workflow/schema';
import { credentialSpecByKind } from '@/lib/connectors/credentials';

export type CheckResult =
  | { ok: true; /** A name the app gave, when it gives one. */ account?: string }
  /** `refused`: the app answered, and the credential does not work. `unreachable`: no usable answer; try again later. */
  | { ok: false; reason: 'refused' | 'unreachable'; message: string };

type Fetch = typeof fetch;

const TIMEOUT_MS = 8_000;

export async function checkCredential(kind: CredentialKind, secret: string, fetcher: Fetch = fetch): Promise<CheckResult> {
  const invalid = mismatch(kind, secret);
  if (invalid !== null) return invalid;
  switch (kind) {
    case 'slack-webhook':
      return slack(await call(fetcher, secret, { method: 'POST', body: '{}' }), 'check');
    case 'discord-webhook':
      return discordCheck(await call(fetcher, secret, { method: 'GET' }));
  }
}

export async function sendTestMessage(kind: CredentialKind, secret: string, text: string, fetcher: Fetch = fetch): Promise<CheckResult> {
  const invalid = mismatch(kind, secret);
  if (invalid !== null) return invalid;
  switch (kind) {
    case 'slack-webhook':
      return slack(await call(fetcher, secret, { method: 'POST', body: JSON.stringify({ text }) }), 'send');
    case 'discord-webhook':
      return discordSend(await call(fetcher, secret, { method: 'POST', body: JSON.stringify({ content: text, allowed_mentions: { parse: [] } }) }));
  }
}

function mismatch(kind: CredentialKind, secret: string): CheckResult | null {
  const spec = credentialSpecByKind(kind);
  if (spec === undefined || !spec.input.pattern.test(secret)) return { ok: false, reason: 'refused', message: spec?.input.mismatch ?? 'That is not a credential this server knows how to check.' };
  return null;
}

interface Answer {
  status: number;
  body: string;
}

async function call(fetcher: Fetch, url: string, init: { method: 'GET' | 'POST'; body?: string }): Promise<Answer | null> {
  try {
    const response = await fetcher(url, {
      method: init.method,
      headers: init.body === undefined ? {} : { 'content-type': 'application/json' },
      body: init.body,
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return { status: response.status, body: (await response.text()).slice(0, 2_000) };
  } catch {
    return null;
  }
}

const SLACK_REFUSALS: Record<string, string> = {
  no_service: 'Slack says this webhook was removed or switched off. Make a new one and paste it here.',
  no_active_hooks: 'Slack says incoming webhooks are switched off for this app. Switch them back on, or make a new one.',
  invalid_token: 'Slack refused the webhook’s token: it was revoked, or the URL is missing a part.',
  no_team: 'Slack does not know the workspace in this URL. Check it was copied whole.',
  no_service_id: 'Slack does not know the app in this URL. Check it was copied whole.',
  channel_not_found: 'The channel this webhook posts to no longer exists.',
  channel_is_archived: 'The channel this webhook posts to is archived. Unarchive it, or make a webhook for another channel.',
  action_prohibited: 'A Slack admin has restricted posting through webhooks in this workspace.',
  posting_to_general_channel_denied: 'This workspace does not let webhooks post to #general. Make one for another channel.',
};

function slack(answer: Answer | null, mode: 'check' | 'send'): CheckResult {
  if (answer === null) return { ok: false, reason: 'unreachable', message: 'Could not reach Slack. Try again in a minute.' };
  const code = answer.body.trim();
  // An empty message is refused for being empty, which only a live webhook gets far enough to say.
  if (mode === 'check' && answer.status === 400 && (code === 'no_text' || code === 'invalid_payload' || code === 'missing_text_or_fallback_or_attachments')) return { ok: true };
  if (answer.status === 200) return { ok: true };
  if (answer.status === 429 || answer.status >= 500) return { ok: false, reason: 'unreachable', message: `Slack is not answering properly right now (HTTP ${answer.status}). Try again in a minute.` };
  return { ok: false, reason: 'refused', message: SLACK_REFUSALS[code] ?? `Slack refused the webhook (HTTP ${answer.status}${code.length > 0 && code.length < 60 ? `, ${code}` : ''}).` };
}

function discordRefusal(answer: Answer | null): CheckResult | null {
  if (answer === null) return { ok: false, reason: 'unreachable', message: 'Could not reach Discord. Try again in a minute.' };
  if (answer.status === 401 || answer.status === 403 || answer.status === 404) return { ok: false, reason: 'refused', message: 'Discord does not know this webhook: it was deleted, or the URL is missing a part.' };
  if (answer.status === 429 || answer.status >= 500) return { ok: false, reason: 'unreachable', message: `Discord is not answering properly right now (HTTP ${answer.status}). Try again in a minute.` };
  return null;
}

function discordCheck(answer: Answer | null): CheckResult {
  const refusal = discordRefusal(answer);
  if (refusal !== null) return refusal;
  if (answer!.status !== 200) return { ok: false, reason: 'refused', message: `Discord refused the webhook (HTTP ${answer!.status}).` };
  try {
    const hook = JSON.parse(answer!.body) as { name?: unknown };
    return typeof hook.name === 'string' && hook.name.trim().length > 0 ? { ok: true, account: hook.name.trim().slice(0, 80) } : { ok: true };
  } catch {
    return { ok: true };
  }
}

function discordSend(answer: Answer | null): CheckResult {
  const refusal = discordRefusal(answer);
  if (refusal !== null) return refusal;
  return answer!.status === 200 || answer!.status === 204 ? { ok: true } : { ok: false, reason: 'refused', message: `Discord refused the message (HTTP ${answer!.status}).` };
}
