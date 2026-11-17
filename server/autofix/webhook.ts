/** GitHub webhook endpoint for auto-fix: verify, answer 202, then fetch evidence and record in the background. */

import { router, sendJson } from '../http.ts';
import type { PortalRequest, PortalResponse } from '../http.ts';
import { readWebhookBody, webhookSignatureOk } from '../loop-triggers.ts';
import { getSecret } from '../secrets.ts';
import { parseGithubEvent } from './github-events.ts';
import type { FindingCandidate } from './github-events.ts';
import { fetchCiEvidence, findProjectGithubRepo, recordFinding } from './intake.ts';

export const webhookSecretName = (projectId: string): string => `autofix.webhook.${projectId}`;

type EvidenceFetcher = (c: FindingCandidate, projectId: string) => Promise<string>;
let evidenceFetcher: EvidenceFetcher = fetchCiEvidence;
/** Test seam: replace evidence fetching. Call with no argument to restore. */
export function _setEvidenceFetcher(fn?: EvidenceFetcher): void { evidenceFetcher = fn ?? fetchCiEvidence; }

const pending = new Set<Promise<void>>();
/** Test helper: resolves when all background intake work started so far has finished. */
export async function _drainIntakeForTest(): Promise<void> {
  while (pending.size) await Promise.all([...pending]);
}

function runInBackground(work: () => Promise<void>): void {
  const p: Promise<void> = work().catch((err) => {
    console.error('[autofix] webhook intake failed:', err instanceof Error ? err.message : err);
  }).finally(() => { pending.delete(p); });
  pending.add(p);
}

export function registerAutofixWebhook(): void {
  // A raw route: GitHub cannot send the browser header, so the signature is the proof and the body is read here.
  router.rawPost('/api/hooks/autofix/:projectId', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    try {
      const body = await readWebhookBody(req);
      req.rawBody = body.raw;
      req.body = body.json;
    } catch {
      sendJson(res, 413, { error: 'Request body too large' }); return;
    }
    const projectId = req.params.projectId;
    const secret = (await getSecret(webhookSecretName(projectId))) ?? '';
    const sig = String(req.headers['x-hub-signature-256'] ?? req.headers['x-portal-signature'] ?? '');
    // The same answer for "no such project" and "wrong signature", so ids cannot be probed.
    if (!secret || !webhookSignatureOk(req.rawBody, sig, secret)) {
      sendJson(res, 401, { error: 'Invalid signature' }); return;
    }
    const event = String(req.headers['x-github-event'] ?? '');
    const parsed = parseGithubEvent(event, req.body);
    if (parsed.type === 'ignore') { sendJson(res, 202, { ok: true, ignored: true }); return; }

    const fullName = parsed.type === 'finding' ? parsed.candidate.repoFullName : parsed.repoFullName;
    if (!await findProjectGithubRepo(projectId, fullName)) {
      sendJson(res, 404, { error: 'Repository is not part of this project' }); return;
    }
    if (parsed.type === 'finding') {
      const candidate = parsed.candidate;
      runInBackground(async () => {
        const evidence = await evidenceFetcher(candidate, projectId);
        await recordFinding(projectId, candidate, evidence);
      });
    }
    // ci_result and pr_closed are acknowledged here; the fix loop consumes them in later tasks.
    sendJson(res, 202, { ok: true });
  });
}
