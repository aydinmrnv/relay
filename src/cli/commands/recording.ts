import { readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

import { buildRunBundle, type RunBundle } from '../../replay/bundle.ts';
import type { ReceiptVerdict } from '../../replay/receipts.ts';
import { resolveRun, RunStore, RUN_FILES } from '../../storage/runs.ts';
import { DEFAULT_STUDIO_URL, trustedStudioOrigin } from '../../studio/protocol.ts';
import { readJsonFile } from '../../storage/atomic.ts';
import { packageVersion } from '../../update/installation.ts';
import { pluralize } from '../../util/text.ts';
import { phaseLabel } from '../../workflow/phases.ts';
import type { RunState } from '../../workflow/state.ts';
import { createCliContext } from '../context.ts';
import { EXIT } from '../exit.ts';
import { emitJson } from '../json.ts';
import { dim, facts, hint, ok, out } from '../output.ts';
import { landingOf } from './inspect.ts';

export interface RecordingOptions {
  out?: string;
  /** Commander's `--no-patches`: false leaves the diffs out of the recording. */
  patches?: boolean;
  json?: boolean;
}

/**
 * `relay recording`: a finished run, as one file the studio can play back.
 *
 * The run directory already holds everything — the state, the event log, the
 * plan, the reviews, the patches, the test log. This gathers it, cleans it
 * (`buildRunBundle`) and writes it where it was asked to. Nothing about the
 * run changes, and nothing leaves this machine: the file is the person's to
 * publish or not.
 */
export async function recordingCommand(runRef: string, options: RecordingOptions = {}): Promise<number> {
  const cli = await createCliContext();
  const state = await resolveRun(cli.repo.root, runRef);
  const store = new RunStore(cli.repo.root, state.runId);

  const bundle = buildRunBundle({
    state,
    events: await store.readEvents(),
    landing: await landingOf(cli.repo.root, state),
    relayVersion: await packageVersion().catch(() => 'unknown'),
    patches: await readPatches(store),
    planRevised: await readPlanRevisions(store, state),
    includePatches: options.patches !== false,
    home: homedir(),
    ...optional('issue', await store.readArtifact(RUN_FILES.issue)),
    ...optional('plan', await store.readArtifact(RUN_FILES.plan)),
    ...optional('implementationNotes', await store.readArtifact('implementation-notes.md')),
    ...optional('testLog', state.tests?.outputFile === undefined ? undefined : await store.readArtifact(state.tests.outputFile)),
  });

  const file = resolve(options.out ?? `relay-run-${state.shortId}.json`);
  const text = `${JSON.stringify(bundle, null, 2)}\n`;
  await writeFile(file, text, 'utf8');
  const bytes = Buffer.byteLength(text);
  const verdicts = countVerdicts(bundle);

  if (options.json === true) {
    emitJson('recording', {
      type: 'recording',
      file,
      bytes,
      runId: state.runId,
      shortId: state.shortId,
      phase: state.phase,
      phaseLabel: phaseLabel(state.phase),
      lines: bundle.stream.length,
      patches: bundle.artifacts.patches.length,
      receipts: verdicts,
      cleaned: bundle.cleaned,
    });
    return EXIT.success;
  }

  ok(`Recorded run ${state.shortId} → ${file} ${dim(`(${formatBytes(bytes)})`)}`);
  out(
    `  ${facts([
      phaseLabel(state.phase),
      pluralize(bundle.stream.filter((line) => line.type === 'phase_completed').length, 'phase'),
      bundle.artifacts.patches.length === 0 ? (bundle.cleaned.patchesOmitted ? 'patches left out' : 'no patches') : pluralize(bundle.artifacts.patches.length, 'patch', 'patches'),
      receiptLine(verdicts),
    ])}`,
  );
  const cleaned = facts([
    bundle.cleaned.secrets > 0 && `${pluralize(bundle.cleaned.secrets, 'credential-shaped string')} redacted`,
    bundle.cleaned.paths > 0 && `${pluralize(bundle.cleaned.paths, 'path')} on this machine replaced`,
  ]);
  if (cleaned.length > 0) out(`  ${dim(`Cleaned on the way out: ${cleaned}.`)}`);
  hint('The issue, the plan and the diff are in the file as the run saw them. Read it before you publish it.');
  hint(`Play it back in the studio: open ${studioRecordingsUrl()} and choose the file. It is read in your browser, not uploaded.`);
  return EXIT.success;
}

/** The studio's recordings page, on whichever studio this machine is set up to trust. */
function studioRecordingsUrl(): string {
  try {
    return `${trustedStudioOrigin()}/r`;
  } catch {
    // A malformed RELAY_STUDIO_URL is `relay connect`'s to report; the recording is written either way.
    return `${DEFAULT_STUDIO_URL}/r`;
  }
}

function optional<K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, string>);
}

/** Every patch the run captured, in the order it captured them: the implementation, then each revision. */
async function readPatches(store: RunStore): Promise<Array<{ label: string; patch: string }>> {
  let names: string[];
  try {
    names = await readdir(store.path('patches'));
  } catch {
    return [];
  }
  const order = (label: string): number => (label === 'implementation' ? 0 : Number.parseInt(/^revision-round-(\d+)$/.exec(label)?.[1] ?? '9999', 10));
  const patches: Array<{ label: string; patch: string }> = [];
  for (const name of names.filter((entry) => entry.endsWith('.patch'))) {
    const patch = await store.readArtifact(`patches/${name}`);
    if (patch !== undefined) patches.push({ label: name.slice(0, -'.patch'.length), patch });
  }
  return patches.sort((a, b) => order(a.label) - order(b.label) || a.label.localeCompare(b.label));
}

/** Whether each plan revision rewrote the plan, from the discussion file the round left. */
async function readPlanRevisions(store: RunStore, state: RunState): Promise<Record<number, boolean>> {
  const revised: Record<number, boolean> = {};
  for (const review of state.reviews) {
    if (review.kind !== 'plan') continue;
    const discussion = await readJsonFile<{ planRevised?: unknown }>(store.path('discussion', `plan-round-${review.round}.json`)).catch(() => undefined);
    if (typeof discussion?.planRevised === 'boolean') revised[review.round] = discussion.planRevised;
  }
  return revised;
}

function countVerdicts(bundle: RunBundle): Record<ReceiptVerdict, number> {
  const counts: Record<ReceiptVerdict, number> = { match: 0, mismatch: 0, measured: 0, unverified: 0 };
  for (const receipt of bundle.receipts) counts[receipt.verdict] += 1;
  return counts;
}

function receiptLine(counts: Record<ReceiptVerdict, number>): string {
  const total = counts.match + counts.mismatch + counts.measured + counts.unverified;
  const parts = [
    counts.match > 0 && `${counts.match} agree`,
    counts.mismatch > 0 && `${counts.mismatch} disagree`,
    counts.measured > 0 && `${counts.measured} measured only`,
    counts.unverified > 0 && `${counts.unverified} unverified`,
  ].filter((part): part is string => typeof part === 'string');
  return `${pluralize(total, 'receipt')}${parts.length === 0 ? '' : ` (${parts.join(', ')})`}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
