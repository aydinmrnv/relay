import { basename } from 'node:path';
import { describeEvent, type AgentEvent } from '../agents/types.ts';
import { isBlockingAt, profileFor, reviewLevelName, type ReviewProfile } from '../reviews/level.ts';
import type { ReviewRound } from '../reviews/types.ts';
import type { Role } from '../storage/config.ts';
import { DISPLAY_PHASES, displayPhaseFor, phaseLabel, phaseRole, type Phase } from '../workflow/phases.ts';
import type { RunObserver, TestStatusUpdate } from '../workflow/observer.ts';
import type { RunState } from '../workflow/state.ts';
import { formatUsage, unpricedTurns } from '../workflow/usage.ts';
import { formatDuration, oneLine } from '../util/text.ts';
import { asciiSafe, detectTheme, fitWidth, glyphs, padVisible, paint, truncateVisible, visibleWidth, type Theme } from './theme.ts';
import { gauge, layoutWidth, panel, panelInnerWidth, statusBar } from './box.ts';
import { logoBar } from './logo.ts';

type PhaseStatus = 'waiting' | 'active' | 'done' | 'failed';

/** How often the spinner advances. Slow enough to read, fast enough to look alive. */
const SPINNER_INTERVAL_MS = 120;

/**
 * Columns reserved for a phase's clock. Wide enough for the longest duration
 * `formatDuration` produces at a run's scale (`1h 20m`), so the detail column
 * starts in the same place from the first phase to the last.
 */
const TIMING_WIDTH = 7;

/**
 * The slice of stdin the renderer touches, structural rather than
 * `NodeJS.ReadStream`: raw mode is optional because a pipe has none to set, and
 * a test hands this a plain stream rather than a terminal.
 */
interface TerminalInput {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?: (mode: boolean) => void;
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  off(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  pause(): unknown;
  resume(): unknown;
}

export interface RunRendererOptions {
  title: string;
  subtitle?: string;
  /** Names shown next to each phase, e.g. `{ planner: 'claude' }`. */
  agentNames: Partial<Record<Role, string>>;
  /** The checklist for this run. Defaults to every phase the full pipeline has. */
  phases?: readonly Phase[];
  verbose?: boolean;
  stream?: NodeJS.WriteStream;
  theme?: Theme;
  /** Injectable clock, so elapsed times are assertable in tests. */
  now?: () => number;
  state?: RunState;
  onStop?: () => void | Promise<void>;
  onDetach?: () => void;
  input?: TerminalInput;
}

/**
 * Progress display for `relay run`.
 *
 * On a TTY it redraws a compact phase checklist in place, with a spinner and a
 * live elapsed time on the active phase — a run takes 10–20 minutes, and a
 * silent agent turn has to look like work rather than a hang. Everywhere else —
 * pipes, CI, dumb terminals — it degrades to append-only lines carrying the same
 * information, because a smeared control-sequence log helps nobody.
 */
export class RunRenderer implements RunObserver {
  private readonly stream: NodeJS.WriteStream;
  private readonly theme: Theme;
  private readonly options: RunRendererOptions;
  private readonly now: () => number;
  /** Phases this run will actually enter, in order. */
  private readonly phases: readonly Phase[];

  private readonly status = new Map<Phase, PhaseStatus>();
  /** Round progress for the phase, e.g. `round 2/3`, from the engine. */
  private readonly phaseDetail = new Map<Phase, string>();
  /** What the agent driving the phase is doing right now. */
  private readonly roleDetail = new Map<Phase, string>();
  private readonly startedAt = new Map<Phase, number>();
  private readonly elapsed = new Map<Phase, number>();

  private activity: { text: string; at: number; priority: number } | undefined;
  private linesDrawn = 0;
  private drawnWidths: number[] = [];
  private stopped = false;
  private spinnerFrame = 0;
  private spinnerTimer: NodeJS.Timeout | undefined;
  /** When the display opened, for the wall-clock in the footer. */
  private runStartedAt = 0;
  private latestReview: ReviewRound | undefined;
  private latestTest: TestStatusUpdate | undefined;
  private verbose: boolean;
  private readonly emittedFacts = new Set<string>();
  private inputHandler: ((chunk: Buffer | string) => void) | undefined;
  private resizeHandler: (() => void) | undefined;
  private exitHandler: (() => void) | undefined;
  private priorRaw: boolean | undefined;

  constructor(options: RunRendererOptions) {
    this.options = options;
    this.stream = options.stream ?? process.stdout;
    this.theme = options.theme ?? detectTheme(this.stream);
    this.now = options.now ?? Date.now;
    this.phases = options.phases ?? DISPLAY_PHASES;
    this.verbose = options.verbose === true;
    for (const phase of this.phases) this.status.set(phase, 'waiting');
  }

  start(): void {
    this.runStartedAt = this.now();

    // On a terminal the header is the run's title bar: the mark, then what is
    // being worked on, ruled across the full width. A pipe gets the same two
    // facts as plain lines, because a log wants the text and not the furniture.
    if (this.theme.interactive) {
      this.write(`${logoBar(this.theme, this.options.title, this.width())}\n`);
    } else {
      this.write(`${paint(this.theme, 'bold', `Relay — ${this.options.title}`)}\n`);
    }
    if (this.options.subtitle !== undefined) {
      this.write(`${paint(this.theme, 'gray', this.options.subtitle)}\n`);
    }
    this.write('\n');

    if (!this.theme.interactive) return;
    this.draw();
    // unref'd: a spinner must never be the reason the process stays alive.
    this.spinnerTimer = setInterval(() => {
      this.spinnerFrame += 1;
      this.render();
    }, SPINNER_INTERVAL_MS);
    this.spinnerTimer.unref?.();
    this.installTerminalHandlers();
  }

  phaseChanged(phase: Phase, detail?: string): void {
    const display = displayPhaseFor(phase);
    if (display === undefined) return;

    // Everything before the new phase is settled; mark it done and stop its clock.
    for (const candidate of this.phases) {
      if (candidate === display) break;
      const status = this.status.get(candidate);
      if (status === 'waiting' || status === 'active') {
        this.status.set(candidate, 'done');
        this.closeClock(candidate);
        if (!this.theme.interactive && status === 'active') this.writeCompletedLine(candidate);
      }
    }

    // Revision rounds re-enter a review phase that was already marked active, so
    // its clock keeps running across the round rather than restarting.
    if (this.status.get(display) !== 'active') this.startedAt.set(display, this.now());
    this.status.set(display, 'active');
    this.activity = undefined;
    this.roleDetail.delete(display);

    if (detail !== undefined) this.phaseDetail.set(display, detail);

    this.render();
    if (!this.theme.interactive) {
      const suffix = detail === undefined ? '' : ` (${detail})`;
      this.write(`${phaseLabel(phase)}${suffix}…\n`);
      if (phase === 'TESTING' || phase === 'DELIVERING') this.emitStateFacts();
    }
  }

  roleStatus(role: Role, status: string): void {
    for (const phase of this.phases) {
      if (phaseRole(phase) === role && this.status.get(phase) === 'active') {
        this.roleDetail.set(phase, status);
      }
    }
    this.render();
  }

  agentEvent(role: Role, event: AgentEvent): void {
    if (this.verbose) {
      this.log(paint(this.theme, 'gray', `[${role}] ${JSON.stringify(event)}`));
      return;
    }
    // Thinking is noise at normal verbosity; everything else is a real action.
    if (event.type === 'thinking') return;

    const summary = oneLine(describeEvent(event), 100);
    if (summary.length === 0) return;

    const priority = event.type === 'file_changed' || event.type === 'command' || event.type === 'failed' || event.type === 'message' ? 2 : event.type === 'tool' ? 1 : 0;
    if (this.activity === undefined || priority >= this.activity.priority || this.activity.priority < 2) {
      this.activity = { text: `${role}: ${summary}`, at: this.now(), priority };
    }
    if (this.theme.interactive) {
      this.render();
    } else if (event.type === 'command' || event.type === 'file_changed' || event.type === 'failed') {
      this.write(`  ${this.activity?.text ?? ''}\n`);
    }
  }

  reviewCompleted(round: ReviewRound): void {
    if (round.kind !== 'code') return;
    this.latestReview = round;
    this.render();
    this.emitFact(`Findings: ${this.findingsText(round)}`);
  }

  testStatus(update: TestStatusUpdate): void {
    this.latestTest = update;
    this.render();
    this.emitFact(`Tests: ${this.testText(update)}`);
  }

  note(text: string): void {
    this.log(paint(this.theme, 'gray', `  ${glyphs(this.theme).bullet} ${text}`));
  }

  warn(text: string): void {
    this.log(paint(this.theme, 'yellow', `  ! ${text}`));
  }

  /** Writes a durable line above the live region. */
  log(text: string): void {
    this.clear();
    this.write(`${text}\n`);
    if (!this.stopped) this.draw();
  }

  finish(finalPhase: Phase): void {
    for (const phase of this.phases) {
      const status = this.status.get(phase);
      if (status === 'active') {
        this.status.set(phase, finalPhase === 'COMPLETE' ? 'done' : 'failed');
        this.closeClock(phase);
        if (!this.theme.interactive) this.writeCompletedLine(phase);
      }
      if (status === 'waiting' && finalPhase === 'COMPLETE') this.status.set(phase, 'done');
    }

    this.activity = undefined;
    this.render();
    this.stopped = true;
    if (this.spinnerTimer !== undefined) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = undefined;
    }
    if (this.theme.interactive) this.write('\n');
    this.teardown();
  }

  /** Restores terminal state; safe to call from a command's finally block. */
  teardown(): void {
    const input = this.options.input ?? process.stdin;
    if (this.inputHandler !== undefined) input.off('data', this.inputHandler);
    if (this.priorRaw !== undefined && input.setRawMode !== undefined) input.setRawMode(this.priorRaw);
    if (this.inputHandler !== undefined) input.pause();
    this.inputHandler = undefined;
    this.priorRaw = undefined;
    if (this.resizeHandler !== undefined) process.off('SIGWINCH', this.resizeHandler);
    if (this.exitHandler !== undefined) process.off('exit', this.exitHandler);
    this.resizeHandler = undefined;
    this.exitHandler = undefined;
  }

  /** Stops a phase's clock, keeping whatever it had already accumulated. */
  private closeClock(phase: Phase): void {
    const started = this.startedAt.get(phase);
    if (started === undefined) return;
    this.elapsed.set(phase, this.now() - started);
    this.startedAt.delete(phase);
  }

  private elapsedFor(phase: Phase): number | undefined {
    const started = this.startedAt.get(phase);
    if (started !== undefined) return this.now() - started;
    return this.elapsed.get(phase);
  }

  /** The append-only equivalent of a phase turning green. */
  private writeCompletedLine(phase: Phase): void {
    const ms = this.elapsedFor(phase);
    const marks = glyphs(this.theme);
    const mark = this.status.get(phase) === 'failed' ? marks.failed : marks.ok;
    this.write(`${mark} ${phaseLabel(phase)}${ms === undefined ? '' : ` (${formatDuration(ms)})`}\n`);
  }

  private render(): void {
    if (!this.theme.interactive || this.stopped) return;
    this.clear();
    this.draw();
  }

  private clear(): void {
    if (!this.theme.interactive || this.linesDrawn === 0) return;
    // Move up over the live region and erase it, leaving logged lines intact.
    const columns = Math.max(1, this.stream.columns ?? 80);
    const rows = this.drawnWidths.reduce((sum, width) => sum + Math.max(1, Math.ceil(width / columns)), 0);
    this.stream.write(`\u001B[${rows}A\u001B[0J`);
    this.linesDrawn = 0;
    this.drawnWidths = [];
  }

  private draw(): void {
    if (!this.theme.interactive) return;
    const lines = this.buildLines().map((line) => fitWidth(asciiSafe(line, this.theme), this.stream));
    this.stream.write(`${lines.join('\n')}\n`);
    this.linesDrawn = lines.length;
    this.drawnWidths = lines.map(visibleWidth);
  }

  private width(): number {
    return layoutWidth(this.stream);
  }

  /**
   * The live region: one framed row per phase, in fixed columns.
   *
   * Everything is one line per phase and every column starts in the same place
   * down the whole panel — mark, phase, clock, then who is doing what. A run
   * redraws this several times a second, and a reader tracking a column with
   * their eye must not have it move under them.
   */
  private buildLines(): string[] {
    const marks = glyphs(this.theme);
    const width = this.width();
    const inner = panelInnerWidth(width);
    const labelWidth = Math.max(...this.phases.map((phase) => phaseLabel(phase).length));

    const body = this.phases.map((phase) => {
      const status = this.status.get(phase) ?? 'waiting';
      const role = phaseRole(phase);
      const agent = role === undefined ? undefined : this.options.agentNames[role];

      const glyph =
        status === 'done'
          ? paint(this.theme, 'green', marks.done)
          : status === 'active'
            ? paint(this.theme, 'cyan', marks.spinner[this.spinnerFrame % marks.spinner.length] ?? marks.active)
            : status === 'failed'
              ? paint(this.theme, 'red', marks.failed)
              : paint(this.theme, 'gray', marks.pending);

      const label = padVisible(phaseLabel(phase), labelWidth);
      // Elapsed time is the run's only honest liveness signal, so it is shown
      // while a phase runs and kept as its final duration once it is done. It
      // sits directly after the label: a duration a column away from the thing
      // it times is a duration the reader has to hunt for.
      const ms = this.elapsedFor(phase);
      const timing = padVisible(ms === undefined || status === 'waiting' ? '' : formatDuration(ms), TIMING_WIDTH, 'right');

      const detail = [agent, this.detailFor(phase, status)].filter((part) => part !== undefined && part.length > 0);
      const row = `${glyph} ${status === 'waiting' ? paint(this.theme, 'gray', label) : label} ${paint(this.theme, 'gray', timing)}  ${paint(this.theme, 'gray', detail.join(' · '))}`;
      return row;
    });

    const footer: string[] = [];
    if (this.activity !== undefined) {
      footer.push(paint(this.theme, 'gray', `${marks.arrow} ${this.activity.text} (${formatDuration(this.now() - this.activity.at)})`));
    }
    footer.push(this.progressLine(inner));

    // The level rides in the frame's badge rather than in a row of its own: it
    // is the one fact about this run that explains the shape of the checklist
    // under it — why there is no plan review, or why a third round is allowed.
    const workflow = this.options.state?.config.workflow;
    const pipeline = panel({
      theme: this.theme,
      width,
      title: 'Pipeline',
      ...(workflow === undefined ? {} : { badge: paint(this.theme, 'gray', `review ${reviewLevelName(workflow)}`) }),
      body,
      footer,
    });
    const work = this.buildWorkLines(width);
    return work.length === 0 ? pipeline : [...pipeline, ...work];
  }

  private buildWorkLines(width: number): string[] {
    const rows: string[] = [];
    const state = this.options.state;
    if (state?.diff !== undefined) {
      const diff = state.diff;
      const files = diff.files.slice(0, 3).map((file) => basename(file)).join(', ');
      rows.push(`Diff      +${diff.additions} −${diff.deletions} · ${diff.fileCount} file${diff.fileCount === 1 ? '' : 's'}${files.length === 0 ? '' : ` · ${truncateVisible(files, Math.max(8, panelInnerWidth(width) - 30))}`}`);
    }
    const review = this.latestReview ?? state?.reviews.filter((round) => round.kind === 'code').at(-1);
    if (review !== undefined) rows.push(`Findings  ${this.findingsText(review)}`);
    if (state?.usage !== undefined) {
      const unpriced = unpricedTurns(state.usage.total);
      rows.push(`Cost      ${formatUsage(state.usage.total)}${unpriced === 0 ? '' : ` · ${unpriced} turn${unpriced === 1 ? '' : 's'} unpriced`}`);
    }
    if (this.latestTest !== undefined) rows.push(`Tests     ${this.testText(this.latestTest)}`);
    return rows.length === 0 ? [] : panel({ theme: this.theme, width, title: 'Work', body: rows });
  }

  /**
   * The same count the engine acts on, so the panel and the phase note never
   * disagree about how many findings are coming back.
   */
  private get profile(): ReviewProfile {
    return profileFor(this.options.state?.config.workflow ?? {});
  }

  private findingsText(round: ReviewRound): string {
    const profile = this.profile;
    const blocking = round.findings.filter((finding) => isBlockingAt(finding, profile)).length;
    return `${blocking} blocking · ${round.findings.length - blocking} non-blocking`;
  }

  private testText(update: TestStatusUpdate): string {
    return `${update.phase}${update.concurrent ? ' (concurrent)' : ''}${update.detail === undefined ? '' : ` · ${update.detail}`}`;
  }

  private emitFact(text: string): void {
    if (this.theme.interactive || this.emittedFacts.has(text)) return;
    this.emittedFacts.add(text);
    this.write(`${text}\n`);
  }

  private emitStateFacts(): void {
    const state = this.options.state;
    if (state?.diff !== undefined) this.emitFact(`Diff: +${state.diff.additions} −${state.diff.deletions} · ${state.diff.fileCount} file${state.diff.fileCount === 1 ? '' : 's'}`);
    if (state?.usage !== undefined) {
      const unpriced = unpricedTurns(state.usage.total);
      this.emitFact(`Cost: ${formatUsage(state.usage.total)}${unpriced === 0 ? '' : ` · ${unpriced} turn${unpriced === 1 ? '' : 's'} unpriced`}`);
    }
  }

  private installTerminalHandlers(): void {
    this.resizeHandler = () => this.render();
    process.on('SIGWINCH', this.resizeHandler);
    this.exitHandler = () => this.teardown();
    process.once('exit', this.exitHandler);
    const input = this.options.input ?? process.stdin;
    if (input.isTTY !== true || input.setRawMode === undefined) return;
    this.priorRaw = input.isRaw;
    input.setRawMode(true);
    input.resume();
    this.inputHandler = (chunk) => {
      for (const key of chunk.toString()) {
        if (key === 'v') { this.verbose = !this.verbose; this.render(); }
        else if (key === 'd') this.log(this.options.state?.diff === undefined ? 'Diff: not available yet' : `Diff: +${this.options.state.diff.additions} −${this.options.state.diff.deletions} · ${this.options.state.diff.fileCount} files`);
        else if (key === 's') { void this.options.onStop?.(); this.note('Stop requested.'); }
        else if (key === 'q') { if (this.options.onDetach !== undefined) this.options.onDetach(); else this.note('Detach is not available yet.'); }
      }
    };
    input.on('data', this.inputHandler);
  }

  /** `████░░░░  3/9 phases · 4m 2s` — how far in, and how long it has taken. */
  private progressLine(inner: number): string {
    const settled = this.phases.filter((phase) => {
      const status = this.status.get(phase);
      return status === 'done' || status === 'failed';
    }).length;

    const bar = gauge(this.theme, settled / Math.max(1, this.phases.length), 12);
    const counts = paint(this.theme, 'gray', `${settled}/${this.phases.length} phases`);
    const total = paint(this.theme, 'gray', formatDuration(Math.max(0, this.now() - this.runStartedAt)));
    return statusBar(`${bar}  ${counts}`, total, inner);
  }

  /** `round 2/3 · reviewing` — round limits stay visible while they are consumed. */
  private detailFor(phase: Phase, status: PhaseStatus): string {
    const parts: string[] = [];
    const rounds = this.phaseDetail.get(phase);
    if (rounds !== undefined) parts.push(rounds);

    const role = this.roleDetail.get(phase);
    if (role !== undefined) parts.push(role);

    if (parts.length > 0) return parts.join(' · ');
    return status === 'waiting' ? 'waiting' : status === 'done' ? 'complete' : '';
  }

  /** Everything the renderer emits is its own chrome, so all of it is downgradable. */
  private write(text: string): void {
    this.stream.write(asciiSafe(text, this.theme));
  }
}
