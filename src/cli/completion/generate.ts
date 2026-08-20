import type { Command } from 'commander';

export type CompletionShell = 'bash' | 'zsh' | 'fish';

function commands(program: Command): string {
  return program.commands
    .filter((command) => !command.name().startsWith('__'))
    .flatMap((command) => [command.name(), ...command.aliases()])
    .join(' ');
}

export function generateCompletion(program: Command, shell: CompletionShell): string {
  const names = commands(program);
  if (shell === 'bash') return `# bash completion for relay
_relay() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  if (( COMP_CWORD == 1 )); then COMPREPLY=( $(compgen -W '${names}' -- "$cur") ); return; fi
  local values
  values=$(command relay __complete "\${COMP_WORDS[@]:1:COMP_CWORD}") || values=
  COMPREPLY=( $(compgen -W "$values" -- "$cur") )
}
complete -F _relay relay
`;
  if (shell === 'zsh') return `#compdef relay
_relay() {
  local -a values
  if (( CURRENT == 2 )); then
    values=(${names}); _describe 'command' values; return
  fi
  values=(\${(f)"$(command relay __complete \${words[2,CURRENT]})"})
  compadd -- \${values[@]}
}
compdef _relay relay
`;
  return `# fish completion for relay
complete -c relay -f
complete -c relay -n 'not __fish_seen_subcommand_from ${names}' -a '${names}'
complete -c relay -n '__fish_seen_subcommand_from ${names}' -a '(command relay __complete (commandline -opc | string escape)[2..] (commandline -ct | string escape))'
`;
}
