import type { Receipt, ReceiptSide, ReceiptVerdict, Recording, RecordingFinding, RecordingLine, RecordingPatch, RecordingResponse, RecordingReview, RecordingRun } from './types';

/**
 * Reads a recording from JSON somebody handed over.
 *
 * Strict where the replay depends on it (the version, the stream, the run's
 * identity) and forgiving everywhere else: a field of the wrong type becomes
 * absent rather than an error, so a recording made by a newer CLI with more in
 * it still plays. Everything is bounded, because the file may be anything.
 */

export const LIMITS = {
  /** A recording is a few hundred kilobytes. Past this it is not one. */
  bytes: 8_000_000,
  lines: 4000,
  reviews: 40,
  findings: 200,
  patches: 12,
  patchChars: 400_000,
  receipts: 400,
  text: 200_000,
  short: 2000,
} as const;

export type ParseResult = { ok: true; recording: Recording } | { ok: false; error: string };

export function parseRecordingText(text: string): ParseResult {
  if (text.length > LIMITS.bytes) return { ok: false, error: 'That file is too large to be a recording.' };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: 'That file is not JSON. A recording is what `relay recording` writes.' };
  }
  return parseRecording(value);
}

export function parseRecording(value: unknown): ParseResult {
  if (!isRecord(value)) return { ok: false, error: 'That file is not a recording.' };
  if (value['bundle'] !== 1) {
    return { ok: false, error: typeof value['bundle'] === 'number' ? `This recording is version ${value['bundle']}, which this studio does not read yet.` : 'That file is not a recording: it has no `bundle` version.' };
  }
  const stream = list(value['stream'], LIMITS.lines).map(line).filter((entry): entry is RecordingLine => entry !== null);
  if (stream.length === 0) return { ok: false, error: 'This recording has no run in it: its stream is empty.' };
  const run = runOf(value['run']);
  if (run === null) return { ok: false, error: 'This recording does not say which run it is of.' };

  const artifacts = isRecord(value['artifacts']) ? value['artifacts'] : {};
  const cleaned = isRecord(value['cleaned']) ? value['cleaned'] : {};
  return {
    ok: true,
    recording: {
      bundle: 1,
      exportedAt: date(value['exportedAt']) ?? stream.at(-1)!.at,
      relayVersion: text(value['relayVersion'], 40) ?? 'unknown',
      exitCode: typeof value['exitCode'] === 'number' && Number.isInteger(value['exitCode']) ? value['exitCode'] : 1,
      run,
      stream,
      artifacts: {
        issue: text(artifacts['issue'], LIMITS.text),
        plan: text(artifacts['plan'], LIMITS.text),
        implementationNotes: text(artifacts['implementationNotes'], LIMITS.text),
        reviews: list(artifacts['reviews'], LIMITS.reviews).map(review).filter((entry): entry is RecordingReview => entry !== null),
        patches: list(artifacts['patches'], LIMITS.patches).map(patch).filter((entry): entry is RecordingPatch => entry !== null),
        testLog: text(artifacts['testLog'], LIMITS.text),
      },
      receipts: list(value['receipts'], LIMITS.receipts).map(receipt).filter((entry): entry is Receipt => entry !== null),
      cleaned: { secrets: count(cleaned['secrets']), paths: count(cleaned['paths']), patchesOmitted: cleaned['patchesOmitted'] === true },
    },
  };
}

/**
 * An address on github.com, or `null`. A recording's pull request and issue
 * are the only links the replay makes from what the file says, and a file can
 * say anything: `javascript:`, another site dressed as a pull request.
 */
export function githubUrl(value: unknown, kind: 'pull' | 'issues'): string | null {
  if (typeof value !== 'string') return null;
  const match = new RegExp(`^https://github\\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/${kind}/\\d+$`).exec(value.trim());
  return match === null ? null : match[0];
}

/* ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function list(value: unknown, max: number): unknown[] {
  return Array.isArray(value) ? value.slice(0, max) : [];
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  return value.length > max ? `${value.slice(0, max)}\n… cut` : value;
}

function date(value: unknown): string | null {
  return typeof value === 'string' && value.length <= 40 && !Number.isNaN(Date.parse(value)) ? value : null;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function line(value: unknown): RecordingLine | null {
  if (!isRecord(value)) return null;
  const type = text(value['type'], 40);
  const at = date(value['at']);
  if (type === null || at === null) return null;
  return { ...value, type, at };
}

function runOf(value: unknown): RecordingRun | null {
  if (!isRecord(value)) return null;
  const runId = text(value['runId'], 80);
  const createdAt = date(value['createdAt']);
  if (runId === null || createdAt === null) return null;
  const issue = isRecord(value['issue']) ? value['issue'] : null;
  const repository = isRecord(value['repository']) ? value['repository'] : {};
  const pullRequest = isRecord(value['pullRequest']) ? value['pullRequest'] : null;
  const usage = isRecord(value['usage']) && isRecord(value['usage']['total']) ? value['usage']['total'] : {};
  const error = isRecord(value['error']) ? text(value['error']['message'], LIMITS.short) : null;
  const stopped = isRecord(value['stopped']) ? text(value['stopped']['detail'], LIMITS.short) : null;
  const agents: Record<string, string> = {};
  if (isRecord(value['agents'])) {
    for (const [role, provider] of Object.entries(value['agents']).slice(0, 12)) {
      const name = text(provider, 40);
      if (name !== null) agents[role.slice(0, 40)] = name;
    }
  }
  const pullUrl = pullRequest === null ? null : githubUrl(pullRequest['url'], 'pull');
  return {
    runId,
    shortId: text(value['shortId'], 20) ?? runId.slice(-6),
    phase: text(value['phase'], 40) ?? 'FAILED',
    phaseLabel: text(value['phaseLabel'], 40) ?? 'Finished',
    createdAt,
    finishedAt: date(value['finishedAt']),
    durationMs: numberOrNull(value['durationMs']),
    issueRef: text(value['issueRef'], 200) ?? '',
    issue: issue === null ? null : { number: numberOrNull(issue['number']), title: text(issue['title'], 300) ?? '', url: githubUrl(issue['url'], 'issues') ?? '' },
    repository: { owner: text(repository['owner'], 100), name: text(repository['name'], 100) },
    branch: text(value['branch'], 200),
    agents,
    reviewLevel: text(value['reviewLevel'], 40),
    pullRequest: pullUrl === null ? null : { url: pullUrl, number: numberOrNull(pullRequest?.['number']) },
    costUsd: numberOrNull(usage['costUsd']),
    turns: numberOrNull(usage['turns']),
    pricedTurns: numberOrNull(usage['pricedTurns']),
    error,
    stopped,
  };
}

function finding(value: unknown): RecordingFinding | null {
  if (!isRecord(value)) return null;
  const id = text(value['id'], 40);
  const summary = text(value['summary'], LIMITS.short);
  if (id === null || summary === null) return null;
  const optional = (key: string, max: number = LIMITS.short): string | undefined => text(value[key], max) ?? undefined;
  return {
    id,
    summary,
    severity: text(value['severity'], 20) ?? 'medium',
    category: text(value['category'], 40) ?? 'correctness',
    ...(optional('evidence', 8000) === undefined ? {} : { evidence: optional('evidence', 8000)! }),
    ...(optional('suggestedFix', 8000) === undefined ? {} : { suggestedFix: optional('suggestedFix', 8000)! }),
    ...(optional('file', 400) === undefined ? {} : { file: optional('file', 400)! }),
    ...(typeof value['line'] === 'number' ? { line: value['line'] } : {}),
    ...(optional('impact', 20) === undefined ? {} : { impact: optional('impact', 20)! }),
  };
}

function response(value: unknown): RecordingResponse | null {
  if (!isRecord(value)) return null;
  const findingId = text(value['findingId'], 40);
  const answer = text(value['response'], 40);
  if (findingId === null || answer === null) return null;
  return { findingId, response: answer, reasoning: text(value['reasoning'], 8000) ?? '' };
}

function review(value: unknown): RecordingReview | null {
  if (!isRecord(value)) return null;
  const at = date(value['at']);
  if (at === null || (value['kind'] !== 'plan' && value['kind'] !== 'code')) return null;
  const summary = text(value['summary'], 8000);
  return {
    kind: value['kind'],
    round: typeof value['round'] === 'number' ? value['round'] : 1,
    reviewer: text(value['reviewer'], 40) ?? 'the reviewer',
    decision: value['decision'] === 'approve' ? 'approve' : 'request_changes',
    ...(summary === null ? {} : { summary }),
    findings: list(value['findings'], LIMITS.findings).map(finding).filter((entry): entry is RecordingFinding => entry !== null),
    responses: list(value['responses'], LIMITS.findings).map(response).filter((entry): entry is RecordingResponse => entry !== null),
    at,
  };
}

function patch(value: unknown): RecordingPatch | null {
  if (!isRecord(value)) return null;
  const label = text(value['label'], 80);
  if (label === null || typeof value['patch'] !== 'string') return null;
  const cut = value['patch'].length > LIMITS.patchChars;
  return { label, patch: cut ? value['patch'].slice(0, LIMITS.patchChars) : value['patch'], truncated: cut || value['truncated'] === true };
}

const VERDICTS: readonly ReceiptVerdict[] = ['match', 'mismatch', 'measured', 'unverified'];

function side(value: unknown): ReceiptSide | null {
  if (!isRecord(value)) return null;
  const said = text(value['text'], LIMITS.short * 2);
  if (said === null) return null;
  return { by: text(value['by'], 60) ?? 'unknown', text: said, source: text(value['source'], 300) ?? '' };
}

function receipt(value: unknown): Receipt | null {
  if (!isRecord(value)) return null;
  const id = text(value['id'], 120);
  const subject = text(value['subject'], 400);
  const at = date(value['at']);
  const verdict = VERDICTS.find((candidate) => candidate === value['verdict']);
  if (id === null || subject === null || at === null || verdict === undefined) return null;
  const note = text(value['note'], LIMITS.short);
  return { id, subject, phase: text(value['phase'], 40) ?? '', at, claim: side(value['claim']), measured: side(value['measured']), verdict, ...(note === null ? {} : { note }) };
}
