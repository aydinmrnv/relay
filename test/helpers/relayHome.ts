import { after, before } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Points `RELAY_HOME` at an empty directory for the length of a test file.
 *
 * The shipped Codex harness asks Relay's own home whether a ChatGPT sign-in is
 * saved there before every turn. A suite that runs that harness must not find
 * the developer's: the argv it asserts on would change with who ran the tests,
 * and a real token would be handed to a fixture player.
 */
export function isolateRelayHome(): void {
  let home: string | undefined;
  let previous: string | undefined;
  before(async () => {
    previous = process.env['RELAY_HOME'];
    home = await mkdtemp(join(tmpdir(), 'relay-home-test-'));
    process.env['RELAY_HOME'] = home;
  });
  after(async () => {
    if (previous === undefined) delete process.env['RELAY_HOME'];
    else process.env['RELAY_HOME'] = previous;
    if (home !== undefined) await rm(home, { recursive: true, force: true });
  });
}
