import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { DriveError } from '../errors.ts';

export interface RcloneControl {
  call(route: string, parameters: Record<string, string>, signal: AbortSignal): Promise<unknown>;
  close?(): Promise<void>;
}

export const rcloneUnavailable = () => new DriveError(503, 'MEGA could not complete the operation. Check rclone and the MEGA connection.');

export async function rcloneOperationError(response: Response, route: string) {
  const body: unknown = await response.json().catch(() => null);
  const message = body && typeof body === 'object' && 'error' in body && typeof body.error === 'string' ? body.error : '';
  if (/(?:^|:\s*)(?:user blocked|EBLOCKED)\.?$/i.test(message.trim())) {
    return new DriveError(503, 'MEGA reports that this account is blocked. Sign in on MEGA to check the account status, then reconnect it in Blackbox.');
  }
  if (/(?:^|:\s*)multi-factor authentication required\.?$/i.test(message.trim())) {
    return new DriveError(503, 'MEGA requires a two-factor authentication code. This Blackbox connection form currently accepts an email and password.');
  }
  if (route === 'operations/mkdir') {
    return new DriveError(503, 'rclone could not sign in to MEGA or open the selected folder. Check the MEGA connection and whether two-factor authentication is enabled.');
  }
  return rcloneUnavailable();
}

export function rcloneControl(executable: string, configPath?: string, configEnv: NodeJS.ProcessEnv = {}): RcloneControl {
  const password = randomBytes(32).toString('base64url');
  const authorization = 'Basic ' + Buffer.from('blackbox-store:' + password).toString('base64');
  let session: ReturnType<typeof launch> | undefined;
  let shuttingDown = false;

  function launch() {
    const args = ['rcd', '--rc-addr=127.0.0.1:0', '--rc-no-auth=false', '--rc-serve=false', '--rc-web-gui=false',
      '--ask-password=false', '--dry-run=false', '--interactive=false', '--mega-use-https', '--mega-hard-delete',
      '--fs-cache-expire-duration=24h', '--use-json-log=false', '--log-level=NOTICE', '--log-file='];
    if (configPath) args.push('--config', configPath);
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, ...configEnv, RCLONE_RC_USER: 'blackbox-store', RCLONE_RC_PASS: password } });
    const lines = createInterface({ input: child.stderr });
    const afterExit = new Promise<void>((done) => child.once('close', () => {
      session = undefined;
      lines.close();
      done();
    }));
    const url = new Promise<string>((resolve, reject) => {
      const unsupported = new DriveError(503, 'The rclone version on the Blackbox server does not support the required MEGA options.');
      const startupFailed = new DriveError(503, 'Blackbox could not start its local rclone service. Check the rclone executable and server configuration.');
      const timeout = setTimeout(() => { child.kill(); reject(startupFailed); }, 15_000);
      timeout.unref();
      child.once('error', () => { clearTimeout(timeout); reject(startupFailed); });
      child.once('close', () => { clearTimeout(timeout); reject(startupFailed); });
      lines.on('line', (line) => {
        if (/unknown flag:/i.test(line)) {
          clearTimeout(timeout);
          reject(unsupported);
          return;
        }
        const port = line.match(/Serving remote control on http:\/\/127\.0\.0\.1:(\d{1,5})\//)?.[1];
        if (!port || Number(port) <= 0 || Number(port) > 65535) return;
        clearTimeout(timeout);
        resolve('http://127.0.0.1:' + port + '/');
      });
    });
    return { child, url, afterExit };
  }

  return {
    async call(route, parameters, signal) {
      signal.throwIfAborted();
      if (shuttingDown) throw rcloneUnavailable();
      session ??= launch();
      const address = await session.url;
      const response = await fetch(address + route, {
          method: 'POST', redirect: 'error', headers: { Authorization: authorization, 'Content-Type': 'application/json' },
          body: JSON.stringify(parameters), signal: AbortSignal.any([signal, AbortSignal.timeout(30 * 60_000)]),
      }).catch(() => { throw new DriveError(503, 'Blackbox could not reach its local rclone service.'); });
      if (response.status === 401) {
        await response.body?.cancel();
        throw new DriveError(503, 'The local rclone service rejected Blackbox’s authentication.');
      }
      if (!response.ok) {
        throw await rcloneOperationError(response, route);
      }
      return await response.json().catch(() => { throw rcloneUnavailable(); });
    },
    async close() {
      shuttingDown = true;
      const current = session;
      if (!current) return;
      current.child.kill();
      await current.afterExit;
    },
  };
}
