import http from 'node:http';
import { config, ensureDataDirs } from './config.ts';
import { openDb, closeDb } from './db.ts';
import { createHandler } from './http.ts';
import { authenticate, cleanupSessions, createUser, registerAuthRoutes, userCount } from './auth.ts';
import { registerSettingsRoutes } from './settings.ts';
import { registerSsoRoutes } from './sso.ts';
import { registerProjectRoutes } from './projects.ts';
import { registerRepoRoutes } from './repos.ts';
import { registerCodeCommitRoutes } from './codecommit.ts';
import { registerKnowledgeRoutes } from './knowledge.ts';
import { registerBuilderRoutes } from './builder.ts';
import { registerRunRoutes } from './runs.ts';
import { registerReviewRoutes } from './review.ts';
import { registerLearnRoutes } from './learn.ts';
import { recoverRuns } from './agent/runner.ts';

let routesRegistered = false;

export async function startServer(opts: { port?: number; host?: string } = {}): Promise<http.Server> {
  ensureDataDirs();
  openDb();
  if (!routesRegistered) {
    registerAuthRoutes();
    registerSettingsRoutes();
    registerSsoRoutes();
    registerProjectRoutes();
    registerRepoRoutes();
    registerCodeCommitRoutes();
    registerKnowledgeRoutes();
    registerBuilderRoutes();
    registerRunRoutes();
    registerReviewRoutes();
    registerLearnRoutes();
    routesRegistered = true;
  }
  recoverRuns();
  cleanupSessions();

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
  const addr = server.address();
  const shown = typeof addr === 'object' && addr ? `http://${host === '0.0.0.0' ? 'localhost' : host}:${addr.port}` : String(addr);
  console.log(`Agent Portal is running at ${shown}`);
  console.log(`Data folder: ${config.dataDir}`);
  if (userCount() === 0) console.log('Open the address above to create the first admin account.');
  const timer = setInterval(cleanupSessions, 6 * 3600_000);
  timer.unref();
  server.on('close', () => {
    clearInterval(timer);
    closeDb();
  });
  return server;
}

const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('server.mjs') || process.argv[1]?.endsWith('index.ts');
if (isMain && !process.env.PORTAL_NO_AUTOSTART) {
  startServer().then((server) => {
    const stop = () => {
      console.log('Shutting down…');
      server.close();
      setTimeout(() => process.exit(0), 2000).unref();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
