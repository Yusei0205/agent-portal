/**
 * One Cursor CLI turn: start `agent`, send the prompt on stdin, stream its stdout through the stream-json parser,
 * stop it on abort. Shared by the local engine (cursor.ts) and the AgentCore runner (cursor-runner/), so the two
 * behave the same. Pure of portal state: the caller records the session id, usage and result.
 */

import { spawnCursor } from '../cursor-cmd.ts';
import { createCursorStreamReader, newCursorStreamState, type CursorEmit, type CursorStreamState } from './cursor-stream.ts';

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,99}$/;

export class CursorArgError extends Error {}

export interface CursorArgOptions {
  trusted: boolean;
  model: string | null;
  resumeId: string | null;
  /** Approve the project's MCP servers (.cursor/mcp.json) without asking: needed headless, or they are "not loaded". */
  approveMcps?: boolean;
}

/** Command-line flags for a turn. The prompt is never one of them. Ids must start with a letter or digit so one cannot be read as a flag. */
export function cursorArgs(opts: CursorArgOptions): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--stream-partial-output', '--trust'];
  if (opts.trusted) args.push('--force');
  if (opts.approveMcps) args.push('--approve-mcps');
  if (opts.model) {
    if (!MODEL_ID.test(opts.model)) throw new CursorArgError(`Invalid Cursor model id "${opts.model}".`);
    args.push('--model', opts.model);
  }
  if (opts.resumeId) {
    if (!SESSION_ID.test(opts.resumeId)) throw new CursorArgError('Invalid Cursor session id.');
    args.push('--resume', opts.resumeId);
  }
  return args;
}

export interface CursorTurnResult {
  state: CursorStreamState;
  exitCode: number | null;
  spawnError: Error | null;
  stderrTail: string;
}

export interface CursorTurnOptions {
  args: string[];
  prompt: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  emit: CursorEmit;
  signal?: AbortSignal | null;
  /** Called when the CLI first reports its session id. */
  onSession?: (id: string) => void;
  /** A status line is emitted when nothing arrived for this long (default 30 s). */
  heartbeatMs?: number;
  heartbeatLabel?: string;
}

export async function driveCursorTurn(o: CursorTurnOptions): Promise<CursorTurnResult> {
  const state = newCursorStreamState();
  let stderrTail = '';
  let lastEventAt = Date.now();
  let reported: string | null = null;
  const reader = createCursorStreamReader(
    state,
    (type, payload) => {
      lastEventAt = Date.now();
      o.emit(type, payload);
      if (state.sessionId && state.sessionId !== reported) { reported = state.sessionId; o.onSession?.(reported); }
    },
    (line) => { if (process.env.PORTAL_DEBUG_SDK) process.stderr.write(`[cursor] ${line}\n`); },
  );

  let exitCode: number | null = null;
  let spawnError: Error | null = null;
  const child = spawnCursor(o.args, { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'] });
  const onAbort = (): void => {
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, 2_000).unref();
  };
  if (o.signal?.aborted) onAbort(); else o.signal?.addEventListener('abort', onAbort, { once: true });

  child.stdin?.on('error', () => { /* the exit code and stderr say what happened */ });
  child.stdin?.end(o.prompt);
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => reader.push(chunk));
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => { stderrTail = (stderrTail + chunk).slice(-2_000); });

  const every = o.heartbeatMs ?? 30_000;
  const heartbeat = setInterval(() => {
    const quiet = Date.now() - lastEventAt;
    if (quiet >= every) o.emit('status', { text: `${o.heartbeatLabel ?? 'Cursor'} is working… (${Math.round(quiet / 1000)}s since the last update)` });
  }, every);
  heartbeat.unref();
  try {
    exitCode = await new Promise<number | null>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => resolve(code));
    });
  } catch (e) { spawnError = e as Error; }
  finally { clearInterval(heartbeat); o.signal?.removeEventListener('abort', onAbort); }
  reader.end();
  return { state, exitCode, spawnError, stderrTail };
}

/** What went wrong, from the CLI's stderr: the last few lines, trimmed. */
export function stderrReason(tail: string): string {
  return tail.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-4).join(' ').slice(0, 500);
}

/** The error message for a turn that did not finish cleanly, or null when it did. */
export function turnFailure(r: CursorTurnResult): string | null {
  if (r.spawnError) {
    const code = (r.spawnError as NodeJS.ErrnoException).code;
    return code === 'ENOENT' ? 'The Cursor CLI was not found (ENOENT). Set PORTAL_CURSOR_BIN to the agent binary.' : `Could not start the Cursor CLI: ${r.spawnError.message}`;
  }
  const why = stderrReason(r.stderrTail);
  if (r.exitCode !== 0 || r.state.isError) return `The Cursor CLI ${r.exitCode !== 0 ? `exited with code ${r.exitCode}` : 'reported an error'}.${why ? ' ' + why : ''}`;
  if (!r.state.finished) return 'The Cursor CLI ended without a result.' + (why ? ' ' + why : '');
  return null;
}
