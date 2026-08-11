import { buildProgram } from './cli/program.ts';
import { reportError } from './cli/output.ts';

async function main(): Promise<void> {
  const program = buildProgram();
  await program.parseAsync(process.argv);
}

main().catch((error: unknown) => {
  reportError(error);
  process.exitCode = 1;
});
