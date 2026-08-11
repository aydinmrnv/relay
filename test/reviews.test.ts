import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { extractSection, extractJson, beginMarker, endMarker } from '../src/reviews/protocol.ts';
import { parseReview, parseFindingResponses } from '../src/reviews/parse.ts';
import { isBlocking, isActionable, formatFindingLine } from '../src/reviews/types.ts';

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

  it('treats explicit impact as authoritative', () => {
    assert.equal(isBlocking({ ...base, severity: 'low', impact: 'BLOCKING' }), true);
    assert.equal(isBlocking({ ...base, severity: 'critical', impact: 'SUGGESTION' }), false);
  });

  it('falls back to severity when impact is absent', () => {
    assert.equal(isBlocking({ ...base, severity: 'high' }), true);
    assert.equal(isBlocking({ ...base, severity: 'medium' }), false);
  });

  it('treats anything above low severity as actionable for plan revision', () => {
    assert.equal(isActionable({ ...base, severity: 'low' }), false);
    assert.equal(isActionable({ ...base, severity: 'medium' }), true);
  });

  it('formats a finding with its location', () => {
    assert.equal(
      formatFindingLine({ ...base, severity: 'high', file: 'src/a.ts', line: 4 }),
      '[high/correctness] F1: s (src/a.ts:4)',
    );
  });
});
