import { spawn } from 'node:child_process';

import { RelayError } from '../util/errors.ts';

export interface InteractiveResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** True only for a clean `exit 0`. */
  ok: boolean;
}

/**
 * Runs a command with the terminal handed straight to it — stdio is inherited,
 * never piped.
 *
 * That is the guarantee, not a convenience. A vendor login flow needs a real
 * TTY to open a browser from or to paste a device code into, and inheriting
 * means those bytes travel between the user and the vendor's own CLI without
 * passing through Relay. Nothing here captures, parses, logs or stores a single
 * character of the exchange, so there is no place a credential could be read
 * even by accident.
 */
export async function runInteractive(
  command: string,
  args: readonly string[],
  options: { cwd?: string } = {},
): Promise<InteractiveResult> {
  const child = spawn(command, [...args], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    stdio: 'inherit',
    shell: false,
    windowsHide: true,
  });

  // While the child owns the terminal, Ctrl-C is the user abandoning the login,
  // not the user abandoning onboarding. The child gets the signal from the
  // terminal anyway; swallowing it here keeps Relay alive to carry on.
  const ignoreInterrupt = (): void => {};
  process.on('SIGINT', ignoreInterrupt);

  try {
    const { exitCode, signalName } = await new Promise<{
      exitCode: number | null;
      signalName: NodeJS.Signals | null;
    }>((resolve, reject) => {
      child.on('error', (error: NodeJS.ErrnoException) => {
        reject(
          error.code === 'ENOENT'
            ? new RelayError(`Executable not found: ${command}`, {
                code: 'EXECUTABLE_NOT_FOUND',
                hint: `Install ${command} and make sure it is on your PATH.`,
                cause: error,
              })
            : new RelayError(`Failed to start ${command}: ${error.message}`, { code: 'SPAWN_FAILED', cause: error }),
        );
      });
      child.on('close', (code, sig) => resolve({ exitCode: code, signalName: sig }));
    });

    return { exitCode, signal: signalName, ok: exitCode === 0 };
  } finally {
    process.off('SIGINT', ignoreInterrupt);
  }
}
