import type { AgentSession } from '../agents/types.ts';

/**
 * Why a failed turn is or is not worth attempting again.
 *
 * The distinction is deliberately conservative: a failure is only retried when
 * its message positively looks transient. Anything unrecognized is terminal, so
 * a genuine bug fails the run once instead of three times.
 */
export type FailureKind = 'retryable' | 'terminal';

/**
 * Failures that will still be failures on the next attempt. Checked first, so a
 * message that mentions both (`401 … rate limit`) is not retried.
 */
const TERMINAL_PATTERNS: RegExp[] = [
  /\b(?:401|403)\b/,
  /\bunauthori[sz]ed\b/i,
  /\bforbidden\b/i,
  /\bauthenticat/i,
  /\bnot logged in\b/i,
  /\bplease (?:run )?`?(?:[a-z-]+ )?login\b/i,
  /\binvalid (?:api )?key\b/i,
  /\bapi key\b/i,
  /\bpermission denied\b/i,
  /\bexecutable not found\b/i,
  /\bcommand not found\b/i,
  /\bENOENT\b/,
  /\bcancell?ed\b/i,
  /\baborted\b/i,
];

/** Failures caused by the network or the upstream service, not by the work. */
const RETRYABLE_PATTERNS: RegExp[] = [
  /\brate[ _-]?limit/i,
  /\btoo many requests\b/i,
  /\b429\b/,
  // Prefix match: providers spell it `overloaded_error` as often as prose.
  /\boverloaded/i,
  /\bservice unavailable\b/i,
  /\b(?:internal server error|bad gateway|gateway timeout)\b/i,
  /\b(?:http\s*|status\s*|code\s*)5\d{2}\b/i,
  /\b5\d{2}\s+(?:error|response)\b/i,
  /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|EHOSTUNREACH|ENETUNREACH)\b/,
  /\b(?:connection (?:reset|refused|closed|error)|socket hang ?up|network error|fetch failed)\b/i,
  /\bstream (?:disconnected|error)\b/i,
  /\btemporar(?:y|ily) (?:unavailable|failed)\b/i,
];

/**
 * Classifies a failed agent turn.
 *
 * A timeout counts as transient only when the turn produced nothing: a phase
 * that ran for 45 minutes and then timed out mid-answer would just burn another
 * 45 minutes, while one that never spoke probably never connected.
 */
export function classifyFailure(session: AgentSession): FailureKind {
  if (session.aborted) return 'terminal';

  if (session.timedOut) {
    return session.text.trim().length === 0 && !producedOutput(session) ? 'retryable' : 'terminal';
  }

  const message = session.error ?? '';
  if (TERMINAL_PATTERNS.some((pattern) => pattern.test(message))) return 'terminal';
  if (RETRYABLE_PATTERNS.some((pattern) => pattern.test(message))) return 'retryable';
  return 'terminal';
}

/** True once the CLI said anything beyond its own stderr chatter. */
function producedOutput(session: AgentSession): boolean {
  return session.events.some(
    (event) => event.type === 'message' || event.type === 'thinking' || event.type === 'tool',
  );
}

/**
 * Whether a retry can continue the failed conversation instead of starting a
 * new one. It can only do so once the CLI has reported a live session — a
 * session id Relay generated for a process that died before it started would
 * make the retry fail on a session that does not exist.
 */
export function canResumeAfterFailure(session: AgentSession): boolean {
  if (session.sessionId === undefined) return false;
  return session.events.some((event) => event.type === 'started') || producedOutput(session);
}

const BASE_DELAY_MS = 2_000;
const MAX_DELAY_MS = 60_000;

/**
 * Exponential backoff with jitter. Jitter matters here because both agents can
 * hit the same provider limit in the same second; retrying in lockstep would
 * reproduce the failure exactly.
 */
export function retryDelayMs(attempt: number, random: () => number = Math.random): number {
  const exponential = Math.min(BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1), MAX_DELAY_MS);
  // ±25%, so the delay stays recognizable while the collision is broken up.
  return Math.round(exponential * (0.75 + random() * 0.5));
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    }
    signal?.addEventListener('abort', finish, { once: true });
  });
}
