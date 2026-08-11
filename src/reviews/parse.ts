import { oneLine } from '../util/text.ts';
import { extractJson } from './protocol.ts';
import {
  CATEGORIES,
  DECISIONS,
  IMPACTS,
  RESPONSE_KINDS,
  SEVERITIES,
  type Category,
  type Decision,
  type FindingResponse,
  type Impact,
  type ResponseKind,
  type Review,
  type ReviewFinding,
  type Severity,
} from './types.ts';

export type ParseResult<T> = { ok: true; value: T; warnings: string[] } | { ok: false; error: string };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return allowed.find((candidate) => candidate.toLowerCase() === normalized);
}

/**
 * Parses a reviewer's structured output.
 *
 * Agent output is untrusted input: unknown severities and categories are
 * coerced to safe defaults rather than rejected, because dropping a whole
 * review over one bad enum would lose real findings. Anything coerced is
 * reported as a warning so the audit trail shows it happened.
 */
export function parseReview(text: string): ParseResult<Review> {
  const raw = extractJson(text, 'REVIEW');
  const record = asRecord(raw);
  if (record === undefined) {
    return { ok: false, error: 'No JSON review object was found in the agent output.' };
  }

  const warnings: string[] = [];

  const decision = oneOf<Decision>(record['decision'], DECISIONS);
  if (decision === undefined) {
    return { ok: false, error: `Review "decision" must be one of ${DECISIONS.join(' | ')}.` };
  }

  const findingsRaw = record['findings'];
  if (findingsRaw !== undefined && !Array.isArray(findingsRaw)) {
    return { ok: false, error: 'Review "findings" must be an array.' };
  }

  const findings: ReviewFinding[] = [];
  const seenIds = new Set<string>();

  for (const [index, item] of (findingsRaw ?? []).entries()) {
    const entry = asRecord(item);
    if (entry === undefined) {
      warnings.push(`Skipped finding #${index + 1}: not an object.`);
      continue;
    }

    const summary = asString(entry['summary']) ?? asString(entry['title']) ?? asString(entry['description']);
    if (summary === undefined) {
      warnings.push(`Skipped finding #${index + 1}: no summary.`);
      continue;
    }

    let id = asString(entry['id']) ?? `F${index + 1}`;
    if (seenIds.has(id)) {
      const unique = `${id}-${index + 1}`;
      warnings.push(`Duplicate finding id "${id}" renamed to "${unique}".`);
      id = unique;
    }
    seenIds.add(id);

    const severity = oneOf<Severity>(entry['severity'], SEVERITIES);
    if (severity === undefined) warnings.push(`Finding ${id}: unknown severity, defaulted to "medium".`);

    const category = oneOf<Category>(entry['category'], CATEGORIES);
    if (category === undefined) warnings.push(`Finding ${id}: unknown category, defaulted to "correctness".`);

    const impact = oneOf<Impact>(entry['impact'], IMPACTS);
    const evidence = asString(entry['evidence']);
    const suggestedFix = asString(entry['suggestedFix']) ?? asString(entry['suggested_fix']);
    const file = asString(entry['file']) ?? asString(entry['path']);
    const lineValue = entry['line'];
    const line =
      typeof lineValue === 'number' && Number.isFinite(lineValue)
        ? Math.trunc(lineValue)
        : typeof lineValue === 'string' && /^\d+$/.test(lineValue.trim())
          ? Number.parseInt(lineValue.trim(), 10)
          : undefined;

    findings.push({
      id,
      severity: severity ?? 'medium',
      category: category ?? 'correctness',
      summary: oneLine(summary, 500),
      ...(evidence === undefined ? {} : { evidence }),
      ...(suggestedFix === undefined ? {} : { suggestedFix }),
      ...(file === undefined ? {} : { file }),
      ...(line === undefined ? {} : { line }),
      ...(impact === undefined ? {} : { impact }),
    });
  }

  // A reviewer that requests changes without naming anything has not produced a
  // reviewable artifact; treat that as a parse failure so the caller can retry.
  if (decision === 'request_changes' && findings.length === 0) {
    return { ok: false, error: 'Review requested changes but listed no findings.' };
  }

  const summary = asString(record['summary']);
  return {
    ok: true,
    warnings,
    value: { decision, findings, ...(summary === undefined ? {} : { summary }) },
  };
}

/** Parses the implementer's/planner's ACCEPT / REJECT / NEEDS_CLARIFICATION responses. */
export function parseFindingResponses(text: string): ParseResult<FindingResponse[]> {
  const raw = extractJson(text, 'RESPONSES');
  const record = asRecord(raw);
  const listRaw = Array.isArray(raw) ? raw : record?.['responses'];

  if (!Array.isArray(listRaw)) {
    return { ok: false, error: 'No JSON responses array was found in the agent output.' };
  }

  const warnings: string[] = [];
  const responses: FindingResponse[] = [];

  for (const [index, item] of listRaw.entries()) {
    const entry = asRecord(item);
    if (entry === undefined) {
      warnings.push(`Skipped response #${index + 1}: not an object.`);
      continue;
    }

    const findingId = asString(entry['findingId']) ?? asString(entry['finding_id']) ?? asString(entry['id']);
    if (findingId === undefined) {
      warnings.push(`Skipped response #${index + 1}: no findingId.`);
      continue;
    }

    const response = oneOf<ResponseKind>(entry['response'], RESPONSE_KINDS) ?? oneOf<ResponseKind>(entry['decision'], RESPONSE_KINDS);
    if (response === undefined) {
      warnings.push(`Skipped response for ${findingId}: unknown response kind.`);
      continue;
    }

    const reasoning = asString(entry['reasoning']) ?? asString(entry['rationale']) ?? '';
    // A rejection is only meaningful with a stated reason; record the gap
    // instead of silently accepting an unargued dismissal.
    if (response === 'REJECT' && reasoning.length === 0) {
      warnings.push(`Finding ${findingId} was rejected without reasoning.`);
    }

    const evidence = asString(entry['evidence']);
    responses.push({
      findingId,
      response,
      reasoning,
      ...(evidence === undefined ? {} : { evidence }),
    });
  }

  if (responses.length === 0) {
    return { ok: false, error: 'No valid finding responses were parsed.' };
  }
  return { ok: true, value: responses, warnings };
}

/** JSON Schema handed to CLIs that can constrain their final message natively. */
export const REVIEW_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['decision', 'findings'],
  properties: {
    decision: { type: 'string', enum: [...DECISIONS] },
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'severity', 'category', 'summary'],
        properties: {
          id: { type: 'string' },
          severity: { type: 'string', enum: [...SEVERITIES] },
          category: { type: 'string', enum: [...CATEGORIES] },
          impact: { type: 'string', enum: [...IMPACTS] },
          summary: { type: 'string' },
          evidence: { type: 'string' },
          suggestedFix: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'integer' },
        },
      },
    },
  },
};
