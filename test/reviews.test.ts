import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { extractSection, extractJson, beginMarker, endMarker } from '../src/reviews/protocol.ts';
import {
  parseReview,
  parseFindingResponses,
  REVIEW_JSON_SCHEMA,
  findStrictSchemaViolations,
} from '../src/reviews/parse.ts';
import { formatFindingLine } from '../src/reviews/types.ts';
import { isActionableAt, isBlockingAt, REVIEW_PROFILES } from '../src/reviews/level.ts';

describe('artifact protocol', () => {
  it('extracts a delimited section', () => {
    const text = ['chatter before', beginMarker('PLAN'), '## Summary', 'do the thing', endMarker('PLAN'), 'chatter after'].join('\n');
    assert.equal(extractSection(text, 'PLAN'), '## Summary\ndo the thing');
  });

  it('recovers a section whose closing marker was truncated', () => {
    const text = [beginMarker('PLAN'), 'partial plan'].join('\n');
    assert.equal(extractSection(text, 'PLAN'), 'partial plan');
  });

  it('returns undefined when the section is absent', () => {
    assert.equal(extractSection('no markers here', 'PLAN'), undefined);
  });

  it('finds JSON inside a section, a fenced block, or bare prose', () => {
    assert.deepEqual(extractJson(`${beginMarker('REVIEW')}\n{"a":1}\n${endMarker('REVIEW')}`, 'REVIEW'), { a: 1 });
    assert.deepEqual(extractJson('here you go:\n```json\n{"a":2}\n```', 'REVIEW'), { a: 2 });
    assert.deepEqual(extractJson('preamble {"a":3} trailing words', 'REVIEW'), { a: 3 });
  });

  it('does not mistake braces inside strings for structure', () => {
    const parsed = extractJson('{"summary":"uses a } brace","n":1}');
    assert.deepEqual(parsed, { summary: 'uses a } brace', n: 1 });
  });
});

describe('review parsing', () => {
  it('parses a well-formed review', () => {
    const result = parseReview(
      `${beginMarker('REVIEW')}${JSON.stringify({
        decision: 'request_changes',
        summary: 'Missing tests.',
        findings: [
          { id: 'F1', severity: 'high', category: 'testing', summary: 'No test for the rate limiter', file: 'src/a.ts', line: 12 },
        ],
      })}${endMarker('REVIEW')}`,
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.decision, 'request_changes');
    assert.equal(result.value.findings.length, 1);
    assert.equal(result.value.findings[0]?.line, 12);
  });

  it('rejects a request_changes review with no findings', () => {
    const result = parseReview(JSON.stringify({ decision: 'request_changes', findings: [] }));
    assert.equal(result.ok, false);
  });

  it('accepts an approval with no findings', () => {
    const result = parseReview(JSON.stringify({ decision: 'approve', findings: [] }));
    assert.equal(result.ok, true);
  });

  it('rejects output containing no JSON at all', () => {
    const result = parseReview('I think the plan is fine, honestly.');
    assert.equal(result.ok, false);
  });

  it('rejects an unknown decision rather than guessing', () => {
    const result = parseReview(JSON.stringify({ decision: 'maybe', findings: [] }));
    assert.equal(result.ok, false);
  });

  it('coerces unknown severities and categories, and reports the coercion', () => {
    const result = parseReview(
      JSON.stringify({
        decision: 'request_changes',
        findings: [{ id: 'F1', severity: 'catastrophic', category: 'vibes', summary: 'something' }],
      }),
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.findings[0]?.severity, 'medium');
    assert.equal(result.value.findings[0]?.category, 'correctness');
    assert.equal(result.warnings.length, 2);
  });

  it('deduplicates finding ids so responses map unambiguously', () => {
    const result = parseReview(
      JSON.stringify({
        decision: 'request_changes',
        findings: [
          { id: 'F1', severity: 'high', category: 'correctness', summary: 'first' },
          { id: 'F1', severity: 'low', category: 'correctness', summary: 'second' },
        ],
      }),
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;
    const ids = result.value.findings.map((finding) => finding.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it('skips malformed findings but keeps the valid ones', () => {
    const result = parseReview(
      JSON.stringify({
        decision: 'request_changes',
        findings: [{ id: 'F1', severity: 'high', category: 'correctness', summary: 'real' }, 'nonsense', { id: 'F3' }],
      }),
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.findings.length, 1);
    assert.equal(result.warnings.length, 2);
  });
});

describe('review json schema', () => {
  // A schema violation here is invisible until a live agent run fails with
  // `invalid_json_schema`, so it is asserted directly.
  it('satisfies strict structured-output rules', () => {
    assert.deepEqual(findStrictSchemaViolations(REVIEW_JSON_SCHEMA), []);
  });

  it('catches a schema that omits a property from required', () => {
    const bad = {
      type: 'object',
      additionalProperties: false,
      required: ['a'],
      properties: { a: { type: 'string' }, b: { type: 'string' } },
    };
    assert.match(findStrictSchemaViolations(bad).join(' '), /"b" is missing from required/);
  });

  it('catches a missing additionalProperties: false', () => {
    const bad = { type: 'object', required: ['a'], properties: { a: { type: 'string' } } };
    assert.match(findStrictSchemaViolations(bad).join(' '), /additionalProperties must be false/);
  });

  it('parses a review whose optional fields came back as null', () => {
    const result = parseReview(
      JSON.stringify({
        decision: 'request_changes',
        summary: 'Problems found.',
        findings: [
          {
            id: 'F1',
            severity: 'high',
            category: 'correctness',
            impact: null,
            summary: 'Boundary is wrong',
            evidence: null,
            suggestedFix: null,
            file: null,
            line: null,
          },
        ],
      }),
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;
    const finding = result.value.findings[0]!;
    assert.equal(finding.summary, 'Boundary is wrong');
    assert.equal(finding.file, undefined);
    assert.equal(finding.line, undefined);
    assert.equal(finding.impact, undefined);
  });
});

describe('finding responses', () => {
  it('parses responses and flags an unargued rejection', () => {
    const result = parseFindingResponses(
      `${beginMarker('RESPONSES')}${JSON.stringify({
        responses: [
          { findingId: 'F1', response: 'ACCEPT', reasoning: 'good catch' },
          { findingId: 'F2', response: 'REJECT', reasoning: '' },
        ],
      })}${endMarker('RESPONSES')}`,
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.length, 2);
    assert.match(result.warnings.join(' '), /rejected without reasoning/);
  });

  it('accepts a bare array as well as a wrapped object', () => {
    const result = parseFindingResponses(JSON.stringify([{ findingId: 'F1', response: 'ACCEPT', reasoning: 'ok' }]));
    assert.equal(result.ok, true);
  });

  it('fails when nothing parseable is present', () => {
    assert.equal(parseFindingResponses('I agree with everything.').ok, false);
  });
});

describe('finding classification', () => {
  const base = { id: 'F1', category: 'correctness' as const, summary: 's' };
  const standard = REVIEW_PROFILES.standard;

  it('returns a severe finding whatever the reviewer classified it as', () => {
    // A critical bug filed as a suggestion is still a critical bug, and the
    // severity scale is the half of the classification the reviewer cannot
    // talk itself out of.
    assert.equal(isBlockingAt({ ...base, severity: 'critical', impact: 'SUGGESTION' }, standard), true);
    assert.equal(isBlockingAt({ ...base, severity: 'high' }, standard), true);
  });

  it('honours an explicit BLOCKING down to the level\'s floor, and no further', () => {
    assert.equal(isBlockingAt({ ...base, severity: 'medium', impact: 'BLOCKING' }, standard), true);
    // Below the floor a "blocking" nitpick is reported, not returned: a round
    // costs minutes of a person's time.
    assert.equal(isBlockingAt({ ...base, severity: 'low', impact: 'BLOCKING' }, standard), false);
    assert.equal(isBlockingAt({ ...base, severity: 'medium' }, standard), false);
  });

  it('moves the bar with the level', () => {
    const medium = { ...base, severity: 'medium' as const };
    assert.equal(isBlockingAt(medium, REVIEW_PROFILES.light), false);
    assert.equal(isBlockingAt(medium, REVIEW_PROFILES.standard), false);
    assert.equal(isBlockingAt(medium, REVIEW_PROFILES.thorough), true);

    const low = { ...base, severity: 'low' as const };
    assert.equal(isBlockingAt(low, REVIEW_PROFILES.thorough), false);
    assert.equal(isBlockingAt(low, REVIEW_PROFILES.exhaustive), true);

    // A light review returns only what it cannot let through.
    assert.equal(isBlockingAt({ ...base, severity: 'high' }, REVIEW_PROFILES.light), false);
    assert.equal(isBlockingAt({ ...base, severity: 'high', impact: 'BLOCKING' }, REVIEW_PROFILES.light), true);
    assert.equal(isBlockingAt({ ...base, severity: 'critical' }, REVIEW_PROFILES.light), true);
  });

  it('treats anything above low severity as actionable for plan revision', () => {
    assert.equal(isActionableAt({ ...base, severity: 'low' }, standard), false);
    assert.equal(isActionableAt({ ...base, severity: 'medium' }, standard), true);
    // A thorough plan review answers the cosmetic ones too.
    assert.equal(isActionableAt({ ...base, severity: 'low' }, REVIEW_PROFILES.thorough), true);
  });

  it('formats a finding with its location', () => {
    assert.equal(
      formatFindingLine({ ...base, severity: 'high', file: 'src/a.ts', line: 4 }),
      '[high/correctness] F1: s (src/a.ts:4)',
    );
  });
});
