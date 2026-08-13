import { retryDelayMs, sleep } from '../workflow/retry.ts';

export interface WebhookResult { ok: boolean; detail: string; attempts: number }
export type Fetch = typeof globalThis.fetch;

export async function postWebhook(
  url: string,
  body: object,
  options: { maxRetries: number; fetch?: Fetch; timeoutMs?: number; sleep?: (ms: number) => Promise<void> },
): Promise<WebhookResult> {
  const fetcher = options.fetch ?? globalThis.fetch;
  const pause = options.sleep ?? sleep;
  const total = options.maxRetries + 1;
  for (let attempt = 1; attempt <= total; attempt += 1) {
    try {
      const response = await fetcher(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(options.timeoutMs ?? 10_000) });
      if (response.ok) return { ok: true, detail: `HTTP ${response.status}`, attempts: attempt };
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === total) return { ok: false, detail: `HTTP ${response.status}`, attempts: attempt };
    } catch (error) {
      if (attempt === total) return { ok: false, detail: error instanceof Error ? error.message : String(error), attempts: attempt };
    }
    await pause(retryDelayMs(attempt));
  }
  return { ok: false, detail: 'webhook failed', attempts: total };
}
