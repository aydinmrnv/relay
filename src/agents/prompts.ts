import { access } from 'node:fs/promises';
import { join } from 'node:path';

import { formatFindingLine, type ReviewFinding } from '../reviews/types.ts';
import { beginMarker, endMarker } from '../reviews/protocol.ts';

/** Instruction files worth pointing an agent at, if the repository has them. */
const INSTRUCTION_FILES = [
  'AGENTS.md',
  'CLAUDE.md',
  'CONTRIBUTING.md',
  '.github/CONTRIBUTING.md',
  'README.md',
  'docs/architecture.md',
];

export async function discoverInstructionFiles(worktreePath: string): Promise<string[]> {
  const found: string[] = [];
  for (const candidate of INSTRUCTION_FILES) {
    try {
      await access(join(worktreePath, candidate));
      found.push(candidate);
    } catch {
      continue;
    }
  }
  return found;
}

export interface PromptContext {
  worktreePath: string;
  branch: string;
  issueMarkdown: string;
  instructionFiles: readonly string[];
}

/**
 * Shared preamble. The hard boundaries are enforced by the sandbox and tool
 * deny lists; stating them here keeps the agent from wasting a turn attempting
 * something that will be refused anyway.
 */
function groundRules(context: PromptContext, capability: 'read_only' | 'write'): string {
  const lines = [
    'You are one agent in a multi-agent engineering workflow orchestrated by Relay.',
    '',
    `Working directory: ${context.worktreePath}`,
    `Branch: ${context.branch}`,
    '',
    'Hard rules:',
    '- This directory is an isolated git worktree created for this task. Stay inside it.',
    '- Never run `git push`, `git merge`, `gh pr create`, or `gh pr merge`. Publishing is the human user\'s decision.',
    '- Never modify files outside this working directory.',
  ];

  if (capability === 'read_only') {
    lines.push('- Do NOT modify, create, or delete any files. This is a read-only task: inspect and report only.');
  } else {
    lines.push('- Do not commit unless asked; Relay reads your changes directly from the working tree.');
  }

  if (context.instructionFiles.length > 0) {
    lines.push(
      '',
      `This repository has project instructions you must read and follow: ${context.instructionFiles.join(', ')}.`,
    );
  }

  return lines.join('\n');
}

function issueBlock(issueMarkdown: string): string {
  return ['## The issue', '', issueMarkdown.trim()].join('\n');
}

const PLAN_TEMPLATE = [
  '## Summary',
  '<what will change and why, in 2-4 sentences>',
  '',
  '## Relevant existing architecture',
  '<the modules, abstractions and conventions this work must fit into, with real file paths>',
  '',
  '## Files likely affected',
  '<bulleted list of paths, each with a phrase on what changes there>',
  '',
  '## Implementation approach',
  '<ordered, concrete steps a competent engineer could follow without re-deriving your reasoning>',
  '',
  '## Tests required',
  '<what must be tested, at which level, and where those tests belong in this repo>',
  '',
  '## Risks / uncertainties',
  '<what could break, what is hard to verify, what has blast radius>',
  '',
  '## Questions or assumptions',
  '<anything you had to assume because the issue does not say>',
].join('\n');

export function buildPlanPrompt(context: PromptContext): string {
  return [
    groundRules(context, 'read_only'),
    '',
    '# Task: produce an implementation plan',
    '',
    issueBlock(context.issueMarkdown),
    '',
    '## What to do',
    '',
    'Inspect the repository properly before planning. Read the code paths this issue touches, ',
    'identify the existing abstractions you should reuse, and confirm your assumptions against the ',
    'actual source rather than guessing from names.',
    '',
    'Your plan will be reviewed by an adversarial reviewer from a different model family, which will ',
    'check it against the real codebase. Vague plans get rejected. Be specific and cite real paths.',
    '',
    'Do not write any code changes. Produce only the plan.',
    '',
    '## Required output format',
    '',
    'Emit the plan as markdown between these exact markers, with nothing else between them:',
    '',
    beginMarker('PLAN'),
    PLAN_TEMPLATE,
    endMarker('PLAN'),
  ].join('\n');
}

export interface PlanReviewPromptOptions extends PromptContext {
  plan: string;
  round: number;
  maxRounds: number;
}

export function buildPlanReviewPrompt(options: PlanReviewPromptOptions): string {
  return [
    groundRules(options, 'read_only'),
    '',
    `# Task: adversarially review an implementation plan (round ${options.round} of ${options.maxRounds})`,
    '',
    issueBlock(options.issueMarkdown),
    '',
    '## The plan under review',
    '',
    options.plan.trim(),
    '',
    '## What to do',
    '',
    'Your job is NOT to rewrite the plan. It is to find what is wrong with it, by checking it against ',
    'the actual repository in your working directory. Read the files the plan names. Verify that the ',
    'abstractions it claims exist really do exist and work the way it assumes.',
    '',
    'Look specifically for:',
    '- incorrect assumptions about how the existing code behaves',
    '- existing abstractions, helpers or patterns the plan overlooks and would duplicate',
    '- architectural problems, including changes that fight the codebase\'s established structure',
    '- security concerns (authz, input handling, secrets, injection, unsafe defaults)',
    '- missing edge cases',
    '- missing or inadequate tests',
    '- unnecessary complexity, including work the issue does not ask for',
    '- requirements in the issue the plan does not address',
    '',
    'Ground every finding in evidence: quote the file and line, or the exact sentence of the plan you ',
    'are objecting to. Do not invent findings to appear thorough — approving a good plan is a valid ',
    'and useful outcome. Do not report style preferences as findings.',
    '',
    '## Required output format',
    '',
    'Emit a single JSON object between these exact markers, with nothing else between them:',
    '',
    beginMarker('REVIEW'),
    reviewJsonTemplate('plan'),
    endMarker('REVIEW'),
    '',
    'Use "approve" only if you found nothing of medium severity or above.',
  ].join('\n');
}

function reviewJsonTemplate(kind: 'plan' | 'code'): string {
  const impactLine =
    kind === 'code'
      ? '      "impact": "BLOCKING | NON_BLOCKING | SUGGESTION",\n'
      : '';
  return [
    '{',
    '  "decision": "approve | request_changes",',
    '  "summary": "<one or two sentences on the overall state>",',
    '  "findings": [',
    '    {',
    '      "id": "F1",',
    '      "severity": "low | medium | high | critical",',
    '      "category": "correctness | architecture | security | testing | performance | maintainability | requirement",',
    impactLine.replace(/\n$/, ''),
    '      "summary": "<the problem, stated in one sentence>",',
    '      "evidence": "<file:line, quoted code, or the exact text you are objecting to>",',
    '      "suggestedFix": "<what should change instead>",',
    '      "file": "<path, if applicable>",',
    '      "line": 0',
    '    }',
    '  ]',
    '}',
  ]
    .filter((line) => line.length > 0)
    .join('\n');
}

export interface RevisionPromptOptions {
  findings: readonly ReviewFinding[];
  round: number;
  maxRounds: number;
  reviewerName: string;
  reviewSummary?: string;
}

/**
 * Sent into the planner's *existing* session, so the plan, the codebase reading
 * behind it, and the earlier rounds are all still in context.
 */
export function buildPlanRevisionPrompt(options: RevisionPromptOptions): string {
  return [
    `# Plan review feedback (round ${options.round} of ${options.maxRounds})`,
    '',
    `A reviewer (${options.reviewerName}) examined your plan against the repository and raised the findings below.`,
    ...(options.reviewSummary === undefined ? [] : ['', `Reviewer summary: ${options.reviewSummary}`]),
    '',
    '## Findings',
    '',
    ...options.findings.map((finding) => formatFinding(finding)),
    '',
    '## What to do',
    '',
    'Respond to every finding. You are not required to agree: if a finding is wrong, reject it and say ',
    'why, with evidence from the code. A rejection without evidence is not acceptable. If a finding is ',
    'unclear, mark it NEEDS_CLARIFICATION and state precisely what you need to know.',
    '',
    'Then emit your revised plan in full, incorporating every finding you accepted. Keep the same ',
    'section structure as before. Do not modify any files.',
    '',
    '## Required output format',
    '',
    'Emit BOTH sections below, in this order.',
    '',
    beginMarker('RESPONSES'),
    '{',
    '  "responses": [',
    '    {',
    '      "findingId": "F1",',
    '      "response": "ACCEPT | REJECT | NEEDS_CLARIFICATION",',
    '      "reasoning": "<why — required, and required to cite evidence when rejecting>",',
    '      "evidence": "<file:line or quoted code supporting your reasoning>"',
    '    }',
    '  ]',
    '}',
    endMarker('RESPONSES'),
    '',
    beginMarker('PLAN'),
    '<the complete revised plan, in markdown, using the same section headings as before>',
    endMarker('PLAN'),
  ].join('\n');
}

function formatFinding(finding: ReviewFinding): string {
  const lines = [`### ${formatFindingLine(finding)}`];
  if (finding.evidence !== undefined) lines.push('', `Evidence: ${finding.evidence}`);
  if (finding.suggestedFix !== undefined) lines.push('', `Suggested fix: ${finding.suggestedFix}`);
  return `${lines.join('\n')}\n`;
}

export interface ImplementationPromptOptions extends PromptContext {
  plan: string;
  testCommand?: readonly string[];
}

export function buildImplementationPrompt(options: ImplementationPromptOptions): string {
  return [
    groundRules(options, 'write'),
    '',
    '# Task: implement the approved plan',
    '',
    issueBlock(options.issueMarkdown),
    '',
    '## The approved plan',
    '',
    'This plan was written by another agent and has already survived adversarial review. Implement it.',
    '',
    options.plan.trim(),
    '',
    '## What to do',
    '',
    'Make the changes directly in your working directory. Follow the repository\'s existing conventions ',
    'and reuse its existing abstractions rather than introducing parallel ones.',
    '',
    'Write the tests the plan calls for. Your diff will be reviewed by a different agent, which will read ',
    'the actual git diff rather than your description of it, so what you claim and what you changed must match.',
    '',
    ...(options.testCommand === undefined
      ? ['If the repository has a test suite, run it before finishing.']
      : [`Verify your work by running: \`${options.testCommand.join(' ')}\``]),
    '',
    'If the plan turns out to be wrong or impossible, implement what you can and state the deviation clearly.',
    '',
    '## Required output format',
    '',
    'When you are done, emit a short report between these markers:',
    '',
    beginMarker('NOTES'),
    '- What you changed, by file',
    '- Any deviation from the plan, and why',
    '- Anything you could not do, and why',
    '- Test results, if you ran them',
    endMarker('NOTES'),
  ].join('\n');
}

export interface CodeReviewPromptOptions extends PromptContext {
  plan: string;
  diff: string;
  diffStat: string;
  round: number;
  maxRounds: number;
}

export function buildCodeReviewPrompt(options: CodeReviewPromptOptions): string {
  return [
    groundRules(options, 'read_only'),
    '',
    `# Task: review an implementation diff (round ${options.round} of ${options.maxRounds})`,
    '',
    issueBlock(options.issueMarkdown),
    '',
    '## The approved plan',
    '',
    options.plan.trim(),
    '',
    `## The actual diff (${options.diffStat})`,
    '',
    'This diff was produced by Relay from git, not by the implementing agent. It is what really changed.',
    '',
    '```diff',
    options.diff.trim(),
    '```',
    '',
    '## What to do',
    '',
    'Review the diff against the issue and the plan. The full repository is in your working directory, so ',
    'open the surrounding code — a diff hunk alone rarely shows whether a change is correct.',
    '',
    'Check for:',
    '- correctness bugs, including edge cases and error paths the diff introduces or leaves unhandled',
    '- requirements from the issue that the diff does not actually satisfy',
    '- security problems',
    '- missing tests for the behaviour that changed',
    '- existing abstractions that were duplicated instead of reused',
    '- unnecessary complexity or scope beyond the plan',
    '',
    'Tie every finding to a real file and line in the diff. Classify each finding\'s impact:',
    '- BLOCKING: must be fixed before this can be considered done',
    '- NON_BLOCKING: a real problem, but does not block',
    '- SUGGESTION: an improvement worth noting',
    '',
    'Only BLOCKING findings are sent back to the implementer automatically, so classify honestly: ',
    'marking a nitpick BLOCKING wastes a round, and marking a real bug SUGGESTION lets it through.',
    '',
    '## Required output format',
    '',
    'Emit a single JSON object between these exact markers, with nothing else between them:',
    '',
    beginMarker('REVIEW'),
    reviewJsonTemplate('code'),
    endMarker('REVIEW'),
    '',
    'Use "approve" if there are no BLOCKING findings.',
  ].join('\n');
}

export interface CodeRevisionPromptOptions {
  findings: readonly ReviewFinding[];
  round: number;
  maxRounds: number;
  reviewerName: string;
  reviewSummary?: string;
}

export function buildCodeRevisionPrompt(options: CodeRevisionPromptOptions): string {
  return [
    `# Code review feedback (round ${options.round} of ${options.maxRounds})`,
    '',
    `A reviewer (${options.reviewerName}) read the git diff of your implementation and raised the blocking findings below.`,
    ...(options.reviewSummary === undefined ? [] : ['', `Reviewer summary: ${options.reviewSummary}`]),
    '',
    '## Blocking findings',
    '',
    ...options.findings.map((finding) => formatFinding(finding)),
    '',
    '## What to do',
    '',
    'Address each finding you accept by changing the code in your working directory. If a finding is ',
    'wrong, reject it with evidence from the code rather than changing it — do not make a change you ',
    'believe is incorrect just because a reviewer asked.',
    '',
    'Re-run the tests afterwards if the repository has them.',
    '',
    '## Required output format',
    '',
    'Emit BOTH sections below, in this order.',
    '',
    beginMarker('RESPONSES'),
    '{',
    '  "responses": [',
    '    {',
    '      "findingId": "F1",',
    '      "response": "ACCEPT | REJECT | NEEDS_CLARIFICATION",',
    '      "reasoning": "<what you changed, or why the finding is wrong>",',
    '      "evidence": "<file:line>"',
    '    }',
    '  ]',
    '}',
    endMarker('RESPONSES'),
    '',
    beginMarker('NOTES'),
    '<a short description of the changes you made in this round>',
    endMarker('NOTES'),
  ].join('\n');
}

/**
 * Sent when an agent's structured output could not be parsed. Kept short and
 * mechanical: the agent already has the work in context, it just needs to
 * re-emit it in the required shape.
 */
export function buildRepairPrompt(expectation: string, error: string): string {
  return [
    'Your previous response could not be parsed by the orchestrator.',
    '',
    `Problem: ${error}`,
    '',
    `Re-send your answer now, unchanged in substance, in exactly the required format:`,
    '',
    expectation,
    '',
    'Output the markers and their contents only. No preamble, no commentary outside the markers.',
  ].join('\n');
}
