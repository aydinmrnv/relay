#!/usr/bin/env node
/**
 * Replays a recorded CLI stream for the harness conformance suite.
 *
 * The scenario comes from RELAY_HARNESS_FIXTURE: a JSON descriptor naming a
 * checked-in stream file (replayed line by line on stdout) plus how the
 * process should end — an exit code, a self-inflicted signal, or a hang.
 * Whatever argv and stdin the harness delivered are written to
 * RELAY_HARNESS_CAPTURE so tests can prove prompts travel on stdin and flags
 * travel on argv.
 *
 * Descriptor fields:
 *   stream       stream file to replay on stdout, relative to the descriptor
 *   stderr       lines to write on stderr
 *   exit         exit code (default 0)
 *   killSelf     signal to kill itself with after replaying, e.g. "SIGKILL"
 *   hang         replay, then never exit (until the harness terminates us)
 *   lastMessage  written to the file named after --output-last-message, when
 *                that flag is present (codex-style CLIs)
 */
import { readFileSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';

const fixturePath = process.env.RELAY_HARNESS_FIXTURE;
if (fixturePath === undefined) {
  writeSync(2, 'fake-cli: RELAY_HARNESS_FIXTURE is not set\n');
  process.exit(97);
}
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  stdin += chunk;
});
process.stdin.on('end', () => {
  const capturePath = process.env.RELAY_HARNESS_CAPTURE;
  if (capturePath !== undefined) {
    writeFileSync(capturePath, JSON.stringify({ argv: process.argv.slice(2), stdin }));
  }

  const lines =
    fixture.stream === undefined
      ? []
      : readFileSync(join(dirname(fixturePath), fixture.stream), 'utf8')
          .split('\n')
          .filter((line) => line.length > 0);
  // writeSync so every line reaches the pipe even when we SIGKILL ourselves.
  for (const line of lines) writeSync(1, `${line}\n`);
  for (const line of fixture.stderr ?? []) writeSync(2, `${line}\n`);

  const flagIndex = process.argv.indexOf('--output-last-message');
  if (fixture.lastMessage !== undefined && flagIndex !== -1 && process.argv[flagIndex + 1] !== undefined) {
    writeFileSync(process.argv[flagIndex + 1], fixture.lastMessage);
  }

  if (fixture.killSelf !== undefined) {
    process.kill(process.pid, fixture.killSelf);
    return;
  }
  if (fixture.hang === true) {
    setInterval(() => {}, 60_000);
    return;
  }
  process.exit(fixture.exit ?? 0);
});
