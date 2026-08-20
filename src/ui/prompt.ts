import { createInterface, type Interface } from 'node:readline/promises';

import { RelayError } from '../util/errors.ts';
import { detectTheme, paint, type Theme } from './theme.ts';

export interface Choice<T extends string> {
  value: T;
  label: string;
  /** Extra context shown after the label, e.g. why an option is unavailable. */
  hint?: string;
}
export interface SelectItem<T> { value: T; label: string; hint?: string }

export interface PrompterOptions {
  input?: NodeJS.ReadableStream & { isTTY?: boolean };
  output?: NodeJS.WritableStream;
  /**
   * Overrides detection. `false` makes every prompt return its default without
   * reading a byte, which is what `--yes`, CI and a piped stdin all need.
   */
  interactive?: boolean;
  theme?: Theme;
}

/** Thrown when the user presses Ctrl-C at a prompt. */
export function isPromptCancelled(error: unknown): boolean {
  return error instanceof RelayError && error.code === 'PROMPT_CANCELLED';
}

/**
 * What a guided flow needs from the terminal. Depending on this rather than on
 * `Prompter` lets a flow be driven by a script in tests, so the flow's own
 * behaviour — which questions, in what order, and what they produce — is tested
 * without a pseudo-terminal in the loop.
 */
export interface PromptSession {
  /** False means every question returns its default without reading input. */
  readonly interactive: boolean;
  text(question: string, defaultValue: string, validate?: (value: string) => string | undefined): Promise<string>;
  confirm(question: string, defaultValue: boolean): Promise<boolean>;
  choice<T extends string>(question: string, choices: ReadonlyArray<Choice<T>>, defaultValue: T): Promise<T>;
  select<T>(question: string, items: ReadonlyArray<SelectItem<T>>, defaultIndex?: number): Promise<T>;
  close(): void;
}

/**
 * A small prompt helper over `node:readline/promises` — deliberately not a
 * dependency, and deliberately not a form library.
 *
 * Two rules hold everywhere: every prompt has a default, so the whole flow is
 * completable with Enter; and a non-interactive prompter returns those defaults
 * immediately rather than blocking on input that will never arrive.
 */
export class Prompter implements PromptSession {
  readonly interactive: boolean;

  private readonly input: NodeJS.ReadableStream & { isTTY?: boolean };
  private readonly output: NodeJS.WritableStream;
  private readonly theme: Theme;
  private rl: Interface | undefined;
  private cancelled = false;

  constructor(options: PrompterOptions = {}) {
    this.input = options.input ?? process.stdin;
    this.output = options.output ?? process.stdout;
    this.theme = options.theme ?? detectTheme(process.stdout);
    this.interactive = options.interactive ?? (this.theme.interactive && this.input.isTTY === true);
  }

  /** Free-text with a default. `validate` returns a message to re-ask, or undefined. */
  async text(
    question: string,
    defaultValue: string,
    validate?: (value: string) => string | undefined,
  ): Promise<string> {
    if (!this.interactive) return defaultValue;

    // An empty default has nothing to show, and `[]` reads like a value.
    const suffix = defaultValue.length === 0 ? '' : ` ${this.hint(`[${defaultValue}]`)}`;

    for (;;) {
      const answer = await this.ask(`${question}${suffix} `);
      if (answer === undefined) return defaultValue;

      const value = answer.trim().length === 0 ? defaultValue : answer.trim();
      const problem = validate?.(value);
      if (problem === undefined) return value;
      this.write(`${paint(this.theme, 'yellow', `  ${problem}`)}\n`);
    }
  }

  async confirm(question: string, defaultValue: boolean): Promise<boolean> {
    if (!this.interactive) return defaultValue;

    for (;;) {
      const answer = await this.ask(`${question} ${this.hint(defaultValue ? '[Y/n]' : '[y/N]')} `);
      if (answer === undefined) return defaultValue;

      const normalized = answer.trim().toLowerCase();
      if (normalized.length === 0) return defaultValue;
      if (normalized === 'y' || normalized === 'yes') return true;
      if (normalized === 'n' || normalized === 'no') return false;
      this.write(`${paint(this.theme, 'yellow', '  Please answer y or n.')}\n`);
    }
  }

  /** Numbered list. The value name is accepted too, so `codex` works as well as `2`. */
  async choice<T extends string>(question: string, choices: ReadonlyArray<Choice<T>>, defaultValue: T): Promise<T> {
    if (!this.interactive || choices.length === 0) return defaultValue;

    const fallback = choices.findIndex((choice) => choice.value === defaultValue);
    const defaultIndex = fallback === -1 ? 0 : fallback;
    const width = Math.max(...choices.map((choice) => choice.value.length));

    this.write(`${question}\n`);
    choices.forEach((choice, index) => {
      const detail = choice.hint === undefined ? choice.label : `${choice.label} — ${choice.hint}`;
      this.write(`  ${index + 1}) ${choice.value.padEnd(width)}  ${paint(this.theme, 'gray', detail)}\n`);
    });

    for (;;) {
      const answer = await this.ask(`  ${this.hint(`[${defaultIndex + 1}]`)} `);
      if (answer === undefined) return choices[defaultIndex]!.value;

      const normalized = answer.trim().toLowerCase();
      if (normalized.length === 0) return choices[defaultIndex]!.value;

      const byNumber = Number.parseInt(normalized, 10);
      if (Number.isInteger(byNumber) && byNumber >= 1 && byNumber <= choices.length) {
        return choices[byNumber - 1]!.value;
      }

      const byName = choices.find((choice) => choice.value.toLowerCase() === normalized);
      if (byName !== undefined) return byName.value;

      this.write(`${paint(this.theme, 'yellow', `  Enter 1-${choices.length}, or an agent name.`)}\n`);
    }
  }

  async select<T>(question: string, items: ReadonlyArray<SelectItem<T>>, defaultIndex = 0): Promise<T> {
    if (items.length === 0) throw new RelayError('Cannot select from an empty list.', { code: 'BAD_PROMPT' });
    const initial = Math.min(Math.max(defaultIndex, 0), items.length - 1);
    if (!this.interactive) return items[initial]!.value;
    const rawInput = this.input as NodeJS.ReadableStream & { setRawMode?: (enabled: boolean) => void; isTTY?: boolean };
    if (rawInput.isTTY === true && typeof rawInput.setRawMode === 'function') {
      this.close();
      let selected = initial;
      const render = (first: boolean): void => {
        if (!first) this.write(`\x1b[${items.length}A`);
        items.forEach((item, index) => this.write(`${index === selected ? '❯' : ' '} ${item.label}${item.hint === undefined ? '' : `  ${this.hint(item.hint)}`}\x1b[K\n`));
      };
      this.write(`${question}\n`);
      render(true);
      rawInput.setRawMode(true);
      rawInput.resume();
      try {
        return await new Promise<T>((resolve, reject) => {
          const onData = (chunk: Buffer | string): void => {
            const key = chunk.toString();
            if (key === '\u0003') { cleanup(); reject(new RelayError('Cancelled.', { code: 'PROMPT_CANCELLED' })); }
            else if (key === '\r' || key === '\n') { cleanup(); resolve(items[selected]!.value); }
            else if (key === '\x1b[A') { selected = (selected - 1 + items.length) % items.length; render(false); }
            else if (key === '\x1b[B') { selected = (selected + 1) % items.length; render(false); }
          };
          const cleanup = (): void => { rawInput.off('data', onData); };
          rawInput.on('data', onData);
        });
      } finally { rawInput.setRawMode(false); }
    }
    this.write(`${question}\n`);
    items.forEach((item, index) => this.write(`  ${index + 1}) ${item.label}${item.hint === undefined ? '' : ` — ${item.hint}`}\n`));
    for (;;) {
      const answer = await this.ask(`  ${this.hint(`[${initial + 1}]`)} `);
      if (answer === undefined || answer.trim() === '') return items[initial]!.value;
      const chosen = Number.parseInt(answer.trim(), 10);
      if (Number.isInteger(chosen) && chosen >= 1 && chosen <= items.length) return items[chosen - 1]!.value;
      this.write(`${paint(this.theme, 'yellow', `  Enter 1-${items.length}.`)}\n`);
    }
  }

  close(): void {
    this.rl?.close();
    this.rl = undefined;
  }

  private hint(text: string): string {
    return paint(this.theme, 'gray', text);
  }

  private write(text: string): void {
    this.output.write(text);
  }

  /**
   * One question. Returns undefined when input ends — a closed stdin means
   * "take the default", never "hang".
   */
  private async ask(prompt: string): Promise<string | undefined> {
    // A stream that ended before this interface existed will never emit `end`
    // again, so readline would neither answer nor close. That happens whenever
    // a flow hands the terminal to something else and asks again afterwards.
    if (this.inputEnded()) return undefined;

    const rl = this.ensureInterface();

    let resolveClosed: (value: undefined) => void = () => {};
    const onClose = (): void => resolveClosed(undefined);
    const closed = new Promise<undefined>((resolve) => {
      resolveClosed = resolve;
    });
    rl.once('close', onClose);

    try {
      // The question promise is left with a catch of its own: when readline is
      // torn down mid-question it rejects, and that must not surface as an
      // unhandled rejection after the race has already settled.
      const answered = rl.question(prompt).catch(() => undefined);
      const value = await Promise.race([answered, closed]);
      if (this.cancelled) {
        throw new RelayError('Cancelled.', { code: 'PROMPT_CANCELLED' });
      }
      return value;
    } finally {
      rl.off('close', onClose);
    }
  }

  private inputEnded(): boolean {
    return (this.input as { readableEnded?: boolean }).readableEnded === true;
  }

  private ensureInterface(): Interface {
    if (this.rl === undefined) {
      this.rl = createInterface({ input: this.input, output: this.output });
      // Ctrl-C at a prompt abandons setup rather than accepting every default.
      this.rl.on('SIGINT', () => {
        this.cancelled = true;
        this.close();
      });
    }
    return this.rl;
  }
}
