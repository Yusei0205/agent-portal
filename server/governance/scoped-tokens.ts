/** API tokens with an optional project scope. */
import { randomBytes } from 'node:crypto';
import { insert } from '../db.ts';
import { post } from '../http.ts';
import { badRequest, forbidden, newId, now, sha256, str } from '../util.ts';
import { audit } from '../audit.ts';
import { getProject } from '../projects.ts';
import { TOKEN_PREFIX } from '../api-tokens.ts';
import { effectiveAccess } from './permissions.ts';

export function registerScopedTokenRoutes(): void {
  // ── API token project scope enforcement ──────────────────────────────────

  /**
   * POST /api/tokens/scoped — create a project-scoped token.
   * Identical to POST /api/tokens but requires project_id and project access.
   */
  post('/api/tokens/scoped', async (ctx) => {
    const body = await ctx.json();
    if (!body.project_id) throw badRequest('project_id is required for scoped tokens');
    const project = getProject(body.project_id);
    const access = effectiveAccess(ctx.user!, project.id);
    if (!access) throw forbidden('You do not have access to this project');

    const token = `${TOKEN_PREFIX}${randomBytes(30).toString('base64url')}`;
    const days = Number(body.days ?? 90);
    if (![30, 90, 365].includes(days)) throw badRequest('Choose 30, 90 or 365 days');
    const scope: 'read' | 'write' = body.scope === 'write' ? 'write' : 'read';
    const name = str(body.name, 'Token name', { max: 80 }).trim();
    if (!name) throw badRequest('Name the token');
    const id = newId('tk_');
    insert('api_tokens', {
      id,
      user_id: ctx.user!.id,
      name,
      token_hash: sha256(token),
      prefix: token.slice(0, 10),
      scope,
      project_id: project.id,
      expires_at: new Date(Date.now() + days * 86_400_000).toISOString(),
      created_at: now(),
    });
    audit(ctx, 'api_token.create', `project:${project.id}`, { name, scope, project_id: project.id });
    return { token };
  });
}
