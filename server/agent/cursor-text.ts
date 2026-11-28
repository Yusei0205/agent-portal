/**
 * Portal AI text generation through Cursor (documents, test cases, reviews, ...), for when Cursor is the portal's provider or the
 * person's only sign-in. One prompt in, one answer out: no tools (a shell command is refused because the turn is not trusted, and the
 * prompt says not to use any), no repository, no saved chat. Local: runs the CLI here. Cloud: the Cursor runner's `cursor-text` mode.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { HttpError } from '../util.ts';
import { resolveCredentialEnv } from '../credentials.ts';
import { cursorAvailable } from '../cursor-cmd.ts';
import { cursorAuthEnv } from '../cursor-login-token.ts';
import { cursorArgs, driveCursorTurn, turnFailure, CursorArgError } from './cursor-turn.ts';

const TIMEOUT_MS = 180_000;
const WRAPPER = '\n\nReply with the requested output only: no explanation, no markdown fences, no questions. Do not use any tools or read any files. If something is unclear, make a reasonable assumption and still produce the output.';

export async function callCursorText(prompt: string, userId: string | null, model?: string | null): Promise<string> {
  const env = await resolveCredentialEnv('cursor', userId, null);
  const auth = { apiKey: env.CURSOR_API_KEY, authToken: env.CURSOR_AUTH_TOKEN };
  const full = prompt + WRAPPER;
  const cleanModel = model && model.trim() ? model.trim() : null;

  const arn = process.env.PORTAL_CURSOR_AGENTCORE_RUNTIME_ARN;
  if (arn) {
    if (!auth.apiKey && !auth.authToken) throw new HttpError(400, 'Cloud Cursor needs a Cursor API key or login token. Add one under Credentials, or set the portal Cursor key in Settings.');
    const { invokeAgentCoreOneShot } = await import('./kiro-agentcore.ts');
    const secrets = [auth.apiKey, auth.authToken].filter((s): s is string => Boolean(s));
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    for await (const raw of invokeAgentCoreOneShot(arn, 'cursor-text-' + randomUUID(), { mode: 'cursor-text', prompt: full, model: cleanModel, apiKey: auth.apiKey, authToken: auth.authToken }, signal)) {
      const event = JSON.parse(secrets.reduce((text, s) => text.split(s).join('***'), JSON.stringify(raw))) as Record<string, unknown>;
      if (event.type === 'error') throw new HttpError(502, 'The Cursor runner could not answer: ' + String(event.message ?? '').slice(0, 300));
      if (event.type === 'result' && event.exitCode === 0 && typeof event.text === 'string') return event.text;
      if (event.type === 'result') throw new HttpError(502, 'The Cursor runner could not answer.');
    }
    throw new HttpError(502, 'The Cursor runner returned no answer.');
  }

  if (!(await cursorAvailable())) throw new HttpError(502, 'The Cursor CLI was not found. Install it and set PORTAL_CURSOR_BIN, or pick another provider.');
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-cursor-text-'));
  try {
    let args: string[];
    try { args = cursorArgs({ trusted: false, model: cleanModel, resumeId: null }); }
    catch (e) { throw e instanceof CursorArgError ? new HttpError(400, e.message) : e; }
    const result = await driveCursorTurn({
      args, prompt: full, cwd: workDir, env: { ...process.env, ...cursorAuthEnv(auth) }, emit: () => {}, signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const failure = turnFailure(result);
    if (failure) throw new HttpError(502, failure);
    return result.state.resultText ?? result.state.text;
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* the OS clears temp files */ }
  }
}
