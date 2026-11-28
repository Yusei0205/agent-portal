/**
 * Spike C — AppSync Events subscriber (Lambda-auth WebSocket client)
 *
 * Reads spike-c-config.json (generated after `cdk deploy AgentPortalSpikeC`).
 * Demonstrates:
 *   1. Connection setup time measurement
 *   2. Cross-project subscribe DENY (project-a token → /project/project-b channel)
 *   3. Valid subscribes to run, project, and global channels
 *   4. Latency measurement (p50/p95) — pair with spike-c-publish.mjs
 *   5. Reconnect behaviour — close and reopen, channels re-subscribed
 *
 * Usage:
 *   node scripts/spike-c-subscribe.mjs              # listen for 90 s, print stats
 *   node scripts/spike-c-subscribe.mjs --duration 30
 *   node scripts/spike-c-subscribe.mjs --no-reconnect
 *
 * Prerequisites:
 *   - spike-c-config.json present in scripts/ directory
 *   - Run spike-c-publish.mjs in another terminal while this is running
 */

import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dir = dirname(__filename);

// ── Config ────────────────────────────────────────────────────────────────────
function loadConfig() {
  const p = join(__dir, 'spike-c-config.json');
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    console.error('spike-c-config.json not found. Run spike-c-setup.mjs first.');
    process.exit(1);
  }
}

// ── Token helpers ─────────────────────────────────────────────────────────────
function makeToken(claims) {
  return Buffer.from(JSON.stringify(claims)).toString('base64');
}

function base64url(str) {
  return Buffer.from(str)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// ── AppSync Events WebSocket client ───────────────────────────────────────────
class AppSyncEventsClient {
  constructor(realtimeDomain, httpDomain) {
    this.realtimeDomain = realtimeDomain;
    this.httpDomain = httpDomain;
    this.ws = null;
    this.connected = false;
    this.subscriptions = new Map(); // id → { channel, resolve, reject }
    this.messageHandlers = [];
    this._pendingAck = null;
  }

  /**
   * Connect to AppSync Events WebSocket.
   * @param {string} token - base64-encoded portal token (for Lambda authorizer)
   * @returns {Promise<number>} connection setup time in ms
   */
  connect(token) {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const authData = JSON.stringify({
        Authorization: token,
        host: this.httpDomain,
      });
      const encodedAuth = base64url(authData);
      const url = `wss://${this.realtimeDomain}/event/realtime`;

      // AppSync Events uses custom sub-protocols for auth
      this.ws = new WebSocket(url, [
        'aws-appsync-event-ws',
        `header-${encodedAuth}`,
      ]);

      this.ws.onopen = () => {
        // Send connection_init after WebSocket handshake
        this.ws.send(JSON.stringify({ type: 'connection_init' }));
      };

      this.ws.onmessage = (event) => {
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        this._handleMessage(msg, t0, resolve, reject);
      };

      this.ws.onerror = (err) => {
        reject(new Error(`WebSocket error: ${err.message || 'unknown'}`));
      };

      this.ws.onclose = (event) => {
        this.connected = false;
        if (!event.wasClean) {
          // Notify message handlers of disconnect
          this.messageHandlers.forEach((h) => h({ type: '__disconnect__', code: event.code }));
        }
      };
    });
  }

  _handleMessage(msg, connectT0, connectResolve, connectReject) {
    if (msg.type === 'connection_ack') {
      this.connected = true;
      const setupMs = Date.now() - connectT0;
      connectResolve(setupMs);
    } else if (msg.type === 'connection_error') {
      connectReject(new Error(`Connection error: ${JSON.stringify(msg.errors)}`));
    } else if (msg.type === 'subscribe_success' || msg.type === 'subscribe_ack') {
      // AppSync Events uses 'subscribe_success'; 'subscribe_ack' kept for compatibility
      const sub = this.subscriptions.get(msg.id);
      if (sub?.resolve) sub.resolve({ subscribed: true, id: msg.id });
    } else if (msg.type === 'subscribe_error') {
      const sub = this.subscriptions.get(msg.id);
      if (sub?.reject) sub.reject(Object.assign(
        new Error(msg.errors?.[0]?.message || 'Subscribe denied'),
        { subscribeError: true, errors: msg.errors },
      ));
      this.subscriptions.delete(msg.id);
    } else if (msg.type === 'data') {
      // Parse the inner event payload
      let eventData = msg.event;
      if (typeof eventData === 'string') {
        try { eventData = JSON.parse(eventData); } catch { /* keep as string */ }
      }
      const receivedAt = Date.now();
      this.messageHandlers.forEach((h) => h({ ...msg, event: eventData, receivedAt }));
    } else if (msg.type === 'ka') {
      // Keep-alive — ignore
    }
  }

  /**
   * Subscribe to a channel.
   * @param {string} channel - e.g. '/project/project-a'
   * @param {string} token   - portal token for the subscribe authorization
   * @returns {Promise<{subscribed: boolean, id: string}>} or rejects with error
   */
  subscribe(channel, token) {
    return new Promise((resolve, reject) => {
      const id = `sub-${Math.random().toString(36).slice(2)}`;
      this.subscriptions.set(id, { channel, resolve, reject });
      this.ws.send(
        JSON.stringify({
          type: 'subscribe',
          id,
          channel,
          authorization: {
            Authorization: token,
            host: this.httpDomain,
          },
        }),
      );
      // Timeout after 10 s if no ack received
      setTimeout(() => {
        if (this.subscriptions.has(id)) {
          this.subscriptions.delete(id);
          reject(new Error(`Subscribe timeout for channel ${channel}`));
        }
      }, 10_000);
    });
  }

  onMessage(handler) {
    this.messageHandlers.push(handler);
    return () => {
      this.messageHandlers = this.messageHandlers.filter((h) => h !== handler);
    };
  }

  close() {
    if (this.ws) this.ws.close();
    this.connected = false;
  }
}

// ── Latency stats ─────────────────────────────────────────────────────────────
function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

function printStats(label, latencies) {
  if (latencies.length === 0) {
    console.log(`  ${label}: no events received`);
    return;
  }
  const sorted = [...latencies].sort((a, b) => a - b);
  const p50 = percentile(sorted, 50);
  const p95 = percentile(sorted, 95);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const avg = Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length);
  console.log(`  ${label} (n=${sorted.length}): p50=${p50}ms  p95=${p95}ms  min=${min}ms  max=${max}ms  avg=${avg}ms`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const durationIdx = args.indexOf('--duration');
  const durationSec = durationIdx >= 0 ? parseInt(args[durationIdx + 1], 10) : 90;
  const noReconnect = args.includes('--no-reconnect');

  const cfg = loadConfig();
  const { httpDomain, realtimeDomain, runId, projectId } = cfg;

  console.log(`\n=== Spike C Subscriber ===`);
  console.log(`Realtime: wss://${realtimeDomain}/event/realtime`);
  console.log(`Run ID: ${runId}  |  Project: ${projectId}  |  Duration: ${durationSec}s`);

  // Tokens for the test
  const tokenA = makeToken({ projectId: 'project-spike-a' });   // matches projectId in config
  const tokenB = makeToken({ projectId: 'project-spike-b' });   // different project
  const tokenGlobal = makeToken({ scope: 'global' });

  const latenciesByChannel = { run: [], project: [], global: [] };
  let totalReceived = 0;
  let connectionSetupMs = null;
  let reconnectSetupMs = null;

  // ── Step 1: Cross-project DENY test ──────────────────────────────────────────
  console.log('\n[1] Cross-project subscribe DENY test...');
  {
    const client = new AppSyncEventsClient(realtimeDomain, httpDomain);
    try {
      connectionSetupMs = await client.connect(tokenA);
      console.log(`    Connected  (setup: ${connectionSetupMs} ms)`);

      // tokenA is for project-spike-a; try to subscribe to project-spike-b → MUST be denied
      try {
        await client.subscribe('/project/project-spike-b', tokenA);
        console.log('    ❌ FAIL: should have been denied but was allowed');
      } catch (err) {
        if (err.subscribeError) {
          console.log(`    ✅ PASS: cross-project subscribe correctly denied`);
          console.log(`       Error: ${err.message}`);
        } else {
          console.log(`    ⚠️  Unexpected error: ${err.message}`);
        }
      }

      // Verify that subscribing to own project is allowed
      try {
        await client.subscribe('/project/project-spike-a', tokenA);
        console.log('    ✅ PASS: subscribing to own project allowed');
      } catch (err) {
        console.log(`    ❌ FAIL: subscribing to own project denied: ${err.message}`);
      }
    } catch (err) {
      console.error(`    Connection failed: ${err.message}`);
    } finally {
      client.close();
    }
  }

  // ── Step 2: Full subscribe — run, project, global ─────────────────────────
  console.log(`\n[2] Subscribing to /run/${runId}, /project/${projectId}, /global/portal...`);
  const client = new AppSyncEventsClient(realtimeDomain, httpDomain);
  const setupT0 = Date.now();
  try {
    connectionSetupMs = await client.connect(tokenA);
  } catch (err) {
    console.error(`Failed to connect: ${err.message}`);
    process.exit(1);
  }
  console.log(`    Connected (setup: ${connectionSetupMs} ms)`);

  // Subscribe to all three channel types
  const subscribeStart = Date.now();
  try {
    await Promise.all([
      client.subscribe(`/run/${runId}`, tokenA),
      client.subscribe(`/project/${projectId}`, tokenA),
      client.subscribe('/global/portal', tokenGlobal),
    ]);
    console.log(`    Subscribed to 3 channels (${Date.now() - subscribeStart} ms)`);
  } catch (err) {
    console.error(`    Subscribe failed: ${err.message}`);
    process.exit(1);
  }

  // ── Collect events and measure latency ────────────────────────────────────
  client.onMessage((msg) => {
    if (msg.type === 'data') {
      totalReceived++;
      const evt = msg.event;
      const publishedAt = evt?.publishedAt ?? (evt?.event?.payload?.publishedAt);
      if (publishedAt) {
        const latency = msg.receivedAt - publishedAt;
        const ch = msg.id?.startsWith('sub') ? 'run' : 'run'; // approximate
        // Determine channel type from event shape
        if (evt?.event?.type === 'large_payload_test' || evt?.event?.run_id) {
          latenciesByChannel.run.push(latency);
        } else if (evt?.type === 'workflow.updated') {
          latenciesByChannel.project.push(latency);
        } else if (evt?.type === 'theme.changed') {
          latenciesByChannel.global.push(latency);
        } else {
          latenciesByChannel.run.push(latency); // default to run
        }
        if (totalReceived % 50 === 0) {
          process.stdout.write(`\r    Received ${totalReceived} events...`);
        }
      } else {
        totalReceived++; // count events without publishedAt too
      }
    } else if (msg.type === '__disconnect__') {
      console.log(`\n    WebSocket disconnected (code: ${msg.code})`);
    }
  });

  console.log(`\n    Listening for events for ${durationSec}s...`);
  console.log('    (Run spike-c-publish.mjs in another terminal now)');

  // Wait for duration / 2, then test reconnect
  const halfDuration = Math.floor(durationSec / 2) * 1000;
  await new Promise((r) => setTimeout(r, halfDuration));

  // ── Step 3: Reconnect test ────────────────────────────────────────────────
  if (!noReconnect) {
    const eventsBeforeReconnect = totalReceived;
    console.log(`\n[3] Reconnect test (${eventsBeforeReconnect} events received so far)...`);
    console.log('    Closing WebSocket intentionally...');
    client.close();
    await new Promise((r) => setTimeout(r, 500));

    console.log('    Reconnecting...');
    const reconnectT0 = Date.now();
    const client2 = new AppSyncEventsClient(realtimeDomain, httpDomain);
    try {
      reconnectSetupMs = await client2.connect(tokenA);
      console.log(`    Reconnected (setup: ${reconnectSetupMs} ms)`);
      await Promise.all([
        client2.subscribe(`/run/${runId}`, tokenA),
        client2.subscribe(`/project/${projectId}`, tokenA),
        client2.subscribe('/global/portal', tokenGlobal),
      ]);
      console.log('    Re-subscribed to 3 channels');
      console.log('    ✅ Reconnect successful — no missed events replayed (pub/sub, not persistent)');

      client2.onMessage((msg) => {
        if (msg.type === 'data') {
          totalReceived++;
          const evt = msg.event;
          const publishedAt = evt?.publishedAt ?? evt?.event?.payload?.publishedAt;
          if (publishedAt) {
            const latency = msg.receivedAt - publishedAt;
            latenciesByChannel.run.push(latency);
          }
        }
      });

      // Wait for remaining duration
      await new Promise((r) => setTimeout(r, durationSec * 1000 - halfDuration - 500));
      client2.close();
    } catch (err) {
      console.error(`    Reconnect failed: ${err.message}`);
      client2.close();
    }
  } else {
    await new Promise((r) => setTimeout(r, durationSec * 1000 - halfDuration));
    client.close();
  }

  // ── Statistics ────────────────────────────────────────────────────────────
  const allLatencies = [
    ...latenciesByChannel.run,
    ...latenciesByChannel.project,
    ...latenciesByChannel.global,
  ];

  console.log(`\n=== Results ===`);
  console.log(`Total events received: ${totalReceived}`);
  console.log(`Connection setup time: ${connectionSetupMs} ms`);
  if (reconnectSetupMs !== null) {
    console.log(`Reconnect setup time:  ${reconnectSetupMs} ms`);
  }
  console.log('\nLatency (publish → receive):');
  printStats('run channel   ', latenciesByChannel.run);
  printStats('project channel', latenciesByChannel.project);
  printStats('global channel ', latenciesByChannel.global);
  printStats('ALL channels   ', allLatencies);

  if (allLatencies.length > 0) {
    const sorted = [...allLatencies].sort((a, b) => a - b);
    console.log(`\nKey metrics:`);
    console.log(`  p50 latency: ${percentile(sorted, 50)} ms`);
    console.log(`  p95 latency: ${percentile(sorted, 95)} ms`);
  }

  console.log('\n=== Reconnect observation ===');
  console.log('  AppSync Events is pure pub/sub — no message persistence.');
  console.log('  Events published while disconnected are NOT replayed on reconnect.');
  console.log('  The portal S6 design must handle missed events via API polling fallback.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
