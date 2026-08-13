import { buildProgram } from './cli/program.ts';
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
  reportError(error);
  process.exitCode = 1;
});
