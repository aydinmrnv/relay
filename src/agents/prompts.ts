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

/**
 * Every turn is on a human's critical path, and an agent left to its own
 * devices will read a repository far past the point of diminishing returns.
 * Naming the budget is the cheapest latency control Relay has.
 */
const EFFICIENCY = [
  'Work efficiently: this runs while someone waits.',
  '- Read what this task actually depends on, not the whole repository.',
  '- Prefer one targeted search over walking directories.',
  '- Stop investigating once you can defend your answer; more reading past that point buys nothing.',
].join('\n');

/**
 * A cap keeps a review from turning into an essay. Reviews are read by another
 * agent under the same time pressure, and the twentieth finding of a long tail
 * has never been the one that mattered.
 */
const FINDING_BUDGET =
  'Report at most 10 findings. If you have more, report the 10 that matter most and drop the rest — ' +
  'a long tail of minor findings costs a revision round and buys nothing.';

/** Reminds a primed reviewer that it is resuming its own reading, not starting over. */
const ALREADY_READ =
  'You already read this repository earlier in this same session, before this artifact existed. ' +
  'Use what you have: re-open only the specific files this artifact touches that you have not seen ' +
  'yet, and go straight to the judgement.';

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
    EFFICIENCY,
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

/**
 * Sent to a reviewer *before* the artifact it will review exists, while the
 * other agent is still producing it.
 *
 * It asks for the reading a review needs, not for a verdict on work that has
 * not happened yet. The reviewer forms its own independent view of the issue
 * first, which is both faster later and harder to anchor.
 */
export function buildReviewPrimingPrompt(
  context: PromptContext,
  options: { subject: 'plan' | 'implementation'; plan?: string },
): string {
  const artifact =
    options.subject === 'plan'
      ? 'another agent is writing an implementation plan for this issue'
      : 'another agent is implementing this issue right now';

  return [
    groundRules(context, 'read_only'),
    '',
    '# Task: read ahead, so your review does not have to',
    '',
    issueBlock(context.issueMarkdown),
    ...(options.plan === undefined
      ? []
      : ['', '## The plan being implemented', '', options.plan.trim()]),
    '',
    '## What to do',
    '',
    `Right now, ${artifact}. In a few minutes you will be asked to review it, in this same session, `,
    'and the clock will be running then. So do the reading now:',
    '',
    '- Open the code this issue touches and understand how it works today.',
    '- Note the conventions, abstractions and invariants any correct change here must respect.',
    '- Decide what you would consider a correct solution, and what you expect to go wrong.',
    '',
    'Do NOT review anything yet — there is nothing to review. Do not write files. Do not guess at the ',
    'other agent\'s work.',
    '',
    EFFICIENCY,
    '',
    '## Required output format',
    '',
    'Finish with a brief note to yourself between these markers — under 200 words, since its only ',
    'reader is you, later in this conversation:',
    '',
    beginMarker('SUMMARY'),
    '<what this issue really requires, the files that matter, and what you will be checking>',
    endMarker('SUMMARY'),
  ].join('\n');
}

export interface PlanReviewPromptOptions extends PromptContext {
  plan: string;
  round: number;
  maxRounds: number;
  /** The reviewer already read the repository in this session. */
  primed?: boolean;
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
    ...(options.primed === true ? [ALREADY_READ, ''] : [EFFICIENCY, '']),
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
    'and useful outcome, and the fastest one. Do not report style preferences as findings.',
    '',
    FINDING_BUDGET,
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
  /** Relay runs the suite itself the moment this turn ends. */
  relayRunsTests?: boolean;
  /** Another agent will review this diff. False on a `--fast` run. */
  reviewed?: boolean;
  /** `--tuff`: this run's writing is meant to read as human. */
  typos?: boolean;
}

/**
 * What `--tuff` asks the writing agents for.
 *
 * The orchestrator can mistype its own pull request and commit messages on its
 * own, but the comments in the diff are written by the agent, so this is the
 * only place they can be asked for. The boundary is the same one Relay applies
 * to its own text: prose only, never anything the code or its tooling reads.
 */
const HOUSE_STYLE = [
  '## Writing style for this run',
  '',
  'Write the comments in this change the way a person types them at speed: plain sentences, with the ',
  'occasional typo left in rather than corrected. Do not sound like generated text.',
  '',
  'That applies to comment prose and nothing else. Identifiers, string literals, API names, file paths, ',
  'test names and expected values, and any comment a tool parses (directives, pragmas, doc annotations) ',
  'must all be spelled correctly — a typo there is a bug, not a voice.',
].join('\n');

function houseStyle(options: { typos?: boolean }): string[] {
  return options.typos === true ? [HOUSE_STYLE, ''] : [];
}

/**
 * Who reads this diff next. On a `--fast` run the answer is nobody, and an
 * implementer that believes a reviewer is coming behind it leaves work for a
 * turn that will never happen.
 */
function reviewExpectation(options: { reviewed?: boolean }): string[] {
  if (options.reviewed === false) {
    return [
      'There is no code review on this run: no other agent reads this diff. The tests and you are the ',
      'only checks it gets, so verify your own work before you finish and do not leave anything for a ',
      'reviewer to catch.',
    ];
  }
  return [
    'Your diff will be reviewed by a different agent, which will read the actual git diff rather than your ',
    'description of it, so what you claim and what you changed must match.',
  ];
}

/**
 * How the implementer should verify itself.
 *
 * When Relay runs the suite concurrently the moment the turn ends, an
 * implementer that also runs the full suite adds minutes to the critical path
 * to produce a result Relay is about to produce anyway. Targeted tests are the
 * part only the implementer can do, so that is the part it is asked for.
 */
function verificationInstruction(options: ImplementationPromptOptions): string[] {
  if (options.testCommand === undefined) {
    return options.relayRunsTests === true
      ? ['Relay runs this project\'s test suite itself as soon as you finish, and judges it by exit code.']
      : ['If the repository has a test suite, run it before finishing.'];
  }

  const printable = `\`${options.testCommand.join(' ')}\``;
  if (options.relayRunsTests !== true) return [`Verify your work by running: ${printable}`];

  return [
    `Relay runs ${printable} itself the moment you finish, in parallel with your code review, and judges `,
    'it by exit code — so you do not need to run the full suite yourself, and running it costs the user ',
    'minutes of waiting for a result they are about to get anyway.',
    '',
    'Do run the narrow checks only you can run: the specific test file or case you touched, a type check, ',
    'or a single command that proves the change works. Then stop.',
  ];
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
    'Write the tests the plan calls for.',
    ...reviewExpectation(options),
    '',
    ...verificationInstruction(options),
    '',
    EFFICIENCY,
    '',
    'If the plan turns out to be wrong or impossible, implement what you can and state the deviation clearly.',
    '',
    ...houseStyle(options),
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

/**
 * The fast path: one agent plans and implements in a single session.
 *
 * A separate planner turn buys a cross-model critique of the approach before
 * any code exists. It also costs two to four serial agent turns. This prompt is
 * what a user chooses when that trade is not worth the wall-clock on a small
 * ticket: the plan is still written down, still reviewed — but as part of the
 * diff, by the code reviewer, rather than on its own.
 */
export function buildInlinePlanPrompt(options: ImplementationPromptOptions): string {
  return [
    groundRules(options, 'write'),
    '',
    '# Task: plan this issue and implement it, in one pass',
    '',
    issueBlock(options.issueMarkdown),
    '',
    '## What to do',
    '',
    'There is no separate planning agent on this run: you are both. Work in two steps, in this order.',
    '',
    '1. Read the code this issue touches and decide the approach. Keep it short — a handful of ',
    '   sentences and the files you will change. Do not write a document; write the decision.',
    '2. Implement it, following the repository\'s existing conventions and reusing its abstractions, ',
    '   and write the tests the change calls for.',
    '',
    ...(options.reviewed === false
      ? [
          'Nothing downstream reviews this: there is no plan reviewer and no code reviewer on this run. ',
          'State the plan you really followed anyway — it is what the person reading this run will judge ',
          'the diff against — and be your own reviewer before you finish.',
        ]
      : [
          'A different agent will then review your actual git diff against the plan you state below, so state ',
          'the plan you really followed. If you change approach part-way, say so in the plan rather than ',
          'leaving the reviewer to discover it.',
        ]),
    '',
    ...verificationInstruction(options),
    '',
    EFFICIENCY,
    '',
    ...houseStyle(options),
    '## Required output format',
    '',
    'Emit BOTH sections below, in this order.',
    '',
    beginMarker('PLAN'),
    '## Summary',
    '<what you changed and why, in 2-4 sentences>',
    '',
    '## Approach',
    '<the steps you took, with real file paths>',
    '',
    '## Tests',
    '<what you tested and where those tests live>',
    '',
    '## Risks / uncertainties',
    '<what could break, and anything you had to assume>',
    endMarker('PLAN'),
    '',
    beginMarker('NOTES'),
    '- What you changed, by file',
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
  /** The reviewer already read the repository in this session. */
  primed?: boolean;
  /** Relay is running the suite right now, so the reviewer need not. */
  testsRunning?: boolean;
  /** The plan survived its own adversarial review before any code was written. */
  planApproved?: boolean;
}

export function buildCodeReviewPrompt(options: CodeReviewPromptOptions): string {
  return [
    groundRules(options, 'read_only'),
    '',
    `# Task: review an implementation diff (round ${options.round} of ${options.maxRounds})`,
    '',
    issueBlock(options.issueMarkdown),
    '',
    // Whether the plan itself was ever challenged changes what this review is
    // for: with no plan review upstream, the approach is in scope here too.
    ...(options.planApproved === true
      ? ['## The approved plan', '', 'This plan was reviewed and approved before any code was written.']
      : [
          '## The plan the implementer says it followed',
          '',
          'No reviewer approved this plan: either no plan review ran on this issue, or it ended with ',
          'the objections unresolved. Nothing upstream has vouched for the approach, so if the approach ',
          'itself is wrong, that is a finding here — not just its execution.',
        ]),
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
    ...(options.primed === true ? [ALREADY_READ, ''] : [EFFICIENCY, '']),
    ...(options.testsRunning === true
      ? [
          'Relay is running this project\'s test suite against this exact diff right now, and will report ',
          'the result by exit code. Do not run the suite yourself: judge the code, not the build.',
          '',
        ]
      : []),
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
    'marking a nitpick BLOCKING wastes a round — several minutes of a person\'s time — and marking a ',
    'real bug SUGGESTION lets it through.',
    '',
    FINDING_BUDGET,
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

export interface CodeRevisionPromptOptions extends RevisionPromptOptions {
  /** Relay runs the suite itself once this turn ends. */
  relayRunsTests?: boolean;
  /** `--tuff`: this run's writing is meant to read as human. */
  typos?: boolean;
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
    ...(options.relayRunsTests === true
      ? [
          'Relay re-runs the project\'s suite itself the moment you finish, so re-run only the targeted ',
          'checks covering what you just changed.',
        ]
      : ['Re-run the tests afterwards if the repository has them.']),
    '',
    ...houseStyle(options),
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
