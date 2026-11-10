/**
 * Agent Portal server entry point.
 *
 * Loads config, opens the database, registers all routes, starts listening.
 */

import { loadConfig, setConfig, ensureDataDirs } from './config.ts';
import type { Config } from './config.ts';
import { openDb, closeDb, isDbOpen } from './db.ts';
import { createServer, clearRoutes, router, setWsUpgradeHandler } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { registerAuthRoutes, createUser, cleanupSessions, hashPassword } from './auth.ts';
import { getAuthRepository } from './repositories/auth.ts';import { registerHealthRoutes } from './health.ts';
import { initStorage } from './storage-instance.ts';
import { initApiTokenRepository } from './repositories/api-tokens.ts';
import { config } from './config.ts';
import path from 'node:path';
import fs from 'node:fs';
import { registerPermissionRoutes } from './permissions.ts';
import { registerSettingsRoutes } from './settings.ts';
import { registerToolPackRoutes } from './tool-packs.ts';
import { registerUserRoutes } from './governance/users.ts';
import { registerProjectRoutes } from './projects.ts';
import { registerRepoRoutes, killActiveGitProcesses } from './repos.ts';
import { registerWorkspaceRoutes } from './workspaces.ts';
import { registerGitConnectionRoutes } from './git-connections.ts';
import { registerWorkflowRoutes } from './workflows/crud.ts';
import { registerRunRoutes } from './runs.ts';
import { registerInboxRoutes } from './inbox.ts';
import { registerDiagramRoutes } from './diagrams.ts';
import { registerKnowledgeRoutes } from './knowledge.ts';
import { registerKnowledgeSearchRoutes } from './knowledge-search.ts';
import { registerVaultRoutes } from './vault.ts';
import { registerOutputFileRoutes } from './output-files.ts';
import { registerGeneratedDocRoutes } from './generated-docs.ts';
import { registerPresentationRoutes } from './presentations.ts';
import { registerDocTemplateRoutes } from './doc-templates.ts';
import { registerReviewRoutes } from './review.ts';
import { registerLoopSpecRoutes } from './loop-specs.ts';
import { registerAutomationRoutes } from './automations/routes.ts';
import { recoverLocalAutomations, stopLocalAutomationTimers } from './automations/engine.ts';
import { registerInsightsRoutes } from './insights.ts';
import { registerGoogleWorkspaceRoutes } from './google-workspace.ts';
import { registerGmailRoutes } from './gmail.ts';
import { registerMailRoutes } from './mail.ts';
import { registerDashboardRoutes } from './dashboard.ts';
import { registerApiTokenRoutes } from './api-tokens.ts';
import { registerStorageTestRoutes } from './storage-test.ts';
import { registerRealtimeRoutes } from './realtime-routes.ts';
import { registerAuditRoutes } from './audit.ts';
import { registerLearnRoutes } from './learn.ts';
import { registerControlPlaneRoutes } from './control-plane.ts';
import { registerIntegrationRoutes } from './integrations.ts';
import { registerProjectAwsRoutes } from './project-aws.ts';
import { registerProjectPullRequestSettingsRoutes } from './project-settings-pr.ts';
import { registerSessionPullRequestRoutes } from './session-pr.ts';
import { registerSessionFileRoutes } from './session-files.ts';
import { registerTerminalRoutes, handleTerminalUpgrade, shutdownAllTerminals } from './terminal.ts';
import { registerSessionLifecycleRoutes, startIdleStopTimer, stopIdleStopTimer } from './session-lifecycle.ts';
import { registerCredentialRoutes } from './credentials.ts';
import { registerCodexRoutes } from './codex-auth.ts';
import { registerUserConfigRoutes } from './user-config.ts';
import { registerScanRoutes } from './scan.ts';
import { registerMcpRoutes } from './mcp-routes.ts';
import { registerTestingRoutes } from './testing/index.ts';
import { registerThemeRoutes } from './themes.ts';
import { registerFeedbackRoutes } from './feedback.ts';
import { registerPortalEventsRoutes } from './portal-events.ts';
import { registerAiAttachmentRoutes, cleanupOrphanedAttachments } from './ai-attachments.ts';
import { runDueTriggers } from './loop-triggers.ts';
import { registerBedrockSsoRoutes } from './bedrock-sso.ts';
import { registerKiroSettingsRoutes } from './kiro-settings.ts';
import { registerEngineModelRoutes } from './models.ts';
import { registerSessionContextRoutes } from './session-context.ts';
import { registerJiraRoutes } from './jira.ts';
import { registerBrowserLiveRoutes, handleBrowserLiveUpgrade } from './browser-live.ts';
import { shutdownAllBrowsers } from './agent/browser-manager.ts';
import './review-lifecycle.ts'; // Register review lifecycle hook (wires run stats → review row)

// Track whether routes have been registered (they're global, so only once per process)

export async function startServer(
  opts: { port?: number; host?: string; config?: Config } = {},
): Promise<import('node:http').Server> {
  let cfg: Config;

  if (opts.config) {
    // Use the provided config (e.g. from tests)
    cfg = opts.config;
    setConfig(cfg);
  } else {
    // 1. Load configuration (resolves secret key)
    cfg = await loadConfig();
    setConfig(cfg);
  }

  // 2. Ensure data directories exist
  ensureDataDirs(cfg.dataDir);

  // 3. Initialise storage backend (local or S3)
  await initStorage();

  // 4. Open database and run migrations.
  // This must happen before any repository init that queries the database
  // (e.g. initSettingsRepository calls loadSnapshot() which calls getDb()).
  // Skip if already open — tests may inject an in-memory DB before calling startServer.
  if (!isDbOpen()) {
    openDb(`${cfg.dataDir}/portal.db`, cfg);
  }

  // 5. Initialise api-token repository (SQLite by default, DynamoDB when configured)
  await initApiTokenRepository();

  // 6. Initialise auth, permissions, audit, delegation-settings, settings, and projects repositories
  const { initAuthRepository } = await import('./repositories/auth.ts');
  const { initPermissionsRepository } = await import('./repositories/permissions.ts');
  const { initAuditRepository } = await import('./repositories/audit.ts');
  const { initDelegationSettingsRepository } = await import('./repositories/delegation-settings.ts');
  const { initSettingsRepository, refreshSnapshotIfStale } = await import('./repositories/settings.ts');
  const { initProjectRepository } = await import('./repositories/projects.ts');
  await initAuthRepository();
  await initPermissionsRepository();
  await initAuditRepository();
  await initDelegationSettingsRepository();
  await initSettingsRepository();
  await initProjectRepository();

  // 6b. Initialise sessions repository (p6_workflows, p6_runs, p6_events, p6_inputs, p6_workflow_events)
  const { initSessionsRepository } = await import('./repositories/sessions.ts');
  await initSessionsRepository();

  // 6c. Initialise inbox repository (p6_inbox)
  const { initInboxRepository } = await import('./repositories/inbox.ts');
  await initInboxRepository();

  // 6d. Initialise budget repository (budget_usage)
  const { initBudgetRepository } = await import('./repositories/budget.ts');
  await initBudgetRepository();

  // 6e. Initialise stats repository (dashboard G1–G11 + insights H1–H6 reads)
  const { initStatsRepository } = await import('./repositories/stats.ts');
  await initStatsRepository();

  // 6f. Initialise knowledge, vault-files, and output-files repositories
  const { initKnowledgeRepository } = await import('./repositories/knowledge.ts');
  const { initVaultFilesRepository } = await import('./repositories/vault-files.ts');
  const { initOutputFilesRepository } = await import('./repositories/output-files.ts');
  await initKnowledgeRepository();
  await initVaultFilesRepository();
  await initOutputFilesRepository();

  // 6g. Initialise P10 module repositories (reviews, scans, loop-specs, git-repos, git-connections, workspaces)
  const { initReviewsRepository } = await import('./repositories/reviews.ts');
  const { initScansRepository } = await import('./repositories/scans.ts');
  const { initLoopSpecsRepository } = await import('./repositories/loop-specs.ts');
  const { initGitReposRepository } = await import('./repositories/git-repos.ts');
  const { initGitConnectionsRepository } = await import('./repositories/git-connections.ts');
  const { initWorkspacesRepository } = await import('./repositories/workspaces.ts');
  await initReviewsRepository();
  await initScansRepository();
  await initLoopSpecsRepository();
  await initGitReposRepository();
  await initGitConnectionsRepository();
  await initWorkspacesRepository();

  // 6g. Initialise credentials, aws-accounts, integrations, themes, user-config, agentcore-login repositories
  const { initCredentialsRepository } = await import('./repositories/credentials.ts');
  const { initAwsAccountsRepository } = await import('./repositories/aws-accounts.ts');
  const { initIntegrationsRepository } = await import('./repositories/integrations.ts');
  const { initThemesRepository } = await import('./repositories/themes.ts');
  const { initFeedbackRepository } = await import('./repositories/feedback.ts');
  const { initUserConfigRepository } = await import('./repositories/user-config.ts');
  const { initAgentcoreLoginRepository } = await import('./repositories/agentcore-login.ts');
  await initCredentialsRepository();
  await initAwsAccountsRepository();
  await initIntegrationsRepository();
  await initThemesRepository();
  await initFeedbackRepository();
  await initUserConfigRepository();
  await initAgentcoreLoginRepository();

  // 6h. Initialise pathb repositories (ai-attachments, presentations, generated-docs,
  //     diagrams, doc-templates, learn, testing-data)
  const { initAiAttachmentRepository } = await import('./repositories/ai-attachments.ts');
  const { initPresentationRepository } = await import('./repositories/presentations-data.ts');
  const { initGeneratedDocRepository } = await import('./repositories/generated-docs-data.ts');
  const { initDiagramRepository } = await import('./repositories/diagrams-data.ts');
  const { initDocTemplateRepository } = await import('./repositories/doc-templates-data.ts');
  const { initLearnRepository } = await import('./repositories/learn.ts');
  const { initTestingRepository } = await import('./repositories/testing-data.ts');
  await initAiAttachmentRepository();
  await initPresentationRepository();
  await initGeneratedDocRepository();
  await initDiagramRepository();
  await initDocTemplateRepository();
  await initLearnRepository();
  await initTestingRepository();

  // 7. Register pre-request hook to keep settings snapshot fresh on Lambda
  //     (version check is cheap; full reload only when version changes)
  const { setPreRequestHook } = await import('./http.ts');
  setPreRequestHook(refreshSnapshotIfStale);

  // 5. Register routes (clear any previously registered routes first for test isolation)
  clearRoutes();
  registerAuthRoutes();
  registerHealthRoutes();

  // Static-file proxy for local storage backend
  // GET /api/storage-file?path=<encoded-logical-path>
  router.get('/api/storage-file', (req: PortalRequest, res: PortalResponse): void => {
    const rawPath = req.query.get('path') ?? '';
    if (!rawPath) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'path query param required' }));
      return;
    }
    // Resolve against dataDir and serve
    const abs = path.resolve(config.dataDir, rawPath);
    // Security: ensure the resolved path is within dataDir
    if (!abs.startsWith(path.resolve(config.dataDir))) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'forbidden' }));
      return;
    }
    fs.stat(abs, (statErr, stat) => {
      if (statErr || !stat.isFile()) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      const stream = fs.createReadStream(abs);
      res.writeHead(200);
      stream.pipe(res as unknown as NodeJS.WritableStream);
      stream.on('error', () => {
        res.end();
      });
    });
  });
  registerPermissionRoutes();
  registerSettingsRoutes();
  registerToolPackRoutes();
  registerUserRoutes();
  registerProjectRoutes();
  registerRepoRoutes();
  registerWorkspaceRoutes();
  registerGitConnectionRoutes();
  registerWorkflowRoutes();
  registerRunRoutes();
  registerInboxRoutes();
  registerDiagramRoutes();
  registerKnowledgeRoutes();
  registerKnowledgeSearchRoutes();
  registerVaultRoutes();
  registerOutputFileRoutes();
  registerGeneratedDocRoutes();
  registerPresentationRoutes();
  registerDocTemplateRoutes();
  registerReviewRoutes();
  registerLoopSpecRoutes();
  registerAutomationRoutes();
  registerInsightsRoutes();
  registerGoogleWorkspaceRoutes();
  registerGmailRoutes();
  registerMailRoutes();
  registerDashboardRoutes();
  registerApiTokenRoutes();
  registerStorageTestRoutes();
  registerRealtimeRoutes();
  registerAuditRoutes();
  registerLearnRoutes();
  registerControlPlaneRoutes();
  registerIntegrationRoutes();
  registerProjectAwsRoutes();
  registerProjectPullRequestSettingsRoutes();
  registerSessionPullRequestRoutes();
  registerSessionFileRoutes();
  registerTerminalRoutes();
  registerSessionLifecycleRoutes();
  registerScanRoutes();
  registerUserConfigRoutes();
  registerCredentialRoutes();
  registerCodexRoutes();
  registerMcpRoutes();
  registerTestingRoutes();
  registerThemeRoutes();
  registerFeedbackRoutes();
  registerPortalEventsRoutes();
  registerAiAttachmentRoutes();
  registerBedrockSsoRoutes();
  registerKiroSettingsRoutes();
  registerEngineModelRoutes();
  registerSessionContextRoutes();
  registerJiraRoutes();
  registerBrowserLiveRoutes();

  // 6. Auto-create admin from env vars if no users exist.
  // Uses createFirstAdmin() which atomically checks count=0 before inserting,
  // so concurrent Lambda cold starts cannot create two admin accounts.
  // Silently skips when users already exist (no crash on env vars left in place).
  if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
    try {
      await getAuthRepository().createFirstAdmin({
        id: (await import('./util.ts')).generateId(),
        email: process.env.ADMIN_EMAIL.trim().toLowerCase(),
        name: process.env.ADMIN_NAME ?? 'Admin',
        password_hash: hashPassword(process.env.ADMIN_PASSWORD),
        is_admin: 1,
        disabled: 0,
        created_at: (await import('./util.ts')).now(),
      });
      console.log(`[setup] Created admin account ${process.env.ADMIN_EMAIL}`);
    } catch (e: unknown) {
      // AdminAlreadyExistsError is expected when the portal already has users — not fatal
      const { AdminAlreadyExistsError } = await import('./repositories/auth.ts');
      if (!(e instanceof AdminAlreadyExistsError)) throw e;
    }
  }

  // 7. Start HTTP server
  const server = createServer();

  // Register WebSocket upgrade handlers (terminal + browser live)
  const BROWSER_LIVE_RE = /^\/api\/workflows\/[^/]+\/browser\/live$/;
  setWsUpgradeHandler((req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/api/terminal/ws') {
      Promise.resolve(handleTerminalUpgrade(req, socket, head)).catch(() => { try { socket.destroy(); } catch { /* closed */ } });
    } else if (BROWSER_LIVE_RE.test(url.pathname)) {
      handleBrowserLiveUpgrade(req, socket, head).catch(() => { try { socket.destroy(); } catch { /* closed */ } });
    } else {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
    }
  });
  const port = opts.port ?? cfg.port;
  const host = opts.host ?? cfg.host;

  await new Promise<void>((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, resolve);
  });

  const displayHost = host === '0.0.0.0' ? 'localhost' : host;
  console.log(`Server listening on http://${displayHost}:${port}`);
  console.log(`Data folder: ${cfg.dataDir}`);

  if ((await getAuthRepository().countUsers()) === 0) {
    console.log('Open the address above to create the first admin account.');
  }

  // On Lambda there is no long-lived process: EventBridge Scheduler runs these jobs (see scheduled-jobs.ts).
  const onLambda = Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);

  // 8. Periodic session cleanup every 6 hours
  const sessionCleanupTimer = setInterval(() => {
    if (!onLambda && isDbOpen()) cleanupSessions();
  }, 6 * 3600_000);
  sessionCleanupTimer.unref();

  // 8b. Periodic AI attachment orphan cleanup (every 6 hours)
  const attachmentCleanupTimer = setInterval(async () => {
    if (!onLambda && isDbOpen()) await cleanupOrphanedAttachments();
  }, 6 * 3600_000);
  attachmentCleanupTimer.unref();

  // 9. Idle-session stop timer (checks every minute)
  if (!onLambda) startIdleStopTimer();

  // 9b. Loop specs with a cron or interval trigger (on Lambda: the `loop-triggers` schedule)
  const loopTriggerTimer = setInterval(() => {
    if (!onLambda && isDbOpen()) void runDueTriggers().catch((e) => console.error('[loop-trigger] tick failed:', e));
  }, 60_000);
  loopTriggerTimer.unref();

  // 10. Graceful shutdown
  if (!onLambda) await recoverLocalAutomations();
  server.on('close', () => {
    stopLocalAutomationTimers();
    clearInterval(sessionCleanupTimer);
    clearInterval(attachmentCleanupTimer);
    stopIdleStopTimer();
    killActiveGitProcesses();
    shutdownAllTerminals();
    shutdownAllBrowsers().catch(() => {/* non-fatal */});
    closeDb();
  });

  return server;
}

// ── Auto-start when run directly ─────────────────────────────────────────────

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('server.mjs') ||
  process.argv[1]?.endsWith('index.ts');

if (isMain && !process.env.PORTAL_NO_AUTOSTART) {
  startServer()
    .then((server) => {
      const stop = (signal: string): void => {
        console.log(`[${signal}] Graceful shutdown starting…`);
        server.closeAllConnections?.();
        server.close(() => {
          console.log('[shutdown] Server closed.');
          setTimeout(() => process.exit(0), 200).unref();
        });
        setTimeout(() => process.exit(0), 30_000).unref();
      };

      process.on('SIGTERM', () => stop('SIGTERM'));
      process.on('SIGINT', () => stop('SIGINT'));
    })
    .catch((e: unknown) => {
      console.error('[startup] Fatal error:', e);
      process.exit(1);
    });
}
