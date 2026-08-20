import { resolveExecutable, runProcess } from '../process/runner.ts';

export async function notifySystem(body: string, deps: { platform?: NodeJS.Platform; resolve?: typeof resolveExecutable; run?: typeof runProcess } = {}): Promise<string> {
  const platform = deps.platform ?? process.platform;
  const executable = platform === 'darwin' ? 'osascript' : platform === 'linux' ? 'notify-send' : undefined;
  if (executable === undefined) return 'unsupported platform';
  const resolved = await (deps.resolve ?? resolveExecutable)(executable);
  if (resolved === null) return 'notifier unavailable';
  const args = platform === 'darwin'
    ? ['-e', `display notification "${body.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}" with title "Relay"`]
    : ['Relay', body];
  const result = await (deps.run ?? runProcess)(resolved, args);
  if (!result.ok) throw new Error(`${executable} exited ${result.exitCode ?? result.signal ?? 'unknown'}`);
  return executable;
}
