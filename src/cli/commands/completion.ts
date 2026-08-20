import type { Command } from 'commander';
import { EXIT } from '../exit.ts';
import { generateCompletion, type CompletionShell } from '../completion/generate.ts';

export const COMPLETION_HELP = `Print a shell completion script to stdout.

Install it with one of:
  relay completion zsh > "\${fpath[1]}/_relay"
  relay completion bash > /usr/local/etc/bash_completion.d/relay
  relay completion fish > ~/.config/fish/completions/relay.fish`;

export async function completionCommand(program: Command, shell: string): Promise<number> {
  if (!['bash', 'zsh', 'fish'].includes(shell)) {
    program.error(`error: unsupported shell '${shell}' (choose bash, zsh, or fish)`, {
      code: 'commander.invalidArgument',
    });
  }
  process.stdout.write(generateCompletion(program, shell as CompletionShell));
  return EXIT.success;
}
