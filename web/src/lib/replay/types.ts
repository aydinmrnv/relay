/**
 * A recording: a finished run written to one file by `relay recording`, and
 * played back here. The shape is the engine's `RunBundle` (`src/replay/bundle.ts`
 * in the CLI), restated because the studio and the CLI are separate packages.
 *
 * A recording can come from anywhere — someone opens a file — so nothing in it
 * is trusted. `parseRecording` checks the shape and bounds the sizes, the page
 * renders every string as text, and the only links made from it are a pull
 * request and an issue on github.com (`githubUrl`).
 */

export type ReceiptVerdict = 'match' | 'mismatch' | 'measured' | 'unverified';

export interface ReceiptSide {
  by: string;
  text: string;
  source: string;
}

export interface Receipt {
  id: string;
  subject: string;
  phase: string;
  at: string;
  claim: ReceiptSide | null;
  measured: ReceiptSide | null;
  verdict: ReceiptVerdict;
  note?: string;
}

export interface RecordingFinding {
  id: string;
  severity: string;
  category: string;
  summary: string;
  evidence?: string;
  suggestedFix?: string;
  file?: string;
  line?: number;
  impact?: string;
}

export interface RecordingResponse {
  findingId: string;
  response: string;
  reasoning: string;
}

export interface RecordingReview {
  kind: 'plan' | 'code';
  round: number;
  reviewer: string;
  decision: 'approve' | 'request_changes';
  summary?: string;
  findings: RecordingFinding[];
  responses: RecordingResponse[];
  at: string;
}

export interface RecordingPatch {
  label: string;
  patch: string;
  truncated: boolean;
}

/** One line of the engine's `relay run --json` stream. The fold reads the fields it knows and ignores the rest. */
export interface RecordingLine extends Record<string, unknown> {
  type: string;
  at: string;
}

/** The part of `relay status --json` the replay shows. Absent facts are `null`. */
export interface RecordingRun {
  runId: string;
  shortId: string;
  phase: string;
  phaseLabel: string;
  createdAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  issueRef: string;
  issue: { number: number | null; title: string; url: string } | null;
  repository: { owner: string | null; name: string | null };
  branch: string | null;
  agents: Record<string, string>;
  reviewLevel: string | null;
  pullRequest: { url: string; number: number | null } | null;
  costUsd: number | null;
  turns: number | null;
  pricedTurns: number | null;
  error: string | null;
  stopped: string | null;
}

export interface Recording {
  bundle: 1;
  exportedAt: string;
  relayVersion: string;
  exitCode: number;
  run: RecordingRun;
  stream: RecordingLine[];
  artifacts: {
    issue: string | null;
    plan: string | null;
    implementationNotes: string | null;
    reviews: RecordingReview[];
    patches: RecordingPatch[];
    testLog: string | null;
  };
  receipts: Receipt[];
  cleaned: { secrets: number; paths: number; patchesOmitted: boolean };
}

/** A recording that ships with the studio: a real run, with the pull request it opened. */
export interface BuiltinRecording {
  slug: string;
  title: string;
  /** One line on why this run is worth watching. */
  blurb: string;
  repository: string;
  pullRequest: number | null;
  outcome: 'passed' | 'checks-failed' | 'failed';
  minutes: number;
  costUsd: number | null;
}
