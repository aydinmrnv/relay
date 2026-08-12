import { describeEvent, type AgentEvent } from '../agents/types.ts';
import type { Role } from '../storage/config.ts';
import { DISPLAY_PHASES, displayPhaseFor, phaseLabel, phaseRole, type Phase } from '../workflow/phases.ts';
import type { RunObserver } from '../workflow/observer.ts';
import { formatDuration, oneLine } from '../util/text.ts';
import { asciiSafe, detectTheme, fitWidth, glyphs, padVisible, paint, type Theme } from './theme.ts';
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

  private activity = '';
  private linesDrawn = 0;
  private stopped = false;
  private spinnerFrame = 0;
  private spinnerTimer: NodeJS.Timeout | undefined;
  /** When the display opened, for the wall-clock in the footer. */
  private runStartedAt = 0;

  constructor(options: RunRendererOptions) {
    this.options = options;
    this.stream = options.stream ?? process.stdout;
    this.theme = options.theme ?? detectTheme(this.stream);
    this.now = options.now ?? Date.now;
    this.phases = options.phases ?? DISPLAY_PHASES;
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
    this.activity = '';
    this.roleDetail.delete(display);

    if (detail !== undefined) this.phaseDetail.set(display, detail);

    this.render();
    if (!this.theme.interactive) {
      const suffix = detail === undefined ? '' : ` (${detail})`;
      this.write(`${phaseLabel(phase)}${suffix}…\n`);
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
    if (this.options.verbose === true) {
      this.log(paint(this.theme, 'gray', `[${role}] ${JSON.stringify(event)}`));
      return;
    }
    // Thinking is noise at normal verbosity; everything else is a real action.
    if (event.type === 'thinking') return;

    const summary = oneLine(describeEvent(event), 100);
    if (summary.length === 0) return;

    this.activity = `${role}: ${summary}`;
    if (this.theme.interactive) {
      this.render();
    } else if (event.type === 'command' || event.type === 'file_changed' || event.type === 'failed') {
      this.write(`  ${this.activity}\n`);
    }
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

    this.activity = '';
    this.render();
    this.stopped = true;
    if (this.spinnerTimer !== undefined) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = undefined;
    }
    if (this.theme.interactive) this.write('\n');
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
    this.stream.write(`\u001B[${this.linesDrawn}A\u001B[0J`);
    this.linesDrawn = 0;
  }

  private draw(): void {
    if (!this.theme.interactive) return;
    const lines = this.buildLines().map((line) => fitWidth(asciiSafe(line, this.theme), this.stream));
    this.stream.write(`${lines.join('\n')}\n`);
    this.linesDrawn = lines.length;
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
    if (this.activity.length > 0) {
      footer.push(paint(this.theme, 'gray', `${marks.arrow} ${this.activity}`));
    }
    footer.push(this.progressLine(inner));

    return panel({ theme: this.theme, width, title: 'Pipeline', body, footer });
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
