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
import { registerAuthRoutes, createUser, userCount, cleanupSessions } from './auth.ts';
import { registerHealthRoutes } from './health.ts';
import { initStorage } from './storage-instance.ts';
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
import { registerVaultRoutes } from './vault.ts';
import { registerOutputFileRoutes } from './output-files.ts';
import { registerGeneratedDocRoutes } from './generated-docs.ts';
import { registerPresentationRoutes } from './presentations.ts';
import { registerDocTemplateRoutes } from './doc-templates.ts';
import { registerReviewRoutes } from './review.ts';
import { registerLoopSpecRoutes } from './loop-specs.ts';
import { registerInsightsRoutes } from './insights.ts';
import { registerDashboardRoutes } from './dashboard.ts';
import { registerApiTokenRoutes } from './api-tokens.ts';
import { registerAuditRoutes } from './audit.ts';
import { registerLearnRoutes } from './learn.ts';
import { registerControlPlaneRoutes } from './control-plane.ts';
import { registerIntegrationRoutes } from './integrations.ts';
import { registerAwsAccountRoutes } from './aws-accounts.ts';
import { registerSessionFileRoutes } from './session-files.ts';
import { registerTerminalRoutes, handleTerminalUpgrade, shutdownAllTerminals } from './terminal.ts';
import { registerSessionLifecycleRoutes, startIdleStopTimer, stopIdleStopTimer } from './session-lifecycle.ts';
import { registerCredentialRoutes } from './credentials.ts';
import { registerUserConfigRoutes } from './user-config.ts';
import { registerScanRoutes } from './scan.ts';
import { registerMcpRoutes } from './mcp-routes.ts';
import { registerTestingRoutes } from './testing/index.ts';
import { registerThemeRoutes } from './themes.ts';
import { registerPortalEventsRoutes } from './portal-events.ts';
import { registerAiAttachmentRoutes, cleanupOrphanedAttachments } from './ai-attachments.ts';
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
  // Skip if already open — tests may inject an in-memory DB before calling startServer.
  if (!isDbOpen()) {
    openDb(`${cfg.dataDir}/portal.db`, cfg);
  }

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
  registerVaultRoutes();
  registerOutputFileRoutes();
  registerGeneratedDocRoutes();
  registerPresentationRoutes();
  registerDocTemplateRoutes();
  registerReviewRoutes();
  registerLoopSpecRoutes();
  registerInsightsRoutes();
  registerDashboardRoutes();
  registerApiTokenRoutes();
  registerAuditRoutes();
  registerLearnRoutes();
  registerControlPlaneRoutes();
  registerIntegrationRoutes();
  registerAwsAccountRoutes();
  registerSessionFileRoutes();
  registerTerminalRoutes();
  registerSessionLifecycleRoutes();
  registerScanRoutes();
  registerUserConfigRoutes();
  registerCredentialRoutes();
  registerMcpRoutes();
  registerTestingRoutes();
  registerThemeRoutes();
  registerPortalEventsRoutes();
  registerAiAttachmentRoutes();
  registerBedrockSsoRoutes();
  registerKiroSettingsRoutes();
  registerEngineModelRoutes();
  registerSessionContextRoutes();
  registerJiraRoutes();
  registerBrowserLiveRoutes();

  // 6. Auto-create admin from env vars if no users exist
  if (
    userCount() === 0 &&
    process.env.ADMIN_EMAIL &&
    process.env.ADMIN_PASSWORD
  ) {
    createUser({
      email: process.env.ADMIN_EMAIL,
      name: process.env.ADMIN_NAME ?? 'Admin',
      password: process.env.ADMIN_PASSWORD,
      isAdmin: true,
    });
    console.log(`[setup] Created admin account ${process.env.ADMIN_EMAIL}`);
  }

  // 7. Start HTTP server
  const server = createServer();

  // Register WebSocket upgrade handlers (terminal + browser live)
  const BROWSER_LIVE_RE = /^\/api\/workflows\/[^/]+\/browser\/live$/;
  setWsUpgradeHandler((req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/api/terminal/ws') {
      handleTerminalUpgrade(req, socket, head);
    } else if (BROWSER_LIVE_RE.test(url.pathname)) {
      handleBrowserLiveUpgrade(req, socket, head);
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

  if (userCount() === 0) {
    console.log('Open the address above to create the first admin account.');
  }

  // 8. Periodic session cleanup every 6 hours
  const sessionCleanupTimer = setInterval(() => {
    if (isDbOpen()) cleanupSessions();
  }, 6 * 3600_000);
  sessionCleanupTimer.unref();

  // 8b. Periodic AI attachment orphan cleanup (every 6 hours)
  const attachmentCleanupTimer = setInterval(() => {
    if (isDbOpen()) cleanupOrphanedAttachments();
  }, 6 * 3600_000);
  attachmentCleanupTimer.unref();

  // 9. Idle-session stop timer (checks every minute)
  startIdleStopTimer();

  // 10. Graceful shutdown
  server.on('close', () => {
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
