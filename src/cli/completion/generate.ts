import type { Command } from 'commander';

import { commandFlags, EMPTY_WORD, subcommandNames } from './complete.ts';

/**
 * The shells `relay completion` can write a script for. PowerShell is here
 * because on Windows none of the other three is the shell the user is in.
 */
export const COMPLETION_SHELLS = ['bash', 'zsh', 'fish', 'powershell'] as const;

export type CompletionShell = (typeof COMPLETION_SHELLS)[number];

function commands(program: Command): string {
  return subcommandNames(program).join(' ');
}

/**
 * Everything the first word can be: a command, or one of the root's own flags.
 * It is the one list written into the scripts, because it is the one question
 * that can be answered without starting Relay — and `relay --<TAB>` is a first
 * word too.
 */
function firstWords(program: Command): string {
  return [...subcommandNames(program), ...commandFlags(program).filter((flag) => flag.startsWith('--'))].join(' ');
}

export function generateCompletion(program: Command, shell: CompletionShell): string {
  const names = commands(program);
  const first = firstWords(program);
  if (shell === 'bash') return `# bash completion for relay
_relay() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  if (( COMP_CWORD == 1 )); then COMPREPLY=( $(compgen -W '${first}' -- "$cur") ); return; fi
  local values
  values=$(command relay __complete "\${COMP_WORDS[@]:1:COMP_CWORD}") || values=
  COMPREPLY=( $(compgen -W "$values" -- "$cur") )
}
complete -F _relay relay
`;
  // The words are passed as a quoted array, `"${(@)words[2,CURRENT]}"`, and not
  // bare: unquoted, zsh drops every empty element, and the word under the
  // cursor is empty whenever it is a fresh one. Dropped, `relay status <TAB>`
  // arrives as `relay status` and asks for runs named "status" — so nothing
  // was ever offered for a word not yet started, which is the case with the
  // most to offer.
  if (shell === 'zsh') return `#compdef relay
_relay() {
  local -a values
  if (( CURRENT == 2 )); then
    values=(${first}); compadd -- \${values[@]}; return
  fi
  values=(\${(f)"$(command relay __complete "\${(@)words[2,CURRENT]}")"})
  compadd -- \${values[@]}
}
compdef _relay relay
`;
  if (shell === 'fish') return `# fish completion for relay
complete -c relay -f
complete -c relay -n 'not __fish_seen_subcommand_from ${names}' -a '${names}'
complete -c relay -n '__fish_seen_subcommand_from ${names}' -a '(command relay __complete (commandline -opc | string escape)[2..] (commandline -ct | string escape))'
`;

  // PowerShell completes a native command through one script block. The words
  // handed to `relay __complete` are the command line minus `relay` itself,
  // ending with the word being typed — which `CommandElements` already carries
  // when there is one, and which is `EMPTY_WORD` when the cursor is on a fresh
  // word, because an empty argument would not survive the trip to a native
  // command here. The filter is `StartsWith` rather than `-like`, which would
  // read a `[` in a branch name as a wildcard.
  return `# PowerShell completion for relay
Register-ArgumentCompleter -Native -CommandName relay -ScriptBlock {
    param($wordToComplete, $commandAst, $cursorPosition)
    $words = @($commandAst.CommandElements | Select-Object -Skip 1 | ForEach-Object { $_.ToString() })
    if (-not $wordToComplete) { $words += '${EMPTY_WORD}' }
    if ($words.Count -le 1) {
        $values = '${first}'.Split(' ')
    } else {
        $values = @(& relay __complete @words 2>$null)
    }
    $prefix = [string]$wordToComplete
    $values | Where-Object { $_.StartsWith($prefix) } | ForEach-Object {
        [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
    }
}
`;
}
