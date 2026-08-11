import { describeEvent, type AgentEvent } from '../agents/types.ts';
import type { Role } from '../storage/config.ts';
import { DISPLAY_PHASES, displayPhaseFor, phaseLabel, type Phase } from '../workflow/phases.ts';
import type { RunObserver } from '../workflow/observer.ts';
import { oneLine } from '../util/text.ts';
import { detectTheme, fitWidth, glyphs, paint, type Theme } from './theme.ts';

/** Which agent role drives each displayed phase, for the status column. */
const PHASE_ROLE: Partial<Record<Phase, Role>> = {
  PLANNING: 'planner',
  REVIEWING_PLAN: 'planReviewer',
  IMPLEMENTING: 'implementer',
  REVIEWING_CODE: 'codeReviewer',
};

type PhaseStatus = 'waiting' | 'active' | 'done' | 'failed';

export interface RunRendererOptions {
  title: string;
  subtitle?: string;
  /** Names shown next to each phase, e.g. `{ planner: 'claude' }`. */
  agentNames: Partial<Record<Role, string>>;
  verbose?: boolean;
  stream?: NodeJS.WriteStream;
  theme?: Theme;
}

/**
 * Progress display for `relay run`.
 *
 * On a TTY it redraws a compact phase checklist in place. Everywhere else —
 * pipes, CI, dumb terminals — it degrades to append-only lines carrying the
 * same information, because a smeared control-sequence log helps nobody.
 */
export class RunRenderer implements RunObserver {
  private readonly stream: NodeJS.WriteStream;
  private readonly theme: Theme;
  private readonly options: RunRendererOptions;

  private readonly status = new Map<Phase, PhaseStatus>();
  private readonly detail = new Map<Phase, string>();
  private activity = '';
  private linesDrawn = 0;
  private stopped = false;

  constructor(options: RunRendererOptions) {
    this.options = options;
    this.stream = options.stream ?? process.stdout;
    this.theme = options.theme ?? detectTheme(this.stream);
    for (const phase of DISPLAY_PHASES) this.status.set(phase, 'waiting');
  }

  start(): void {
    this.write(`${paint(this.theme, 'bold', this.options.title)}\n`);
    if (this.options.subtitle !== undefined) {
      this.write(`${paint(this.theme, 'gray', this.options.subtitle)}\n`);
    }
    this.write('\n');
    if (this.theme.interactive) this.draw();
  }

  phaseChanged(phase: Phase): void {
    const display = displayPhaseFor(phase);
    if (display === undefined) return;

    // Everything before the new phase is settled; mark it done.
    for (const candidate of DISPLAY_PHASES) {
      if (candidate === display) break;
      if (this.status.get(candidate) === 'waiting' || this.status.get(candidate) === 'active') {
        this.status.set(candidate, 'done');
      }
    }

    // Revision rounds re-enter a review phase that was already marked active.
    this.status.set(display, 'active');
    this.activity = '';

    if (phase === 'REVISING_PLAN' || phase === 'REVISING_CODE') {
      this.detail.set(display, 'revising');
    }

    this.render();
    if (!this.theme.interactive) this.write(`${phaseLabel(phase)}…\n`);
  }

  roleStatus(role: Role, status: string): void {
    for (const [phase, phaseRole] of Object.entries(PHASE_ROLE) as Array<[Phase, Role]>) {
      if (phaseRole === role && this.status.get(phase) === 'active') {
        this.detail.set(phase, status);
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
    for (const phase of DISPLAY_PHASES) {
      const status = this.status.get(phase);
      if (status === 'active') this.status.set(phase, finalPhase === 'COMPLETE' ? 'done' : 'failed');
      if (status === 'waiting' && finalPhase === 'COMPLETE') this.status.set(phase, 'done');
    }
    this.activity = '';
    this.render();
    this.stopped = true;
    if (this.theme.interactive) this.write('\n');
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
    const lines = this.buildLines();
    this.stream.write(`${lines.map((line) => fitWidth(line, this.stream)).join('\n')}\n`);
    this.linesDrawn = lines.length;
  }

  private buildLines(): string[] {
    const marks = glyphs(this.theme);
    const lines: string[] = [];

    for (const phase of DISPLAY_PHASES) {
      const status = this.status.get(phase) ?? 'waiting';
      const role = PHASE_ROLE[phase];
      const agent = role === undefined ? undefined : this.options.agentNames[role];

      const glyph =
        status === 'done'
          ? paint(this.theme, 'green', marks.done)
          : status === 'active'
            ? paint(this.theme, 'cyan', marks.active)
            : status === 'failed'
              ? paint(this.theme, 'red', marks.failed)
              : paint(this.theme, 'gray', marks.pending);

      const label = status === 'waiting' ? paint(this.theme, 'gray', phaseLabel(phase)) : phaseLabel(phase);
      lines.push(`${glyph} ${label}`);

      const detail = this.detail.get(phase) ?? (status === 'waiting' ? 'waiting' : status === 'done' ? 'complete' : '');
      const name = agent ?? '';
      if (name.length > 0 || detail.length > 0) {
        lines.push(paint(this.theme, 'gray', `  ${name.padEnd(18)} ${detail}`));
      }
    }

    if (this.activity.length > 0) {
      lines.push('');
      lines.push(paint(this.theme, 'gray', `  ${marks.arrow} ${this.activity}`));
    }

    return lines;
  }

  private write(text: string): void {
    this.stream.write(text);
  }
}
