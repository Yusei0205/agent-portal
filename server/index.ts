/**
 * Agent Portal server entry point.
 *
 * Loads config, opens the database, registers all routes, starts listening.
 */

import { loadConfig, setConfig, ensureDataDirs } from './config.ts';
import type { Config } from './config.ts';
import { openDb, closeDb, isDbOpen } from './db.ts';
import { createServer, clearRoutes } from './http.ts';
import { registerAuthRoutes, createUser, userCount, cleanupSessions } from './auth.ts';
import { registerHealthRoutes } from './health.ts';
import { registerPermissionRoutes } from './permissions.ts';

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

  // 3. Open database and run migrations.
  // Skip if already open — tests may inject an in-memory DB before calling startServer.
  if (!isDbOpen()) {
    openDb(`${cfg.dataDir}/portal.db`, cfg);
  }

  // 4. Register routes (clear any previously registered routes first for test isolation)
  clearRoutes();
  registerAuthRoutes();
  registerHealthRoutes();
  registerPermissionRoutes();

  // 5. Auto-create admin from env vars if no users exist
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

  // 6. Start HTTP server
  const server = createServer();
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

  // 7. Periodic session cleanup every 6 hours
  const sessionCleanupTimer = setInterval(() => {
    if (isDbOpen()) cleanupSessions();
  }, 6 * 3600_000);
  sessionCleanupTimer.unref();

  // 8. Graceful shutdown
  server.on('close', () => {
    clearInterval(sessionCleanupTimer);
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
