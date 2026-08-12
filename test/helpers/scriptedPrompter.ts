import assert from 'node:assert/strict';

import type { Choice, PromptSession } from '../../src/ui/prompt.ts';

/**
 * A terminal that answers from a script. The real `Prompter` is covered by its
 * own tests against a stream; what matters in a flow test is the flow: which
 * questions it asks, in what order, and what the answers produce.
 *
 * An exhausted script takes the default, which is the same thing pressing Enter
 * does — so a flow that asks more than the test scripted still completes.
 */
export class ScriptedPrompter implements PromptSession {
  readonly interactive: boolean;
  readonly asked: string[] = [];
  readonly offered: string[][] = [];
  closed = false;

  private readonly answers: string[];
  private index = 0;

  constructor(answers: readonly string[], interactive = true) {
    this.answers = [...answers];
    this.interactive = interactive;
  }

  private next(): string | undefined {
    if (this.index >= this.answers.length) return undefined;
    const answer = this.answers[this.index];
    this.index += 1;
    return answer === '' ? undefined : answer;
  }

  async text(question: string, defaultValue: string, validate?: (value: string) => string | undefined): Promise<string> {
    this.asked.push(question);
    if (!this.interactive) return defaultValue;

    const value = this.next() ?? defaultValue;
    // The real prompter re-asks; a script that fails validation is a test bug.
    const problem = validate?.(value);
    assert.equal(problem, undefined, `scripted answer "${value}" for "${question}" is invalid: ${problem ?? ''}`);
    return value;
  }

  async confirm(question: string, defaultValue: boolean): Promise<boolean> {
    this.asked.push(question);
    if (!this.interactive) return defaultValue;

    const answer = this.next();
    if (answer === undefined) return defaultValue;
    return answer.toLowerCase().startsWith('y');
  }

  async choice<T extends string>(question: string, choices: ReadonlyArray<Choice<T>>, defaultValue: T): Promise<T> {
    this.asked.push(question);
    this.offered.push(choices.map((choice) => choice.value));
    if (!this.interactive) return defaultValue;

    const answer = this.next();
    if (answer === undefined) return defaultValue;

    const match = choices.find((choice) => choice.value === answer);
    assert.ok(match !== undefined, `scripted answer "${answer}" is not one of ${choices.map((c) => c.value).join(', ')}`);
    return match.value;
  }

  close(): void {
    this.closed = true;
  }
}
