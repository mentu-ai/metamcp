import { execFile } from 'node:child_process';
import { win32 } from 'node:path';

export class InvalidAuthorizationUrlError extends Error {}

/** Reject OS handlers and insecure remote endpoints before any launch or manual output. */
export function authorizationUrlString(input: URL): string {
  const url = new URL(input.href);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username || url.password || url.hash) {
    throw new InvalidAuthorizationUrlError(
      'Invalid OAuth authorization URL: require HTTPS (or loopback HTTP), without userinfo or fragment',
    );
  }
  return url.href;
}

/** Fixed launchers, no URL-derived shell source, bounded and asynchronous. */
export async function openAuthorizationBrowser(input: URL): Promise<void> {
  const url = authorizationUrlString(input);
  const env = { ...process.env };
  if (env.SSH_CONNECTION || env.SSH_TTY) throw new Error('Manual authorization required over SSH');
  let file: string;
  let args: string[];
  switch (process.platform) {
    case 'darwin':
      file = '/usr/bin/open';
      args = [url];
      break;
    case 'linux':
      if (!env.DISPLAY && !env.WAYLAND_DISPLAY) throw new Error('No desktop browser available');
      file = 'xdg-open';
      args = [url];
      break;
    case 'win32':
      file = win32.join(env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows',
        'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      // PowerShell receives fixed source. The URL is an environment value, never
      // interpolated source or cmd.exe/start syntax (whose quoting is unsafe).
      for (const key of Object.keys(env)) {
        if (key.toUpperCase() === 'METAMCP_AUTHORIZATION_URL') delete env[key];
      }
      env.METAMCP_AUTHORIZATION_URL = url;
      args = ['-NoProfile', '-NonInteractive', '-Command',
        'Start-Process -FilePath $env:METAMCP_AUTHORIZATION_URL -ErrorAction Stop'];
      break;
    default:
      throw new Error('No supported browser launcher');
  }
  await new Promise<void>((resolve, reject) => {
    execFile(file, args, { shell: false, timeout: 10_000, killSignal: 'SIGKILL', maxBuffer: 16_384, windowsHide: true, env },
      error => { if (error) reject(error); else resolve(); });
  });
}
