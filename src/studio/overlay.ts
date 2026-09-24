/**
 * What a studio-started run takes from the workflow, and what it leaves to the
 * repository.
 *
 * The studio compiles a whole `.relay/config.json`, but a run it starts on this
 * machine is a person's run in a repository that already has opinions. So the
 * workflow decides the shape of the pipeline — who plans, who reviews, how
 * hard, how far delivery goes, the per-run cap — and the repository's own
 * config keeps everything else: the tracker, the harnesses, the notifications,
 * the unattended guardrails. Layered, not replaced, so a key the canvas does
 * not describe is never reset to a default behind the repository's back.
 *
 * Three things are fixed whatever the workflow says. Delivery stops at a pull
 * request: the run was started from a browser, and a merge is something a
 * person does looking at the pull request. The merge question and the cost
 * question are off, because there is no terminal for them to be asked on —
 * the confirmation happened in the studio, before the run was sent here.
 */

const WORKFLOW_KEYS = [
  'maxConcurrentRuns',
  'review',
  'plan',
  'reviewCode',
  'maxPlanReviewRounds',
  'maxCodeReviewRounds',
  'baseBranch',
  'branchPrefix',
  'runTests',
  'deliver',
  'mergeMethod',
  'maxTransientRetries',
  'maxCostUsd',
  'primeReviewers',
  'concurrentTests',
] as const;

const GITHUB_KEYS = ['autoPush', 'autoPr', 'mergeMethod', 'deleteBranchOnMerge'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function pick(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key];
  return out;
}

export function studioRunOverlay(compiled: Record<string, unknown>): Record<string, unknown> {
  const overlay: Record<string, unknown> = { version: 1 };
  if (isRecord(compiled['agents'])) overlay['agents'] = { ...compiled['agents'] };

  const workflow = isRecord(compiled['workflow']) ? pick(compiled['workflow'], WORKFLOW_KEYS) : {};
  if (workflow['deliver'] === 'merge') workflow['deliver'] = 'pr';
  overlay['workflow'] = { ...workflow, offerMerge: false, confirmAboveUsd: null };

  const github = isRecord(compiled['github']) ? pick(compiled['github'], GITHUB_KEYS) : {};
  overlay['github'] = { ...github, autoMerge: false };

  // A test command the workflow names is used; none leaves the repository's.
  const tests = isRecord(compiled['tests']) ? compiled['tests']['command'] : undefined;
  if (Array.isArray(tests) && tests.length > 0) overlay['tests'] = { command: tests };

  const delivery = isRecord(compiled['delivery']) ? compiled['delivery']['comment'] : undefined;
  if (typeof delivery === 'boolean') overlay['delivery'] = { comment: delivery };

  return overlay;
}
