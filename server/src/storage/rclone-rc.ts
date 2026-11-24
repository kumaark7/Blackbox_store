import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { DriveError } from '../errors.ts';

export interface RcloneControl {
  call(route: string, parameters: Record<string, string>, signal: AbortSignal): Promise<unknown>;
  close?(): Promise<void>;
}

export const rcloneUnavailable = () => new DriveError(503, 'MEGA could not complete the operation. Check rclone and the MEGA connection.');

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
      const timeout = setTimeout(() => { child.kill(); reject(rcloneUnavailable()); }, 15_000);
      timeout.unref();
      child.once('error', () => { clearTimeout(timeout); reject(rcloneUnavailable()); });
      child.once('close', () => { clearTimeout(timeout); reject(rcloneUnavailable()); });
      lines.on('line', (line) => {
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
      try {
        const response = await fetch(address + route, {
          method: 'POST', redirect: 'error', headers: { Authorization: authorization, 'Content-Type': 'application/json' },
          body: JSON.stringify(parameters), signal: AbortSignal.any([signal, AbortSignal.timeout(30 * 60_000)]),
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw rcloneUnavailable();
        }
        return await response.json();
      } catch {
        throw rcloneUnavailable();
      }
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
