import type { EngineContext } from '../workflow/context.ts';
import { resolveWebhookFormat, webhookBody } from './format.ts';
import { postWebhook, type Fetch } from './webhook.ts';

export async function notifyRun(
  context: Pick<EngineContext, 'state' | 'observer'>,
  deps: { fetch?: Fetch; sleep?: (ms: number) => Promise<void>; timeoutMs?: number } = {},
): Promise<void> {
  const url = context.state.config.notify?.webhook;
  if (url == null) return;
  const at = new Date().toISOString();
  const format = resolveWebhookFormat(url, context.state.config.notify.webhookFormat);
  try {
    const result = await postWebhook(url, webhookBody(context.state, format), {
      maxRetries: context.state.config.workflow.maxTransientRetries,
      ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
      ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
      ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
    });
    context.state.notification ??= {};
    context.state.notification.webhook = { status: result.ok ? 'done' : 'skipped', detail: `${format}: ${result.detail} after ${result.attempts} attempt(s)`, at };
    if (!result.ok) context.observer.warn(`Webhook notification skipped: ${result.detail}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    context.state.notification ??= {};
    context.state.notification.webhook = { status: 'failed', detail, at };
    context.observer.warn(`Webhook notification failed: ${detail}`);
  }
}
