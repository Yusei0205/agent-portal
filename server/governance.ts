/**
 * User management and governance. One module per concern under server/governance/;
 * this file keeps the public import path and registers every route group in order.
 */
import { registerPermissionsRoutes } from './governance/permissions.ts';
import { registerOidcRoutes } from './governance/oidc.ts';
import { registerInvitationRoutes } from './governance/invitations.ts';
import { registerUserLifecycleRoutes } from './governance/users.ts';
import { registerTeamRoutes } from './governance/teams.ts';
import { registerScopedTokenRoutes } from './governance/scoped-tokens.ts';
import { registerScimRoutes } from './governance/scim.ts';
import { registerUsageRoutes } from './governance/usage.ts';

export type { PortalRole, TeamRole, ProjectAccess } from './governance/permissions.ts';
export { PERMISSIONS_MATRIX, effectiveAccess } from './governance/permissions.ts';
export { setOidcEndpoints, OIDC_SECRET_NAME, type OidcEndpoints, type OidcSettings } from './governance/oidc.ts';

export function registerGovernanceRoutes(): void {
  registerPermissionsRoutes();
  registerOidcRoutes();
  registerInvitationRoutes();
  registerUserLifecycleRoutes();
  registerTeamRoutes();
  registerScopedTokenRoutes();
  registerScimRoutes();
  registerUsageRoutes();
}
