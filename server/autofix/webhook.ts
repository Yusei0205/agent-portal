/**
 * GitHub webhook endpoint for auto-fix: verify, answer 202, then work in the background: a failure becomes a finding (intake), and a
 * CI result or PR closing on an auto-fix branch moves that fix's finding on (pipeline.ts applyCiResult / applyPrClosed).
 */

import { router, sendJson, registerBackgroundWrite } from '../http.ts';
import type { PortalRequest, PortalResponse } from '../http.ts';
import { readWebhookBody, webhookSignatureOk } from '../loop-triggers.ts';
import { getSecret } from '../secrets.ts';
import { AUTOFIX_BRANCH_PREFIX, classifyKind, parseGithubEvent } from './github-events.ts';
import type { FindingCandidate } from './github-events.ts';
import { fetchCiEvidence, findProjectGithubRepo, recordFinding } from './intake.ts';
import { applyCiResult, applyPrClosed } from './pipeline.ts';
import { parseWorkflowRun } from '../pipelines/events.ts';
import { recordPipelineRun } from '../pipelines/record.ts';

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

function runInBackground(work: () => Promise<void>): Promise<void> {
  const p: Promise<void> = work().catch((err) => {
    console.error('[autofix] webhook intake failed:', err instanceof Error ? err.message : err);
  }).finally(() => { pending.delete(p); });
  pending.add(p);
  return p;
}

/** The largest webhook body read (1 MiB). */
export const WEBHOOK_BODY_MAX = 1_048_576;

export function registerAutofixWebhook(): void {
  // A raw route: GitHub cannot send the browser header, so the signature is the proof and the body is read here.
  router.rawPost('/api/hooks/autofix/:projectId', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    try {
      // GitHub pull_request and workflow_run payloads can be well over the 64 KB default; 1 MiB bounds them.
      const body = await readWebhookBody(req, WEBHOOK_BODY_MAX);
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
    // Pipeline monitor: every workflow_run of a project repository is recorded, whatever Auto-fix's mode (nothing is stored otherwise).
    // Everything, the repository lookup included, runs in the background, so it can never change Auto-fix's answer. The work is
    // registered with the request so it is drained before the response ends (Lambda may freeze the process right after).
    const wr = parseWorkflowRun(event, req.body);
    if (wr) {
      registerBackgroundWrite(runInBackground(async () => {
        const repo = await findProjectGithubRepo(projectId, wr.repoFullName);
        if (repo) await recordPipelineRun(projectId, { id: repo.id, default_branch: repo.default_branch }, wr);
      }));
    }
    const parsed = parseGithubEvent(event, req.body);
    // CI results and PR closings matter only on auto-fix branches; any other branch's are acknowledged and touch nothing.
    if (parsed.type === 'ignore' || (parsed.type !== 'finding' && !parsed.branch.startsWith(AUTOFIX_BRANCH_PREFIX))) {
      sendJson(res, 202, { ok: true, ignored: true }); return;
    }

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
    if (parsed.type === 'ci_result') {
      const r = parsed;
      // The failing run's log is read only when the result applies to an open fix PR (applyCiResult decides).
      const candidate: FindingCandidate = {
        repoFullName: r.repoFullName, branch: r.branch, headSha: r.headSha, source: 'ci_failed',
        kind: classifyKind(r.workflowName ?? ''), severity: 'medium', errorText: `${r.workflowName ?? 'CI'} failure`,
        ...(r.runId !== undefined ? { runId: r.runId } : {}),
      };
      runInBackground(() => applyCiResult(projectId, r, { evidence: () => evidenceFetcher(candidate, projectId) }));
    }
    if (parsed.type === 'pr_closed') {
      const r = parsed;
      runInBackground(() => applyPrClosed(projectId, r));
    }
    sendJson(res, 202, { ok: true });
  });
}
