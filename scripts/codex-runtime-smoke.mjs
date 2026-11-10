// Packaging check only: uses an empty temporary Codex home, never a real user's login or model quota.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const home = await mkdtemp(path.join(os.tmpdir(), 'portal-codex-runtime-'));
let child;
try {
  const env = { ...process.env, CODEX_HOME: home };
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'ACCESS_TOKEN']) delete env[key];
  child = spawn(process.env.PORTAL_CODEX_BIN || 'codex', ['app-server', '-c', 'cli_auth_credentials_store="file"'], {
    env, stdio: 'pipe', shell: false, windowsHide: true,
  });
  const lines = createInterface({ input: child.stdout });
  child.stderr.resume();
  const send = message => child.stdin.write(JSON.stringify(message) + '\n');
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Codex runtime handshake timed out')), 20_000);
    const done = error => { clearTimeout(timer); error ? reject(error) : resolve(); };
    child.on('error', () => done(new Error('Codex executable could not be launched')));
    child.on('exit', code => done(new Error('Codex exited before handshake: ' + code)));
    child.stdin.on('error', () => done(new Error('Codex stdin closed')));
    lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { done(new Error('Invalid Codex response')); return; }
      if (message.error) { done(new Error('Codex rejected runtime handshake')); return; }
      if (message.id === 1) {
        send({ method: 'initialized', params: {} });
        send({ id: 2, method: 'account/read', params: { refreshToken: false } });
      } else if (message.id === 2) {
        if (message.result?.account) done(new Error('Packaging check must not use an authenticated account'));
        else done();
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'agent_portal_runtime_check', version: '1' } } });
  });
  console.log('Codex runtime OK: initialize and account/read passed in an isolated, signed-out home.');
  lines.close();
} finally {
  if (child && child.exitCode == null) {
    const closed = new Promise(resolve => child.once('close', resolve));
    child.kill();
    await closed;
  }
  if (path.dirname(home) !== path.resolve(os.tmpdir()) || !path.basename(home).startsWith('portal-codex-runtime-')) throw new Error('Unexpected temporary home');
  await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
