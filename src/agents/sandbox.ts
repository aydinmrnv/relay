import { resolveExecutable } from '../process/runner.ts';

/**
 * OS-level sandboxing for read-only agent turns.
 *
 * A tool deny list is a policy inside the agent's own process: it holds only as
 * long as that CLI enumerates every path to the filesystem and nothing changes
 * between versions. The operating system does not have that problem. Where the
 * platform offers a sandbox — `sandbox-exec` on macOS, bubblewrap on Linux —
 * every read-only turn of a harness that has no OS sandbox of its own is run
 * under one, with the deny list kept as a second layer. Where the platform
 * offers none, the turn still runs, and the gap is reported rather than hidden:
 * the harness emits a notice and `relay doctor` says which enforcement each
 * harness actually gets.
 *
 * The sandbox denies writes everywhere except the process's own state: its
 * config and cache directories, and the temp directory. The worktree is
 * deliberately *not* writable — that is the point of a read-only turn.
 */

export type SandboxMechanism = 'sandbox-exec' | 'bubblewrap';

export type SandboxAvailability =
  | { available: true; mechanism: SandboxMechanism }
  | { available: false; reason: string };

export interface Invocation {
  command: string;
  args: string[];
}

const PLATFORM_SANDBOXES: Partial<Record<NodeJS.Platform, { binary: string; mechanism: SandboxMechanism }>> = {
  darwin: { binary: 'sandbox-exec', mechanism: 'sandbox-exec' },
  linux: { binary: 'bwrap', mechanism: 'bubblewrap' },
};

/**
 * Whether this machine can wrap a process in an OS sandbox, and with what.
 *
 * `RELAY_NO_OS_SANDBOX=1` is the escape hatch for an environment where the
 * wrapper breaks the CLI underneath it; disabling it is reported like any other
 * absence, never silently.
 */
export async function detectOsSandbox(platform: NodeJS.Platform = process.platform): Promise<SandboxAvailability> {
  if (process.env['RELAY_NO_OS_SANDBOX'] === '1') {
    return { available: false, reason: 'disabled by RELAY_NO_OS_SANDBOX=1' };
  }
  const support = PLATFORM_SANDBOXES[platform];
  if (support === undefined) {
    return { available: false, reason: `no OS sandbox is available on ${platform}` };
  }
  const path = await resolveExecutable(support.binary);
  if (path === null) {
    return { available: false, reason: `${support.binary} was not found on PATH` };
  }
  return { available: true, mechanism: support.mechanism };
}

/**
 * Paths every sandboxed process may write regardless of harness: the temp
 * trees and `/dev`, without which nothing on the platform runs at all.
 */
const MAC_WRITABLE_DEFAULTS = [
  '/dev',
  '/tmp',
  '/private/tmp',
  '/var/tmp',
  '/private/var/tmp',
  '/var/folders',
  '/private/var/folders',
] as const;

/**
 * A Seatbelt (SBPL) profile: allow everything, then deny all file writes, then
 * allow writes back to the declared paths. Network stays open — a read-only
 * turn still has to reach its model — and reads stay open, which is what the
 * turn is for.
 */
export function buildSandboxExecProfile(writablePaths: readonly string[]): string {
  const allows = [...MAC_WRITABLE_DEFAULTS, ...writablePaths].map(
    (path) => `  (subpath "${escapeSbpl(path)}")`,
  );
  return ['(version 1)', '(allow default)', '(deny file-write*)', '(allow file-write*', ...allows, ')'].join('\n');
}

/** SBPL string literals use double quotes; escape the two characters that break them. */
function escapeSbpl(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * The bubblewrap argv prefix: the whole filesystem bound read-only, a fresh
 * `/dev` and `/proc`, a private `/tmp`, and the declared state paths bound
 * writable — `--bind-try`, because a cache directory that does not exist yet is
 * not an error. `--die-with-parent` so a killed turn takes its sandbox with it.
 */
export function buildBubblewrapArgs(writablePaths: readonly string[]): string[] {
  const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--die-with-parent'];
  for (const path of writablePaths) {
    args.push('--bind-try', path, path);
  }
  args.push('--');
  return args;
}

/** Wraps an invocation in the given sandbox. Pure, so tests can assert the argv. */
export function wrapWithOsSandbox(
  mechanism: SandboxMechanism,
  invocation: Invocation,
  writablePaths: readonly string[],
): Invocation {
  if (mechanism === 'sandbox-exec') {
    return {
      command: 'sandbox-exec',
      args: ['-p', buildSandboxExecProfile(writablePaths), invocation.command, ...invocation.args],
    };
  }
  return {
    command: 'bwrap',
    args: [...buildBubblewrapArgs(writablePaths), invocation.command, ...invocation.args],
  };
}

/**
 * Wraps a read-only turn in the platform's OS sandbox, or returns the
 * invocation untouched with the reason it could not — which the harness must
 * surface, because a sandbox that silently is not there is the failure mode
 * this module exists to close.
 */
export async function sandboxReadOnly(
  invocation: Invocation,
  writablePaths: readonly string[],
  platform: NodeJS.Platform = process.platform,
): Promise<{ invocation: Invocation; mechanism?: SandboxMechanism; notice?: string }> {
  const sandbox = await detectOsSandbox(platform);
  if (!sandbox.available) {
    return {
      invocation,
      notice: `read-only turn is not OS-sandboxed (${sandbox.reason}); the tool deny list is the only enforcement`,
    };
  }
  return {
    invocation: wrapWithOsSandbox(sandbox.mechanism, invocation, writablePaths),
    mechanism: sandbox.mechanism,
  };
}
