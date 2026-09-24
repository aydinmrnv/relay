import { spawn } from 'node:child_process';

/**
 * Opens a URL in the default browser, without a shell on any platform.
 *
 * Windows is the one that needs care: `start` is a cmd.exe builtin, and a URL
 * with `&` in it is exactly what cmd.exe re-parses. `rundll32` hands the URL to
 * the shell's protocol handler as one argument instead.
 */
export function browserCommand(url: string, platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
  if (platform === 'darwin') return { command: 'open', args: [url] };
  if (platform === 'win32') return { command: 'rundll32', args: ['url.dll,FileProtocolHandler', url] };
  return { command: 'xdg-open', args: [url] };
}

/** Best effort: resolves false when nothing could be launched, and the caller prints the link instead. */
export function openInBrowser(url: string): Promise<boolean> {
  const { command, args } = browserCommand(url);
  return new Promise((resolve) => {
    try {
      const child = spawn(command, args, { stdio: 'ignore', detached: true, shell: false, windowsHide: true });
      child.once('error', () => resolve(false));
      child.once('spawn', () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}
