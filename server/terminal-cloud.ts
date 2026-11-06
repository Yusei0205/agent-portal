import { router, sendJson, type PortalRequest, type PortalResponse } from './http.ts';
import { config } from './config.ts';
import { HttpError } from './util.ts';
import { getSessionsRepository } from './repositories/sessions.ts';
import { getMemberRow } from './project-access.ts';
import { runtimeFor } from './agent/repo-prep.ts';
import { agentCoreSessionId } from './agent/agentcore-session.ts';
import { agentCoreControlSender, presignAgentCoreWebSocket } from './agent/kiro-agentcore.ts';
import { snapshotAccess } from './agent/runner-snapshot-access.ts';
import { appendAudit } from './audit.ts';
import { signTerminalGrant, terminalPublicKey } from './agent/runner-terminal-auth.ts';

export const usesCloudTerminal = () => Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME) || config.deployTarget === 'cloud';

async function target(req: PortalRequest, id: string) {
  if (!req.user) throw new HttpError(401, 'Sign in to continue');
  if (req.authViaToken || req.tokenScopes || req.headers.authorization) throw new HttpError(403, 'Use your browser sign-in for terminal access');
  if (!/^[a-zA-Z0-9_-]{1,256}$/.test(id)) throw new HttpError(400, 'Select a session to open its terminal');
  const workflow = await getSessionsRepository().getWorkflowById(id);
  if (!workflow?.project_id) throw new HttpError(404, 'Session not found');
  if (!req.user.is_admin) {
    const member = await getMemberRow(String(workflow.project_id), req.user.id);
    if (!member) throw new HttpError(404, 'Session not found');
    if (!['editor', 'owner'].includes(String(member.access)) || String(workflow.created_by) !== req.user.id) {
      throw new HttpError(403, 'The session owner or an administrator can open its cloud terminal');
    }
  }
  const runtime = runtimeFor(String(workflow.engine));
  if (!runtime) throw new HttpError(503, 'No cloud terminal runner is configured for this session engine');
  return { workflow, runtime, session: agentCoreSessionId(id, runtime.kind) };
}

export async function cloudTerminalCapability(req: PortalRequest, res: PortalResponse, enabled: boolean): Promise<void> {
  if (!req.user) { sendJson(res, 401, { error: 'Sign in to continue' }); return; }
  if (!enabled) { sendJson(res, 200, { available: false, reason: 'Terminal is disabled by an administrator' }); return; }
  try {
    await target(req, req.query.get('workflowId') ?? '');
    sendJson(res, 200, { available: true, transport: 'agentcore', ptyAvailable: true, platform: 'linux' });
  } catch (e) { sendJson(res, 200, { available: false, reason: (e as Error).message }); }
}

export function registerCloudTerminalRoutes(enabled: () => boolean): void {
  router.get('/api/terminal/public-key', (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=300');
    sendJson(res, 200, { publicKey: terminalPublicKey(config.secretKey) });
  });
  router.post('/api/terminal/connect', async (req, res) => {
    if (!req.user) throw new HttpError(401, 'Sign in to continue');
    if (!usesCloudTerminal()) throw new HttpError(400, 'This portal uses its local terminal connection');
    if (!enabled()) throw new HttpError(403, 'Terminal is disabled by an administrator');
    const origin = new URL(process.env.PORTAL_PUBLIC_URL || `${req.secure ? 'https' : 'http'}://${req.headers.host}`).origin;
    if (req.headers.origin && req.headers.origin !== origin) throw new HttpError(403, 'Open the terminal from this portal');
    const id = (req.body as { workflowId?: unknown })?.workflowId;
    const { runtime, session } = await target(req, typeof id === 'string' ? id : '');
    const snapshot = await snapshotAccess(String(id));
    if (!snapshot) throw new HttpError(503, 'Cloud terminal workspace storage is not configured');
    const grant = signTerminalGrant(config.secretKey, { workflowId: String(id), engine: runtime.kind, origin, snapshot, actor: req.user.id });
    const replies = await agentCoreControlSender(runtime.arn, session)({ mode: 'terminal-ticket', workflowId: id, origin, snapshot, grant });
    const ticket = replies.find(r => r.type === 'terminal-ticket');
    if (typeof ticket?.ticket !== 'string' || !/^[a-f0-9]{64}$/.test(ticket.ticket)) throw new HttpError(503, 'The session runner could not open a terminal. Wait for any current work to finish and reconnect.');
    const url = await presignAgentCoreWebSocket(runtime.arn, session);
    appendAudit(null, req.user!.id, 'terminal.open', `workflow:${id}`, { transport: 'agentcore' }, null);
    res.setHeader('Cache-Control', 'no-store');
    sendJson(res, 200, { url, ticket: ticket.ticket });
  });
}
