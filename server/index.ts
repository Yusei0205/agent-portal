import http from 'node:http';
import { config, ensureDataDirs } from './config.ts';
import { openDb, closeDb } from './db.ts';
import { createHandler } from './http.ts';
import { authenticate, cleanupSessions, createUser, registerAuthRoutes, userCount } from './auth.ts';
import { registerSettingsRoutes, getSettings } from './settings.ts';
import { registerModelRoutes } from './models.ts';
import { registerSsoRoutes } from './sso.ts';
import { registerProjectRoutes, getProject, projectDir } from './projects.ts';
import { registerRepoRoutes } from './repos.ts';
import { registerGitConnectionRoutes } from './git-connections.ts';
import { registerWorkspaceRoutes } from './workspaces.ts';
import { registerIntegrationRoutes } from './integrations.ts';
import { registerConfigRoutes } from './config-files.ts';
import { registerApiTokenRoutes } from './api-tokens.ts';
import { registerVaultRoutes } from './vault.ts';
import { registerCodeCommitRoutes } from './codecommit.ts';
import { registerKnowledgeRoutes } from './knowledge.ts';
import { registerBuilderRoutes } from './builder.ts';
import { registerImporterRoutes } from './importer.ts';
import { registerKiroAgentRoutes } from './kiro-agents.ts';
import { registerRunRoutes } from './runs.ts';
import { registerReviewRoutes } from './review.ts';
import { registerLearnRoutes } from './learn.ts';
import { registerJiraRoutes } from './jira.ts';
import { registerProjectAwsRoutes } from './project-aws.ts';
import { registerAwsAccountRoutes } from './aws-accounts.ts';
import { recoverWorkflows, registerWorkflowRoutes, resumeAfterRestart, anyDriving } from './workflows.ts';
import { recoverRuns } from './agent/runner.ts';
import { registerInsightsRoutes } from './insights.ts';
import { registerAuditRoutes } from './audit.ts';
import { registerControlPlaneRoutes, startDrain, checkApprovalSla, cleanupWorktrees } from './control-plane.ts';

let routesRegistered = false;

export async function startServer(opts: { port?: number; host?: string } = {}): Promise<http.Server> {
  ensureDataDirs();
  openDb();
  if (!routesRegistered) {
    registerAuthRoutes();
    registerSettingsRoutes();
    registerModelRoutes();
    registerSsoRoutes();
    registerProjectRoutes();
    registerRepoRoutes();
    registerGitConnectionRoutes();
    registerWorkspaceRoutes();
    registerIntegrationRoutes();
    registerConfigRoutes();
    registerApiTokenRoutes();
    registerVaultRoutes();
    registerCodeCommitRoutes();
    registerKnowledgeRoutes();
    registerBuilderRoutes();
    registerImporterRoutes();
    registerKiroAgentRoutes();
    registerRunRoutes();
    registerReviewRoutes();
    registerLearnRoutes();
    registerJiraRoutes();
    registerProjectAwsRoutes();
    registerAwsAccountRoutes();
    registerWorkflowRoutes();
    registerInsightsRoutes();
    registerAuditRoutes();
    registerControlPlaneRoutes();
    routesRegistered = true;
  }
  recoverRuns();
  const restarted = recoverWorkflows();
  cleanupSessions();
  // Projects that kept their own AWS credentials move onto AWS accounts (AWS accounts page) once; they keep working the same.
  const { adoptProjectCredentials } = await import('./aws-connections.ts');
  const moved = await adoptProjectCredentials().catch((e) => (console.error('[aws] could not move project credentials:', e), 0));
  if (moved) console.log(`[aws] ${moved} project(s) now use an AWS account from the AWS accounts page`);

  if (userCount() === 0 && process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
    createUser({ email: process.env.ADMIN_EMAIL, name: process.env.ADMIN_NAME || 'Admin', password: process.env.ADMIN_PASSWORD, isAdmin: true });
    console.log(`[setup] Created admin account ${process.env.ADMIN_EMAIL}`);
  }

  const server = http.createServer(createHandler(authenticate));
  server.requestTimeout = 0; // uploads and event streams can be long
  server.headersTimeout = 60_000;
  const port = opts.port ?? config.port;
  const host = opts.host ?? config.host;
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  // Sessions the restart interrupted carry on once the server is up (unless an admin turned that off).
  if (restarted.length && getSettings().agents.resumeAfterRestart !== false) {
    setTimeout(() => {
      const n = resumeAfterRestart(restarted);
      if (n) console.log(`[sessions] ${n} session(s) carried on after the restart`);
    }, 2000).unref();
  }
  const addr = server.address();
  const shown = typeof addr === 'object' && addr ? `http://${host === '0.0.0.0' ? 'localhost' : host}:${addr.port}` : String(addr);
  console.log(`Agent Portal is running at ${shown}`);
  console.log(`Data folder: ${config.dataDir}`);
  if (userCount() === 0) console.log('Open the address above to create the first admin account.');

  // Periodic jobs
  const sessionCleanupTimer = setInterval(cleanupSessions, 6 * 3600_000);
  sessionCleanupTimer.unref();

  // Approval SLA checker: runs every minute
  const slaTimer = setInterval(() => {
    const slaMinutes = getSettings().controlPlane?.approvalSlaMinutes ?? 30;
    checkApprovalSla(slaMinutes);
  }, 60_000);
  slaTimer.unref();

  // Worktree TTL cleanup: runs once a day
  const cleanupTimer = setInterval(async () => {
    const ttlDays = getSettings().controlPlane?.worktreeTtlDays ?? 30;
    const getDir = (pid: string) => {
      try {
        return projectDir(getProject(pid));
      } catch { return null; }
    };
    const result = await cleanupWorktrees(getDir, ttlDays).catch((e: unknown) => (console.error('[cleanup]', e), { deleted: 0, skipped: 0 }));
    if (result.deleted || result.skipped) {
      console.log(`[cleanup] Worktrees: ${result.deleted} removed, ${result.skipped} skipped (uncommitted changes or errors)`);
    }
  }, 24 * 3600_000);
  cleanupTimer.unref();

  server.on('close', () => {
    clearInterval(sessionCleanupTimer);
    clearInterval(slaTimer);
    clearInterval(cleanupTimer);
    closeDb();
  });
  return server;
}

const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('server.mjs') || process.argv[1]?.endsWith('index.ts');
if (isMain && !process.env.PORTAL_NO_AUTOSTART) {
  startServer().then((server) => {
    const stop = async (signal: string) => {
      console.log(`[${signal}] Graceful shutdown starting…`);
      const drainTimeout = (getSettings().controlPlane?.drainTimeoutSeconds ?? 60) * 1000;
      // Enter drain mode: stop accepting new sessions/iterations.
      await startDrain(drainTimeout, anyDriving);
      console.log('[drain] All active sessions finished or timed out. Closing server.');
      server.closeAllConnections?.();
      server.close(() => {
        console.log('[drain] Server closed.');
        setTimeout(() => process.exit(0), 500).unref();
      });
      // Hard timeout in case server.close() hangs.
      setTimeout(() => process.exit(0), drainTimeout + 5000).unref();
    };
    process.on('SIGINT', () => stop('SIGINT').catch(console.error));
    process.on('SIGTERM', () => stop('SIGTERM').catch(console.error));
  }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
