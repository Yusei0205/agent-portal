import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { parseSnapshot, type WorkspaceSnapshot } from './runner-snapshot.ts';
import { terminalGrantVerifier } from './runner-terminal-auth.ts';

interface PtyProcess {
  write(data: string): void; resize(cols: number, rows: number): void; kill(): void;
  onData(callback: (data: string) => void): void;
  onExit(callback: (event: { exitCode: number }) => void): void;
}
interface Pty { spawn(file: string, args: string[], options: { cwd: string; env: Record<string, string>; name: string; cols: number; rows: number }): PtyProcess }
type Ticket = { expires: number; origin: string; snapshot: WorkspaceSnapshot; workflowId: string };
export interface RunnerTerminalOptions {
  engine: 'codex' | 'kiro' | 'claude-code';
  prepare(snapshot: WorkspaceSnapshot, status: (text: string) => void): Promise<string>;
  save(snapshot: WorkspaceSnapshot): Promise<void>;
  loadPty?: () => Promise<Pty | null>;
  idleMs?: number;
  verifyGrant?: (body: Record<string, unknown>) => Promise<{ nonce: string; expires: number }>;
}
const safeEnv = (home: string): Record<string, string> => ({
  PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: home, USERPROFILE: home,
  ...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}),
  TEMP: os.tmpdir(), TMP: os.tmpdir(), TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'C.UTF-8',
});
async function shellDirectory(root: string): Promise<string> {
  try {
    const repos = (await fs.readdir(path.join(root, 'repos'), { withFileTypes: true })).filter(entry => entry.isDirectory());
    if (repos.length === 1) return path.join(root, 'repos', repos[0].name);
  } catch { /* a session can start with an empty workspace */ }
  return root;
}

/** IAM control requests mint one-use tickets; a socket alone never grants a shell. */
export function createRunnerTerminal(options: RunnerTerminalOptions) {
  const tickets = new Map<string, Ticket>();
  const issued = new Map<string, number>();
  const verifyGrant = options.verifyGrant ?? terminalGrantVerifier(process.env.PORTAL_TERMINAL_ISSUER_URL, options.engine);
  const sockets = new Set<WebSocket>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 32_768 });
  let saving = 0;
  let preparing = 0;
  let preparations: Promise<unknown> = Promise.resolve();
  let workflow: string | null = null;
  let ptyPromise: Promise<Pty | null> | undefined;
  const loadPty = () => ptyPromise ??= (options.loadPty ? options.loadPty() : (async () => {
    try {
      const mod = await Function('m', 'return import(m)')('@lydell/node-pty');
      return typeof mod.spawn === 'function' ? mod as Pty : mod.default as Pty;
    } catch { return null; }
  })());

  async function issue(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const snapshot = parseSnapshot(body.snapshot);
    if (typeof body.workflowId !== 'string' || !/^[a-zA-Z0-9_-]{1,256}$/.test(body.workflowId)
      || !snapshot || typeof body.origin !== 'string' || !/^https?:\/\/[^/]+$/.test(body.origin)) throw new Error('Invalid terminal ticket request');
    if (workflow && workflow !== body.workflowId) throw new Error('This terminal belongs to another session');
    const grant = await verifyGrant(body);
    if (workflow && workflow !== body.workflowId) throw new Error('This terminal belongs to another session');
    workflow = body.workflowId;
    for (const [key, ticket] of tickets) if (ticket.expires <= Date.now()) tickets.delete(key);
    for (const [key, expiry] of issued) if (expiry <= Date.now()) issued.delete(key);
    if (sockets.size >= 3) throw new Error('Close another terminal before opening one more');
    if (tickets.size >= 20) throw new Error('Too many connection attempts; wait a minute and reconnect');
    const ticket = grant.nonce;
    if (issued.has(ticket)) throw new Error('Terminal grant has already been used');
    issued.set(ticket, grant.expires);
    tickets.set(ticket, { snapshot, workflowId: body.workflowId, origin: body.origin, expires: grant.expires });
    return { type: 'terminal-ticket', ticket };
  }

  wss.on('connection', (ws, req) => {
    let ticket: Ticket | undefined;
    let proc: { write(data: string): void; resize(cols: number, rows: number): void; kill(): void } | undefined;
    let closed = false;
    let processClosed = Promise.resolve();
    let finishProcess = () => {};
    let cols = 80, rows = 24;
    let idle: ReturnType<typeof setTimeout>;
    const send = (value: object) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(value)); };
    let pendingOutput = Buffer.alloc(0);
    let exited: number | undefined;
    const outputTimer = setInterval(() => {
      if (pendingOutput.length) {
        send({ type: 'output', data: pendingOutput.subarray(0, 12_000).toString('base64') });
        pendingOutput = pendingOutput.subarray(12_000);
      } else if (exited !== undefined) {
        send({ type: 'exit', code: exited }); ws.close(1000, 'Shell exited');
      }
    }, 10);
    outputTimer.unref();
    const shellExit = (code: number) => { finishProcess(); exited = code; };
    const output = (data: Buffer) => {
      if (closed) return;
      if (!closed && ticket && data.length) resetIdle();
      if (ws.bufferedAmount + pendingOutput.length + data.length > 2 * 1024 * 1024) { ws.close(1009, 'Terminal output buffer exceeded'); return; }
      pendingOutput = Buffer.concat([pendingOutput, data]);
    };
    const resetIdle = () => { clearTimeout(idle); idle = setTimeout(() => { send({ type: 'error', message: 'Terminal timed out due to inactivity' }); ws.close(4000, 'Idle timeout'); }, options.idleMs ?? 10 * 60_000); idle.unref(); };
    const handshake = setTimeout(() => ws.close(1008, 'Terminal ticket required'), 5000); handshake.unref();
    const lifetime = setTimeout(() => ws.close(4000, 'Terminal session limit reached'), 60 * 60_000); lifetime.unref();
    ws.on('error', () => {});
    ws.on('message', async raw => {
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { ws.close(1008, 'Invalid terminal message'); return; }
      if (!ticket) {
        const candidate = typeof msg?.ticket === 'string' ? tickets.get(msg.ticket) : undefined;
        if (msg?.type !== 'start' || !candidate || candidate.expires <= Date.now()
          || sockets.size >= 3 || (req.headers.origin && req.headers.origin !== candidate.origin)) { ws.close(1008, 'Invalid or expired terminal ticket'); return; }
        tickets.delete(msg.ticket); ticket = candidate; clearTimeout(handshake); sockets.add(ws); resetIdle();
        cols = Math.min(500, Math.max(20, Math.trunc(Number(msg.cols) || 80)));
        rows = Math.min(200, Math.max(5, Math.trunc(Number(msg.rows) || 24)));
        preparing++;
        try {
          const prepared = preparations.then(() => options.prepare(ticket!.snapshot, text => send({ type: 'status', text })));
          preparations = prepared.catch(() => {});
          const root = await prepared;
          if (ticket.snapshot.getUrl && !(await fs.readdir(path.join(root, 'repos')).catch(() => [])).length) throw new Error('Saved repositories could not be restored');
          const cwd = await shellDirectory(root);
          if (closed) return;
          const home = path.join(os.tmpdir(), 'portal-terminal-home'); await fs.mkdir(home, { recursive: true, mode: 0o700 });
          let pty = await loadPty();
          if (closed) return;
          const shell = process.platform === 'win32' ? 'powershell.exe' : '/bin/bash';
          processClosed = new Promise(resolve => { finishProcess = resolve; });
          if (pty) {
            try {
              const p = pty.spawn(shell, process.platform === 'win32' ? ['-NoLogo', '-NoProfile'] : ['--noprofile', '--norc', '-i'], { cwd, env: safeEnv(home), name: 'xterm-256color', cols, rows });
              proc = p; p.onData(data => output(Buffer.from(data))); p.onExit(({ exitCode }) => shellExit(exitCode));
            } catch { pty = null; }
          }
          if (!proc) {
            const child = spawn(shell, process.platform === 'win32' ? ['-NoLogo', '-NoProfile', '-Command', '-'] : ['--noprofile', '--norc'], { cwd, env: safeEnv(home), stdio: 'pipe', windowsHide: true, detached: process.platform !== 'win32' });
            proc = { write: data => { child.stdin.write(data); }, resize: () => {}, kill: () => {
              if (process.platform !== 'win32' && child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ } }
              else child.kill('SIGKILL');
            } };
            child.stdout.on('data', output); child.stderr.on('data', output); child.stdin.on('error', () => {});
            child.on('error', () => { finishProcess(); send({ type: 'error', message: 'Could not start the terminal shell' }); ws.close(1011, 'Shell failed'); });
            child.on('close', code => shellExit(code ?? 1));
          }
          send({ type: 'ready', pty: Boolean(pty), cols, rows, shell });
        } catch { send({ type: 'error', message: 'Could not restore or open the session workspace' }); ws.close(1011, 'Workspace unavailable'); }
        finally { preparing--; }
        return;
      }
      if (msg?.type === 'ping') { send({ type: 'pong' }); return; }
      resetIdle();
      try {
        if (msg?.type === 'input' && typeof msg.data === 'string' && msg.data.length <= 24_000) proc?.write(Buffer.from(msg.data, 'base64').toString('utf8'));
        if (msg?.type === 'resize' && Number.isInteger(msg.cols) && Number.isInteger(msg.rows)) proc?.resize(Math.min(500, Math.max(20, msg.cols)), Math.min(200, Math.max(5, msg.rows)));
      } catch { ws.close(1011, 'Terminal shell closed'); }
    });
    ws.on('close', () => {
      closed = true; clearInterval(outputTimer); pendingOutput = Buffer.alloc(0); clearTimeout(handshake); clearTimeout(lifetime); clearTimeout(idle); sockets.delete(ws);
      try { proc?.kill(); } catch { /* process already exited */ }
      if (ticket && proc) {
        saving++;
        void (async () => {
          let timeout: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([processClosed, new Promise<void>((_, reject) => { timeout = setTimeout(() => reject(new Error('Shell did not close')), 5000); })]);
            await options.save(ticket!.snapshot);
          } finally { clearTimeout(timeout); }
        })().catch(() => { console.error('[terminal] Workspace save failed'); }).finally(() => { saving--; });
      }
    });
  });
  return {
    issue,
    busy: () => sockets.size > 0 || saving > 0 || preparing > 0,
    preparing: () => preparing > 0,
    attach(server: http.Server) {
      server.on('upgrade', (req, socket, head) => {
        if (req.url?.split('?')[0] !== '/ws') { socket.destroy(); return; }
        wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
      });
      server.on('close', () => { for (const ws of sockets) ws.terminate(); wss.close(); });
    },
  };
}
