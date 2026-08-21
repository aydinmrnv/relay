import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  CHAT_COMMANDS,
  chatCompletions,
  describeChatInput,
  parseChatInput,
  runChatCommand,
  type ChatAction,
} from '../src/cli/chat.ts';
import type { RunOptions } from '../src/cli/commands/run.ts';
import { setTheme } from '../src/cli/output.ts';
import type { Theme } from '../src/ui/theme.ts';
import { ScriptedPrompter } from './helpers/scriptedPrompter.ts';

const PIPED: Theme = { color: false, unicode: true, interactive: false };

beforeEach(() => setTheme(PIPED));
afterEach(() => setTheme(undefined));

/** Runs a command against a scripted terminal, capturing what it printed. */
async function command(
  line: string,
  options: RunOptions = {},
  answers: readonly string[] = [],
): Promise<{ action: ChatAction; options: RunOptions; output: string }> {
  const intent = parseChatInput(line);
  assert.equal(intent.kind, 'command', `"${line}" is not a command`);

  let output = '';
  const original = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    output += chunk.toString();
    return true;
  }) as typeof process.stdout.write;

  try {
    const action = await runChatCommand(intent.name, intent.argument, {
      options,
      prompter: new ScriptedPrompter(answers, true),
    });
    return { action, options, output };
  } finally {
    process.stdout.write = original;
  }
}

describe('what you can type at the prompt', () => {
  it('reads an issue reference in every spelling `relay run` accepts', () => {
    for (const input of ['142', '#142', 'acme/widgets#142', 'https://github.com/acme/widgets/issues/142']) {
      assert.deepEqual(parseChatInput(input), { kind: 'issue', ref: input }, input);
    }
  });

  it('reads a path as a spec file', () => {
    assert.deepEqual(parseChatInput('./spec.md'), { kind: 'file', path: './spec.md' });
    assert.deepEqual(parseChatInput('docs/plan.markdown'), { kind: 'file', path: 'docs/plan.markdown' });
  });

  it('reads a sentence that mentions a path as a task, not as the path', () => {
    // The failure this prevents: "fix the retry in src/net/retry.ts" is a task
    // description, and a slash anywhere in it used to make it a filename that
    // does not exist.
    const sentence = 'the backoff in src/net/retry.ts is linear and should be exponential';
    assert.deepEqual(parseChatInput(sentence), { kind: 'task', text: sentence });
    assert.match(describeChatInput(sentence), /new task/);
  });

  it('reads anything else as the task itself — which is the point', () => {
    assert.deepEqual(parseChatInput('add a dark mode toggle'), {
      kind: 'task',
      text: 'add a dark mode toggle',
    });
    // The failure this prevents: a run that cannot start because nobody has
    // written a ticket for a job that takes one sentence to describe.
    assert.equal(parseChatInput('rename the timeout constant').kind, 'task');
  });

  it('reads a pasted paragraph as one task, whatever its first word looks like', () => {
    const pasted = '142 is the wrong number here\nfix the off-by-one in the pager';
    assert.equal(parseChatInput(pasted).kind, 'task');
  });

  it('leaves on an empty line and on the words for it', () => {
    for (const input of ['', '   ', 'q', 'quit', 'EXIT', ':q']) {
      assert.deepEqual(parseChatInput(input), { kind: 'exit' }, input);
    }
  });

  it('splits a slash command from its argument', () => {
    assert.deepEqual(parseChatInput('/review thorough'), {
      kind: 'command',
      name: 'review',
      argument: 'thorough',
    });
    assert.deepEqual(parseChatInput('/HELP'), { kind: 'command', name: 'help', argument: '' });
  });
});

describe('the caption under the composer', () => {
  it('says which reading it is about to take', () => {
    assert.match(describeChatInput('142'), /issue #142/);
    assert.match(describeChatInput('./spec.md'), /spec file/);
    assert.match(describeChatInput('add a toggle'), /new task/);
    assert.match(describeChatInput('/review'), /how hard the agents look/);
  });

  it('names a command that does not exist before Enter costs anything', () => {
    assert.match(describeChatInput('/reveiw thorough'), /unknown command/);
  });

  it('says nothing about an empty line', () => {
    assert.equal(describeChatInput('   '), '');
  });
});

describe('slash commands', () => {
  it('sets the review level for every run after it', async () => {
    const { action, options } = await command('/review thorough');

    assert.equal(options.review, 'thorough');
    assert.equal(action.kind, 'screen');
  });

  it('drops --fast when a level is chosen, because they are the same dial', async () => {
    const { options } = await command('/review light', { fast: true });

    assert.equal(options.review, 'light');
    assert.equal(options.fast, undefined, 'a run carrying both flags would refuse to start');
  });

  it('offers the levels when asked for none', async () => {
    const prompter = new ScriptedPrompter(['exhaustive'], true);
    const action = await runChatCommand('review', '', { options: {}, prompter });

    assert.match(prompter.asked.join(' '), /How hard should the agents look/);
    assert.equal(action.kind, 'screen');
  });

  it('refuses a level that does not exist, and says which do', async () => {
    const { options, output } = await command('/review paranoid');

    assert.equal(options.review, undefined);
    assert.match(output, /not a review level/);
    assert.match(output, /exhaustive/);
  });

  it('assigns both seats from one line', async () => {
    const { options } = await command('/agents claude codex');

    assert.equal(options.planner, 'claude');
    assert.equal(options.implementer, 'codex');
  });

  it('warns when one agent would end up reviewing its own work', async () => {
    const { output } = await command('/agents claude claude');
    assert.match(output, /reviews its own work/);
  });

  it('refuses an agent that is not registered', async () => {
    const { options, output } = await command('/agents gpt5');

    assert.equal(options.planner, undefined);
    assert.match(output, /not an installed agent/);
  });

  it('sets the delivery policy', async () => {
    const { options } = await command('/deliver pr');
    assert.equal(options.deliver, 'pr');
  });

  it('toggles raw agent events rather than only turning them on', async () => {
    const options: RunOptions = {};
    await command('/verbose', options);
    assert.equal(options.verbose, true);
    await command('/verbose', options);
    assert.equal(options.verbose, false);
  });

  it('asks the loop to start a run for the two commands that are a run', async () => {
    assert.deepEqual((await command('/issues')).action, { kind: 'run' });
    assert.deepEqual((await command('/editor')).action, { kind: 'run', options: { editor: true } });
  });

  it('leaves on /exit, /quit and /q alike', async () => {
    for (const line of ['/exit', '/quit', '/q']) {
      assert.deepEqual((await command(line)).action, { kind: 'exit' }, line);
    }
  });

  it('says so when a command does not exist, instead of starting a run', async () => {
    const { action, output } = await command('/nope');

    assert.deepEqual(action, { kind: 'prompt' });
    assert.match(output, /is not a command/);
    assert.match(output, /\/help/);
  });

  it('lists every command in /help, so the list cannot drift from the commands', async () => {
    const { output } = await command('/help');
    for (const entry of CHAT_COMMANDS) assert.match(output, new RegExp(`/${entry.name}`), entry.name);
  });

  it('offers every command to Tab', () => {
    assert.deepEqual(chatCompletions(), CHAT_COMMANDS.map((entry) => `/${entry.name}`));
  });
});
