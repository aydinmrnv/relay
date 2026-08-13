import { buildProgram } from './cli/program.ts';
import { exitCodeFor, isCommanderError } from './cli/exit.ts';
import { reportError } from './cli/output.ts';
import { packageVersion } from './update/installation.ts';

async function main(): Promise<void> {
  let version = 'unknown';
  try {
    version = await packageVersion();
  } catch {
    // A damaged installation should still be able to print help and diagnostics.
  }
  const program = buildProgram(version);
  await program.parseAsync(process.argv);
}

main().catch((error: unknown) => {
  // Commander unwinds by throwing rather than exiting the process itself, so
  // this is the path `--help`, `--version` and every usage error take. It has
  // already printed whatever it had to say.
  if (!isCommanderError(error)) reportError(error);
  process.exitCode = exitCodeFor(error);
});
