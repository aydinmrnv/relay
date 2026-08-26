import { resolveExecutable, runProcess } from '../process/runner.ts';

/**
 * The desktop notification a finished run raises, per platform: `osascript` on
 * macOS, `notify-send` on Linux, PowerShell on Windows.
 *
 * Windows is the awkward one, because the only way to raise a notification
 * there is to run a script, and Relay never lets text it did not write become
 * code. So the script below is a constant — byte for byte the same whatever
 * the run was called — and the one variable part, the body, reaches it through
 * the environment instead of through the command line.
 * `$env:RELAY_NOTIFY_BODY` is read by PowerShell as a string and is never
 * parsed, so a run whose id or outcome contained `;` or `$(...)` produces a
 * notification with odd-looking text in it, and nothing else.
 */

/**
 * A balloon tip through `NotifyIcon`, which Windows 10 and 11 render as an
 * ordinary toast. The WinRT toast API is the more modern route and the wrong
 * one here: it only shows for a process with a registered AppUserModelID,
 * which a CLI does not have and should not install. The brief sleep is the
 * documented requirement — the tray icon must outlive the call that shows it.
 */
const WINDOWS_NOTIFY_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  'Add-Type -AssemblyName System.Windows.Forms',
  'Add-Type -AssemblyName System.Drawing',
  '$icon = New-Object System.Windows.Forms.NotifyIcon',
  'try { $icon.Icon = [System.Drawing.SystemIcons]::Information;' +
    ' $icon.BalloonTipTitle = "Relay";' +
    ' $icon.BalloonTipText = $env:RELAY_NOTIFY_BODY;' +
    ' $icon.Visible = $true;' +
    ' $icon.ShowBalloonTip(10000);' +
    ' Start-Sleep -Milliseconds 750 }' +
    ' finally { $icon.Dispose() }',
  // One line, joined by `;`: a newline inside a quoted argument survives
  // Node's own quoting but not every layer between here and PowerShell, and
  // there is nothing this script needs a newline for.
].join('; ');

/**
 * PowerShell 5.1 ships with every supported Windows and is tried first; `pwsh`
 * is the fallback for a machine where it has been removed.
 */
const WINDOWS_SHELLS = ['powershell', 'pwsh'] as const;

export async function notifySystem(
  body: string,
  deps: { platform?: NodeJS.Platform; resolve?: typeof resolveExecutable; run?: typeof runProcess } = {},
): Promise<string> {
  const platform = deps.platform ?? process.platform;
  const resolve = deps.resolve ?? resolveExecutable;
  const run = deps.run ?? runProcess;

  if (platform === 'win32') return notifyWindows(body, resolve, run);

  const executable = platform === 'darwin' ? 'osascript' : platform === 'linux' ? 'notify-send' : undefined;
  if (executable === undefined) return 'unsupported platform';
  const resolved = await resolve(executable);
  if (resolved === null) return 'notifier unavailable';
  const args = platform === 'darwin'
    ? ['-e', `display notification "${body.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}" with title "Relay"`]
    : ['Relay', body];
  const result = await run(resolved, args);
  if (!result.ok) throw new Error(`${executable} exited ${result.exitCode ?? result.signal ?? 'unknown'}`);
  return executable;
}

async function notifyWindows(
  body: string,
  resolve: typeof resolveExecutable,
  run: typeof runProcess,
): Promise<string> {
  for (const shell of WINDOWS_SHELLS) {
    const resolved = await resolve(shell);
    if (resolved === null) continue;
    const result = await run(
      resolved,
      // `-NoProfile` so a user's profile cannot change what this script means,
      // and the body is conspicuously not here: it travels in the environment.
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', WINDOWS_NOTIFY_SCRIPT],
      { env: { RELAY_NOTIFY_BODY: body }, timeoutMs: 20_000 },
    );
    if (!result.ok) throw new Error(`${shell} exited ${result.exitCode ?? result.signal ?? 'unknown'}`);
    return shell;
  }
  return 'notifier unavailable';
}
