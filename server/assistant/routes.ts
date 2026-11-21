/**
 * POST /api/assistant/chat: Kyu's read-only assistant. Own subscription only, no tools, nothing is changed.
 * The question, the reply and the prompt are never logged.
 */

import { router, sendJson, requireAuth } from '../http.ts';
import type { PortalRequest, PortalResponse } from '../http.ts';
import { requireMember } from '../dashboard.ts';
import { getProjectRepository } from '../repositories/projects.ts';
import { generateAssistantAnswer, selectAssistantModel } from './provider.ts';
import { retrieve } from '../knowledge-search.ts';
import { projectMemoryNotes } from '../agentcore-memory.ts';
import { loadGuide, rankGuide } from './guide.ts';
import { assistantLinks, buildPrompt, parseReply } from './prompt.ts';
import { checkAndCount } from './limits.ts';
import { buildSummary } from './summary.ts';

const MAX_QUESTION = 1000;
const MAX_HISTORY = 8;
const MAX_HISTORY_TEXT = 600;
const TIMEOUT_MS = 35_000;

let timeoutOverride: number | null = null;
export function setAssistantTimeoutForTest(ms: number | null): void { timeoutOverride = ms; }

type Retriever = typeof retrieve;
let retrieveOverride: Retriever | null = null;
export function setAssistantRetrieveForTest(fn: Retriever | null): void { retrieveOverride = fn; }
type NotesReader = typeof projectMemoryNotes;
let notesOverride: NotesReader | null = null;
export function setAssistantNotesForTest(fn: NotesReader | null): void { notesOverride = fn; }

type Fail = 'no_sign_in' | 'rate_limited' | 'too_long' | 'failed';
const STATUS: Record<Fail, number> = { too_long: 400, no_sign_in: 402, rate_limited: 429, failed: 502 };
const MESSAGE: Record<Fail, string> = {
  too_long: 'That question is too long. Please keep it under 1,000 characters.',
  no_sign_in: 'Connect your Codex account or a Claude Code subscription in Agent setup to chat with Kyu.',
  rate_limited: 'You are asking too fast. Please wait a little and try again.',
  failed: 'The cat could not answer just now. Please try again.',
};
function fail(res: PortalResponse, code: Fail): void {
  sendJson(res, STATUS[code], { error: MESSAGE[code], code });
}

function cleanHistory(raw: unknown): Array<{ role: 'me' | 'cat'; text: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ role: 'me' | 'cat'; text: string }> = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue;
    const { role, text } = e as { role?: unknown; text?: unknown };
    if ((role !== 'me' && role !== 'cat') || typeof text !== 'string' || !text.trim()) continue;
    out.push({ role, text: text.slice(0, MAX_HISTORY_TEXT) });
  }
  return out.slice(-MAX_HISTORY);
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const t = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), ms); });
  try { return await Promise.race([p, t]); } finally { clearTimeout(timer); }
}

export function registerAssistantRoutes(): void {
  router.post(
    '/api/assistant/chat',
    requireAuth(async (req: PortalRequest, res: PortalResponse) => {
      const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
      const question = typeof body.question === 'string' ? body.question.trim() : '';
      if (!question) { sendJson(res, 400, { error: 'question is required', code: 'failed' }); return; }
      if (question.length > MAX_QUESTION) { fail(res, 'too_long'); return; }
      const projectId = typeof body.projectId === 'string' && body.projectId ? body.projectId : null;
      if (projectId && !(await requireMember(req, res, projectId))) return;
      const userId = req.user!.id;

      try {
        // Simple navigation guidance needs neither inference nor a subscription.
        if (/\bfeedback\b/i.test(question) && /\b(how|where|open|view|find|show)\b/i.test(question)) {
          sendJson(res,200,{reply:'Open Feedback in the Portal section of the left sidebar. You can also use the button below.',links:[{id:'feedback',label:'Open Feedback',href:'#/feedback'}],via:'navigation',provider:'Portal guide'}); return;
        }
        let selection = await withTimeout(selectAssistantModel(userId),15000);
        if (!selection) { fail(res, 'no_sign_in'); return; }
        const lim = await checkAndCount(userId);
        if (!lim.ok) { fail(res, 'rate_limited'); return; }

        const history = cleanHistory(body.history);
        const guide = rankGuide(loadGuide(), question, 4);
        let knowledge: Array<{ docName: string; heading: string; text: string }> = [];
        let notes: string[] = [];
        let summary = null;
        if (projectId) {
          const project = await getProjectRepository().getProjectById(projectId);
          if (project) {
            // Membership was checked above; approved project memory is read alongside the knowledge search.
            const [k, n] = await Promise.all([
              (retrieveOverride ?? retrieve)({ id: project.id, slug: project.slug }, question, 4)
                .then((r) => r.passages.map((p) => ({ docName: p.docName, heading: p.heading, text: p.text })))
                .catch(() => []),
              (notesOverride ?? projectMemoryNotes)(projectId, question).catch(() => []),
            ]);
            knowledge = k;
            notes = n;
            summary = await buildSummary(projectId).catch(() => null);
          }
        }
        const links = assistantLinks(projectId);
        const maxChars = 12000;
        const { system, user } = buildPrompt({ question, history, guide, knowledge, notes, summary, links, maxChars });
        const controller = new AbortController();
        let raw: string;
        const generate = async () => {
          try { return await generateAssistantAnswer(system,user,userId,selection!,controller.signal); }
          catch (error) {
            // A saved subscription token may have expired. Try the person's other
            // connected subscription within the same time budget, never an admin key.
            if (controller.signal.aborted) throw error;
            const alternate = await selectAssistantModel(userId,selection!.engine);
            if (!alternate) throw error;
            selection = alternate;
            return generateAssistantAnswer(system,user,userId,alternate,controller.signal);
          }
        };
        try { raw = await withTimeout(generate(),timeoutOverride ?? TIMEOUT_MS); }
        finally { controller.abort(); }
        const parsed = parseReply(String(raw ?? ''), links);
        if (!parsed.reply && !parsed.links.length) { fail(res, 'failed'); return; }
        if (!parsed.reply) parsed.reply = 'These pages may help:';
        sendJson(res, 200, { reply: parsed.reply, links: parsed.links, via: knowledge.length ? 'guide+knowledge' : 'guide',provider:selection.label,model:selection.model });
      } catch {
        console.warn('[assistant] answer failed (code=failed)');
        fail(res, 'failed');
      }
    }),
  );
}
