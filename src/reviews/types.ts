export const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const CATEGORIES = [
  'correctness',
  'architecture',
  'security',
  'testing',
  'performance',
  'maintainability',
  'requirement',
] as const;
export type Category = (typeof CATEGORIES)[number];

/** How a code-review finding should be routed. Only BLOCKING is auto-returned. */
export const IMPACTS = ['BLOCKING', 'NON_BLOCKING', 'SUGGESTION'] as const;
export type Impact = (typeof IMPACTS)[number];

export const DECISIONS = ['approve', 'request_changes'] as const;
export type Decision = (typeof DECISIONS)[number];

export interface ReviewFinding {
  id: string;
  severity: Severity;
  category: Category;
  summary: string;
  evidence?: string;
  suggestedFix?: string;
  file?: string;
  line?: number;
  impact?: Impact;
}

export interface Review {
  decision: Decision;
  summary?: string;
  findings: ReviewFinding[];
}

export const RESPONSE_KINDS = ['ACCEPT', 'REJECT', 'NEEDS_CLARIFICATION'] as const;
export type ResponseKind = (typeof RESPONSE_KINDS)[number];

export interface FindingResponse {
  findingId: string;
  response: ResponseKind;
  /** Required for REJECT: a rejection without reasoning is not a response. */
  reasoning: string;
  evidence?: string;
}

/** One round of the plan or code debate, persisted for the audit trail. */
export interface ReviewRound {
  round: number;
  kind: 'plan' | 'code';
  reviewer: string;
  implementer?: string;
  decision: Decision;
  summary?: string;
  findings: ReviewFinding[];
  responses?: FindingResponse[];
  at: string;
}

export function isBlocking(finding: ReviewFinding): boolean {
  if (finding.impact !== undefined) return finding.impact === 'BLOCKING';
  return finding.severity === 'high' || finding.severity === 'critical';
}

/** Findings a plan revision must answer: anything above cosmetic. */
export function isActionable(finding: ReviewFinding): boolean {
  return finding.severity !== 'low' || finding.impact === 'BLOCKING';
}

export function countBySeverity(findings: readonly ReviewFinding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { low: 0, medium: 0, high: 0, critical: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}

export function formatFindingLine(finding: ReviewFinding): string {
  const location = finding.file === undefined ? '' : ` (${finding.file}${finding.line === undefined ? '' : `:${finding.line}`})`;
  const impact = finding.impact === undefined ? '' : ` [${finding.impact}]`;
  return `[${finding.severity}/${finding.category}]${impact} ${finding.id}: ${finding.summary}${location}`;
}
