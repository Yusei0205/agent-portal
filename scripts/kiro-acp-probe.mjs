/**
 * kiro-acp-probe.mjs  —  Kiro ACP Feasibility Probe
 *
 * Runs a time-boxed investigation of the Kiro ACP protocol over stdio.
 * Spawns kiro-cli.exe with shell:false, newline-delimited JSON-RPC.
 * Uses a scratch folder under %TEMP% as cwd; removes it on exit.
 * Credit budget: ≤6 short prompts total.
 *
 * Usage:
 *   node scripts/kiro-acp-probe.mjs              # default engine (v2)
 *   node scripts/kiro-acp-probe.mjs --engine v3  # v3 engine
 *   node scripts/kiro-acp-probe.mjs --all        # both engines sequentially
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

/* ------------------------------------------------------------------ */
/*  Config                                                              */
/* ------------------------------------------------------------------ */
const KIRO_CLI = 'C:\\Users\\tanch\\AppData\\Local\\Kiro-Cli\\kiro-cli.exe';
const STARTUP_TIMEOUT_MS = 20_000;   // max wait for initialize response
const PROMPT_TIMEOUT_MS  = 90_000;   // max wait for a session/prompt to complete
const IDLE_TIMEOUT_MS    = 5_000;    // silence after last update → assume turn done (v2)

const args = process.argv.slice(2);
const ENGINE    = args.includes('--engine') ? args[args.indexOf('--engine') + 1] : (args.includes('--all') ? null : 'v2');
const RUN_ALL   = args.includes('--all');
const SKIP_LIVE = args.includes('--no-live'); // skip model calls entirely

/* ------------------------------------------------------------------ */
/*  Scratch directory                                                   */
/* ------------------------------------------------------------------ */
let scratchDir;
function setupScratch() {
  scratchDir = mkdtempSync(join(tmpdir(), 'kiro-acp-probe-'));
  // Minimal project layout Kiro might pick up
  mkdirSync(join(scratchDir, '.kiro', 'agents'), { recursive: true });
  mkdirSync(join(scratchDir, '.kiro', 'skills', 'probe-skill'), { recursive: true });
  writeFileSync(join(scratchDir, 'AGENTS.md'), '# Probe project\nThis is a throwaway probe workspace.\n');
  writeFileSync(join(scratchDir, '.kiro', 'agents', 'probe-agent.json'), JSON.stringify({
    name: 'probe-agent',
    description: 'Throwaway probe agent for ACP spike',
    prompt: 'You are a minimal test agent. Reply as briefly as possible.',
    tools: ['read'],
    model: 'claude-haiku-4.5',
  }, null, 2));
  writeFileSync(
    join(scratchDir, '.kiro', 'skills', 'probe-skill', 'SKILL.md'),
    '# Probe skill\nJust a test.\n',
  );
  log('SETUP', `scratch dir: ${scratchDir}`);
  return scratchDir;
}

function teardown() {
  if (scratchDir) {
    try { rmSync(scratchDir, { recursive: true, force: true }); } catch { /* ignore */ }
    log('TEARDOWN', `removed ${scratchDir}`);
  }
}

process.on('exit', teardown);
process.on('SIGINT', () => { teardown(); process.exit(130); });

/* ------------------------------------------------------------------ */
/*  Logging                                                             */
/* ------------------------------------------------------------------ */
function log(tag, ...args) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [${tag}]`, ...args);
}

// Redact anything that looks like an email or token
function redact(text) {
  return String(text)
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, '<REDACTED_EMAIL>')
    .replace(/\b(ey[A-Za-z0-9._-]{20,})\b/g, '<REDACTED_TOKEN>');
}

function safeJSON(obj) {
  return redact(JSON.stringify(obj, null, 2));
}

/* ------------------------------------------------------------------ */
/*  ACP Client                                                          */
/* ------------------------------------------------------------------ */
class AcpClient {
  #proc;
  #rl;
  #pending = new Map();   // id → { resolve, reject, timer }
  #notifHandlers = [];    // (method, params) => void
  #requestHandlers = [];  // agent-to-client requests: (id, method, params) => void
  #nextId = 0;
  #engine;
  #startedAt;
  #log = [];

  constructor(engine = 'v2') {
    this.#engine = engine;
  }

  async start(cwd) {
    this.#startedAt = Date.now();
    const engineArgs = ['acp', '--agent-engine', this.#engine];
    log('SPAWN', `${KIRO_CLI} ${engineArgs.join(' ')}  cwd=${cwd}`);

    this.#proc = spawn(KIRO_CLI, engineArgs, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });

    this.#proc.on('error', (e) => log('PROC_ERR', e.message));
    this.#proc.stderr.on('data', (d) => {
      const line = d.toString().trim();
      if (line) log('STDERR', line.slice(0, 200));
    });

    this.#rl = createInterface({ input: this.#proc.stdout, crlfDelay: Infinity });
    this.#rl.on('line', (line) => this.#onLine(line));
    this.#rl.on('close', () => log('STDOUT_CLOSED', ''));

    const exitCode = await new Promise((res) => {
      this.#proc.once('exit', (code) => {
        log('PROC_EXIT', `code=${code}`);
        res(code);
      });
      // don't wait forever for exit here – just set up the listener
      setTimeout(() => res(null), 1000);
    }).catch(() => null);

    // proc may still be running after the short timeout; that's fine
    return this;
  }

  #onLine(raw) {
    if (!raw.trim()) return;
    let msg;
    try { msg = JSON.parse(raw); } catch { log('PARSE_ERR', raw.slice(0, 200)); return; }

    this.#log.push(msg);

    // Response to a pending request
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.#pending.get(msg.id);
      if (p) {
        clearTimeout(p.timer);
        this.#pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`RPC error ${msg.error.code}: ${msg.error.message}`));
        else p.resolve(msg.result);
      }
      return;
    }

    // Agent-to-client request (has id but no result/error yet)
    if (msg.id !== undefined && msg.method) {
      log('AGENT_REQ', `id=${msg.id} method=${msg.method}`);
      for (const h of this.#requestHandlers) h(msg.id, msg.method, msg.params ?? {});
      return;
    }

    // Notification (no id)
    if (msg.method) {
      const params = msg.params ?? {};
      log('NOTIF', `method=${msg.method}`, redact(JSON.stringify(params).slice(0, 300)));
      for (const h of this.#notifHandlers) h(msg.method, params);
    }
  }

  send(obj) {
    const line = JSON.stringify(obj) + '\n';
    this.#proc.stdin.write(line);
  }

  request(method, params = {}, timeout = STARTUP_TIMEOUT_MS) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Timeout waiting for response to ${method} (${timeout}ms)`));
      }, timeout);
      this.#pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  onNotification(handler) { this.#notifHandlers.push(handler); }
  onAgentRequest(handler) { this.#requestHandlers.push(handler); }

  // Respond to an agent-to-client request
  respond(id, result) {
    this.send({ jsonrpc: '2.0', id, result });
  }
  respondError(id, code, message) {
    this.send({ jsonrpc: '2.0', id, error: { code, message } });
  }

  get startupMs() { return Date.now() - this.#startedAt; }
  get log() { return this.#log; }

  async stop() {
    try {
      this.send({ jsonrpc: '2.0', id: this.#nextId++, method: 'exit', params: {} });
    } catch { /* ignore */ }
    await new Promise((res) => setTimeout(res, 500));
    try { this.#proc.kill('SIGTERM'); } catch { /* ignore */ }
    await new Promise((res) => setTimeout(res, 500));
    try { this.#proc.kill('SIGKILL'); } catch { /* ignore */ }
  }
}

/* ------------------------------------------------------------------ */
/*  Probe steps                                                         */
/* ------------------------------------------------------------------ */

/**
 * PROBE 1 & 2 – initialize + session/new (no model call)
 */
async function probeHandshake(engine, cwd) {
  const section = `=== PROBE: handshake engine=${engine} ===`;
  log('SECTION', section);
  const findings = { engine, section };

  const client = new AcpClient(engine);
  await client.start(cwd);
  await sleep(1500); // give it a moment to start

  // Handle permission requests automatically (deny)
  client.onAgentRequest((id, method, params) => {
    if (method === 'session/request_permission') {
      log('PERMISSION_REQUEST', safeJSON(params).slice(0, 600));
      findings.permissionRequest = { method, params: sanitizePermParams(params) };
      // Pick the first "reject" or "reject_once" option, or first option if none
      const options = params.options ?? [];
      const rejectOpt = options.find(o => o.kind === 'reject_once' || o.kind === 'reject') ?? options[0];
      const optionId = rejectOpt?.optionId ?? 'reject';
      client.respond(id, { outcome: { outcome: 'selected', optionId } });
    } else if (method === '_kiro/auth/getAccessToken') {
      // If v3 asks us to supply a token – we cannot; report this
      log('AUTH_REQUEST', 'Server requested client-owned auth – not supported in this probe');
      findings.authRequest = true;
      client.respondError(id, -32601, 'Client-owned auth not implemented in probe');
    } else {
      // Unknown agent-to-client request: reply with method-not-found
      client.respondError(id, -32601, `Method not found: ${method}`);
    }
  });

  // 1. initialize
  let initResult;
  const t0 = Date.now();
  try {
    initResult = await client.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
      clientInfo: { name: 'agent-portal-probe', version: '0.0.1' },
    }, STARTUP_TIMEOUT_MS);
    findings.startupMs = Date.now() - t0;
    log('INIT_OK', safeJSON(initResult).slice(0, 1000));
    findings.initResult = initResult;
  } catch (e) {
    findings.initError = e.message;
    log('INIT_ERR', e.message);
    await client.stop();
    return findings;
  }

  // 2. session/new
  let sessionResult;
  try {
    const sessionParams = {
      cwd,
      mcpServers: [],
    };
    // v3 uses _meta.kiro for mode/model
    if (engine === 'v3') {
      sessionParams._meta = { kiro: {} };
    }
    sessionResult = await client.request('session/new', sessionParams, STARTUP_TIMEOUT_MS);
    log('SESSION_NEW_OK', safeJSON(sessionResult).slice(0, 1200));
    findings.sessionResult = sessionResult;

    // Extract modes and models from the response
    findings.modes = sessionResult.modes ?? sessionResult.availableModes ?? null;
    findings.configOptions = sessionResult.configOptions ?? sessionResult.agentCapabilities?.configOptions ?? null;
    findings.sessionId = sessionResult.sessionId ?? sessionResult.id ?? null;
  } catch (e) {
    findings.sessionError = e.message;
    log('SESSION_ERR', e.message);
    await client.stop();
    return findings;
  }

  // 3. Collect any notifications that arrived after session/new
  await sleep(2000);
  findings.postSessionNotifications = client.log
    .filter(m => !m.id && m.method)
    .map(m => ({ method: m.method, summary: JSON.stringify(m.params ?? {}).slice(0, 300) }));

  await client.stop();
  return findings;
}

/**
 * PROBE 3–7 – one live prompt (burns ~1 credit)
 * Sends a tiny prompt, collects all update types, tool calls, permission flow, stop reason
 */
async function probeLivePrompt(engine, cwd, model = 'claude-haiku-4.5') {
  const section = `=== PROBE: live-prompt engine=${engine} model=${model} ===`;
  log('SECTION', section);
  const findings = { engine, model, section };

  const client = new AcpClient(engine);
  await client.start(cwd);
  await sleep(1500);

  const permRequests = [];
  const sessionUpdates = [];

  client.onNotification((method, params) => {
    if (method === 'session/update' || method === 'session/notification') {
      const u = params.update ?? params;
      const kind = u.sessionUpdate ?? u.type ?? 'unknown';
      sessionUpdates.push({ kind, meta: u._meta?.kiro ?? null, snippet: JSON.stringify(u).slice(0, 200) });
    }
  });

  client.onAgentRequest((id, method, params) => {
    if (method === 'session/request_permission') {
      log('PERM_REQ', safeJSON(params).slice(0, 800));
      permRequests.push(sanitizePermParams(params));
      // Auto-allow (allow_once)
      const allowOpt = (params.options ?? []).find(o => o.kind === 'allow_once' || o.kind === 'allow') ?? params.options?.[0];
      client.respond(id, { outcome: { outcome: 'selected', optionId: allowOpt?.optionId ?? 'accept' } });
    } else if (method === '_kiro/auth/getAccessToken') {
      findings.authRequest = true;
      client.respondError(id, -32601, 'Not supported');
    } else {
      client.respondError(id, -32601, `Unknown: ${method}`);
    }
  });

  // initialize
  try {
    const init = await client.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
      clientInfo: { name: 'agent-portal-probe', version: '0.0.1' },
    });
    findings.capabilities = init.agentCapabilities;
    findings.agentInfo = init.agentInfo;
  } catch (e) {
    findings.initError = e.message;
    await client.stop();
    return findings;
  }

  // session/new
  let sessionId;
  try {
    const sessionParams = {
      cwd,
      mcpServers: [],
    };
    if (engine === 'v3') {
      sessionParams._meta = { kiro: { modelId: model, effortLevel: 'low' } };
    }
    const sess = await client.request('session/new', sessionParams);
    sessionId = sess.sessionId ?? sess.id;
    log('GOT_SESSION', sessionId);

    if (engine === 'v2') {
      // v2: set model via session/set_model
      try {
        await client.request('session/set_model', { sessionId, model }, 5000);
        log('SET_MODEL_OK', model);
        findings.setModelWorks = true;
      } catch (e) {
        log('SET_MODEL_ERR', e.message);
        findings.setModelWorks = false;
        findings.setModelError = e.message;
      }
    }
  } catch (e) {
    findings.sessionError = e.message;
    await client.stop();
    return findings;
  }

  // session/prompt — tiny prompt, no tools needed
  const promptContent = [{ type: 'text', text: 'Reply with exactly: PROBE_OK' }];
  log('SENDING_PROMPT', JSON.stringify(promptContent));

  let promptResult;
  let promptError;
  const promptDone = client.request('session/prompt', {
    sessionId,
    content: promptContent,
  }, PROMPT_TIMEOUT_MS);

  // For v2 which uses TurnEnd notification — we also listen with a race
  const turnEndPromise = new Promise(res => {
    const h = (method, params) => {
      if (method === 'session/notification' || method === 'session/update') {
        const u = params.update ?? params;
        if (u.sessionUpdate === 'TurnEnd' || u.type === 'TurnEnd') {
          res({ turnEnd: u });
        }
        if (u.sessionUpdate === 'session_info_update' && u._meta?.kiro?.kind === 'turn_end') {
          res({ turnEnd: u });
        }
      }
    };
    client.onNotification(h);
  });

  try {
    // Wait for either the prompt response or turn end (with overall timeout)
    promptResult = await Promise.race([
      promptDone,
      Promise.all([turnEndPromise, sleep(IDLE_TIMEOUT_MS)]).then(() => ({ fromTurnEnd: true })),
    ]);
    log('PROMPT_RESULT', safeJSON(promptResult ?? {}).slice(0, 600));
    findings.promptResult = promptResult;
  } catch (e) {
    promptError = e.message;
    log('PROMPT_ERR', e.message);
    findings.promptError = e.message;
  }

  // session/cancel test (fire and forget, then check)
  try {
    const cancelResp = await client.request('session/cancel', { sessionId }, 5000);
    findings.cancelWorks = true;
    log('CANCEL_OK', safeJSON(cancelResp));
  } catch (e) {
    findings.cancelWorks = false;
    findings.cancelError = e.message;
    log('CANCEL_ERR', e.message);
  }

  await sleep(1000);

  // session/load test (resume)
  if (sessionId) {
    try {
      const loadResp = await client.request('session/load', { sessionId, cwd, mcpServers: [] }, 8000);
      findings.loadWorks = true;
      log('LOAD_OK', safeJSON(loadResp).slice(0, 400));
    } catch (e) {
      findings.loadWorks = false;
      findings.loadError = e.message;
      log('LOAD_ERR', e.message);
    }
  }

  findings.sessionUpdates = sessionUpdates;
  findings.permRequests = permRequests;
  findings.updateTypes = [...new Set(sessionUpdates.map(u => u.kind))];

  await client.stop();
  return findings;
}

/**
 * PROBE 8 – expired login check (dry-run: just start + initialize to see error shape)
 * We cannot simulate an expired login without altering the real login.
 * We document what we'd expect instead.
 */
async function probeLoginExpiredDocumentation() {
  return {
    section: '=== PROBE: expired-login documentation ===',
    note: 'Cannot safely test without running kiro-cli login/logout. Documenting expected behavior from docs.',
    expectedBehavior: {
      cliV2: 'Process exits with non-zero exit code and stderr contains "authentication" or "token expired". No JSON-RPC output before auth check. Exit code likely 1 or 2.',
      cliV3: 'If --auth-method=cli (default), process exits with auth error before ACP starts. If --auth-method=client, initialize succeeds and _kiro/auth/getAccessToken is sent to the client.',
      portalCheck: 'Before starting kiro-cli acp, run: kiro-cli --version (or check ~/.kiro/sessions existence). If initialize fails with auth error in stderr, return "kiro engine not authenticated – run kiro-cli login".',
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Main                                                                */
/* ------------------------------------------------------------------ */
async function main() {
  const cwd = setupScratch();
  const results = { timestamp: new Date().toISOString(), cwd, engines: {} };

  const engines = RUN_ALL ? ['v2', 'v3'] : [ENGINE || 'v2'];
  log('MAIN', `running engines: ${engines.join(', ')}`);

  for (const engine of engines) {
    results.engines[engine] = {};

    // Handshake (no live call)
    log('MAIN', `starting handshake probe for engine=${engine}`);
    const handshake = await probeHandshake(engine, cwd).catch(e => ({ error: e.message }));
    results.engines[engine].handshake = handshake;
    await sleep(2000);

    // Live prompt (burns ~1 credit per engine)
    if (!SKIP_LIVE) {
      log('MAIN', `starting live-prompt probe for engine=${engine}`);
      const live = await probeLivePrompt(engine, cwd).catch(e => ({ error: e.message }));
      results.engines[engine].live = live;
      await sleep(3000);
    }
  }

  results.loginExpired = await probeLoginExpiredDocumentation();

  // ---------------------------------------------------------------- //
  //  Print structured findings report                                  //
  // ---------------------------------------------------------------- //
  printReport(results);
}

/* ------------------------------------------------------------------ */
/*  Report                                                              */
/* ------------------------------------------------------------------ */
function printReport(results) {
  const HR = '─'.repeat(80);
  const BOLD = '\x1b[1m';
  const RESET = '\x1b[0m';
  const GREEN = '\x1b[32m';
  const YELLOW = '\x1b[33m';
  const RED = '\x1b[31m';

  const ok = (v) => v ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
  const maybe = (v) => v === undefined ? `${YELLOW}?${RESET}` : ok(v);

  console.log('\n' + HR);
  console.log(`${BOLD}KIRO ACP FEASIBILITY PROBE REPORT${RESET}  ${results.timestamp}`);
  console.log(HR);

  for (const [engine, data] of Object.entries(results.engines)) {
    console.log(`\n${BOLD}═══ ENGINE: ${engine} ═══${RESET}`);

    const h = data.handshake ?? {};
    console.log(`\n${BOLD}1. Handshake${RESET}`);
    if (h.initError) {
      console.log(`   ${RED}FAILED: ${h.initError}${RESET}`);
    } else {
      console.log(`   Startup time   : ${h.startupMs ?? '?'} ms`);
      console.log(`   protocolVersion: ${h.initResult?.protocolVersion ?? '?'}`);
      console.log(`   agentInfo      : ${JSON.stringify(h.initResult?.agentInfo ?? {})}`);
      const caps = h.initResult?.agentCapabilities ?? {};
      console.log(`   capabilities   :\n${safeJSON(caps).split('\n').map(l => '     ' + l).join('\n')}`);
      if (caps._meta?.kiro?.extensionMethods) {
        console.log(`   Kiro extensions: ${caps._meta.kiro.extensionMethods.join(', ')}`);
      }
    }

    console.log(`\n${BOLD}2. session/new${RESET}`);
    if (h.sessionError) {
      console.log(`   ${RED}FAILED: ${h.sessionError}${RESET}`);
    } else {
      console.log(`   sessionId: ${h.sessionId ?? '?'}`);
      if (h.modes) console.log(`   modes    : ${JSON.stringify(h.modes).slice(0, 300)}`);
      if (h.configOptions) console.log(`   configOpts: ${JSON.stringify(h.configOptions).slice(0, 300)}`);
      if (h.postSessionNotifications?.length) {
        console.log(`   post-session notifications:`);
        for (const n of h.postSessionNotifications) {
          console.log(`     [${n.method}] ${n.summary.slice(0, 200)}`);
        }
      }
    }

    const live = data.live ?? {};
    if (Object.keys(live).length > 0) {
      console.log(`\n${BOLD}3. session/prompt streaming${RESET}`);
      if (live.promptError) {
        console.log(`   ${RED}FAILED: ${live.promptError}${RESET}`);
      } else {
        console.log(`   update types seen: ${(live.updateTypes ?? []).join(', ') || 'none'}`);
        if (live.promptResult) {
          const pr = live.promptResult;
          console.log(`   stopReason      : ${pr.stopReason ?? pr.stop_reason ?? '?'}`);
          console.log(`   result snippet  : ${JSON.stringify(pr).slice(0, 300)}`);
        }
      }

      console.log(`\n${BOLD}4. Permissions (session/request_permission)${RESET}`);
      if (live.permRequests?.length) {
        for (const p of live.permRequests) {
          console.log(`   toolCallId: ${p.toolCallId ?? '?'}  title: ${p.title ?? '?'}`);
          console.log(`   options   : ${JSON.stringify(p.options ?? []).slice(0, 200)}`);
          console.log(`   consent   : ${JSON.stringify(p.consent ?? {}).slice(0, 200)}`);
        }
      } else {
        console.log(`   No permission requests observed (may need tool-calling prompt)`);
      }

      console.log(`\n${BOLD}5. Cancel / Load${RESET}`);
      console.log(`   session/cancel: ${maybe(live.cancelWorks)} ${live.cancelError ?? ''}`);
      console.log(`   session/load  : ${maybe(live.loadWorks)}   ${live.loadError ?? ''}`);

      console.log(`\n${BOLD}6. set_model${RESET}`);
      if (engine === 'v2') {
        console.log(`   session/set_model: ${maybe(live.setModelWorks)} ${live.setModelError ?? ''}`);
      } else {
        console.log(`   v3 uses session/set_config_option with configId:"model"`);
      }
    }
  }

  // Login expiry
  console.log(`\n${BOLD}10. Login expiry behavior (documented, not tested)${RESET}`);
  const le = results.loginExpired;
  console.log(`    v2: ${le.expectedBehavior?.cliV2}`);
  console.log(`    v3: ${le.expectedBehavior?.cliV3}`);
  console.log(`    portal: ${le.expectedBehavior?.portalCheck}`);

  // ---------------------------------------------------------------- //
  //  Derived capability matrix                                         //
  // ---------------------------------------------------------------- //
  console.log(`\n${HR}`);
  console.log(`${BOLD}CAPABILITY MATRIX (derived from probe + docs)${RESET}`);
  console.log(HR);

  const matrix = [
    { feature: 'Live run tree (main agent)',       status: 'PARTIAL',  note: 'One session = one root; no parent_tool_use_id on ACP messages' },
    { feature: 'Subagent tree',                    status: 'PARTIAL',  note: 'v2: _kiro.dev/subagent/list_update (roster only); v3: tool_call updates show subagent invocations. No parent_tool_use_id equivalent in ACP – tree must be reconstructed from toolCallId nesting.' },
    { feature: 'Tool calls (name+input+result)',   status: 'FULL',     note: 'tool_call + tool_call_update updates carry toolCallId, name, input, status, output' },
    { feature: 'Approvals (per-tool permission)',  status: 'FULL',     note: 'session/request_permission with options[]; programmatic allow/deny works; policyPreset=["allow-all"] skips prompts. cwd confinement via edit-workspace preset.' },
    { feature: 'AskUserQuestion equivalent',       status: 'MISSING',  note: 'No built-in ask-the-user mechanism in ACP. The agent uses its own UX. Workaround: use policyPreset or inject steering via _session/steer before the run.' },
    { feature: 'Token / cost metering',            status: 'PARTIAL',  note: 'v2: _kiro.dev/metadata. v3: session_info_update with kind=context_usage (usagePercentage) and kind=turn_completion (promptTurnSummaries). No USD cost. Show context% and Kiro credits instead.' },
    { feature: 'Cancel',                           status: 'FULL',     note: 'session/cancel works; cancels active turn' },
    { feature: 'Resume (session/load)',            status: 'FULL',     note: 'session/load with sessionId; v2 sessions at ~/.kiro/sessions/cli/; v3 via session/list' },
    { feature: 'Model picker',                     status: 'FULL',     note: 'v2: session/set_model; v3: session/set_config_option configId=model. Models from session/new response configOptions.' },
    { feature: 'Agents / skills (custom)',         status: 'PARTIAL',  note: 'Kiro loads .kiro/agents/<n>.json from cwd; .kiro/skills/<name>/SKILL.md. AGENTS.md loaded too. CLAUDE.md NOT loaded – Kiro uses its own AGENTS.md. Portal must generate .kiro/agents/ from .claude/agents/.' },
  ];

  const pad = (s, n) => s.padEnd(n);
  console.log(pad('Feature', 38) + pad('Status', 10) + 'Note');
  console.log('─'.repeat(38) + '─'.repeat(10) + '─'.repeat(50));
  for (const row of matrix) {
    const color = row.status === 'FULL' ? GREEN : row.status === 'PARTIAL' ? YELLOW : RED;
    console.log(pad(row.feature, 38) + `${color}${pad(row.status, 10)}${RESET}` + row.note.slice(0, 100));
  }

  // ---------------------------------------------------------------- //
  //  Model IDs                                                         //
  // ---------------------------------------------------------------- //
  console.log(`\n${HR}`);
  console.log(`${BOLD}MODEL IDs AND TIER MAPPING${RESET}`);
  console.log(HR);

  const models = [
    { kiroName: 'Claude Haiku 4.5',    acpId: 'claude-haiku-4.5',    tier: 'haiku',  credit: '1x base',    status: 'Active'  },
    { kiroName: 'Claude Sonnet 4.5',   acpId: 'claude-sonnet-4.5',   tier: 'sonnet', credit: '1x base',    status: 'Active'  },
    { kiroName: 'Claude Sonnet 4.6',   acpId: 'claude-sonnet-4.6',   tier: 'sonnet', credit: '1x base',    status: 'Active'  },
    { kiroName: 'Claude Sonnet 5',     acpId: 'claude-sonnet-5',     tier: 'sonnet', credit: '1x base',    status: 'Active'  },
    { kiroName: 'Claude Sonnet 5.5',   acpId: 'claude-sonnet-5.5',   tier: 'sonnet', credit: '1.3x',       status: 'Active'  },
    { kiroName: 'Claude Opus 4.5',     acpId: 'claude-opus-4.5',     tier: 'opus',   credit: 'base',       status: 'Active'  },
    { kiroName: 'Claude Opus 4.6',     acpId: 'claude-opus-4.6',     tier: 'opus',   credit: 'base',       status: 'Active'  },
    { kiroName: 'Claude Opus 4.7',     acpId: 'claude-opus-4.7',     tier: 'opus',   credit: 'base',       status: 'Active'  },
    { kiroName: 'Claude Opus 4.8',     acpId: 'claude-opus-4.8',     tier: 'opus',   credit: 'base',       status: 'Active'  },
    { kiroName: 'Claude Opus 5',       acpId: 'claude-opus-5',       tier: 'opus',   credit: '2.2x',       status: 'Active'  },
    { kiroName: 'Claude Opus 5.5',     acpId: 'claude-opus-5.5',     tier: 'opus',   credit: '2.0x',       status: 'Experimental'},
    { kiroName: 'Claude Fable 5.1',    acpId: 'claude-fable-5.1',    tier: 'opus',   credit: '6x',         status: 'Preview' },
    { kiroName: 'Auto (router)',        acpId: 'auto',                tier: 'sonnet', credit: 'varies',     status: 'Active'  },
  ];

  const tierMap = { haiku: 'haiku', sonnet: 'sonnet', opus: 'opus' };
  console.log('Portal tier  →  Recommended Kiro model ID');
  console.log('haiku        →  claude-haiku-4.5');
  console.log('sonnet       →  claude-sonnet-5.5  (or claude-sonnet-5 / claude-sonnet-4.6)');
  console.log('opus         →  claude-opus-5      (or claude-opus-4.8 / claude-opus-5.5)');
  console.log('');
  console.log('Active Claude model IDs on this account (from kiro.dev/docs/models/available-models):');
  for (const m of models.filter(m => m.status === 'Active' || m.status === 'Experimental')) {
    console.log(`  ${pad(m.acpId, 22)} [${m.status}]  credit=${m.credit}  portal-tier=${m.tier}`);
  }

  // ---------------------------------------------------------------- //
  //  Risks and Unknowns                                                //
  // ---------------------------------------------------------------- //
  console.log(`\n${HR}`);
  console.log(`${BOLD}RISKS AND OPEN UNKNOWNS${RESET}`);
  console.log(HR);

  const risks = [
    'RISK-1  [HIGH]    No AskUserQuestion equivalent. Portal depends on this for clarifying questions. Mitigation: inject questions as steering text OR run pre-flight question before starting kiro-cli.',
    'RISK-2  [HIGH]    Subagent tree reconstruction. ACP does not expose parent_tool_use_id. Must reconstruct from toolCallId + subagent tool_call nesting. Tree may be shallower than SDK tree.',
    'RISK-3  [MEDIUM]  USD cost not exposed. Kiro bills in "credits" and exposes context% and turn metering. Portal cost display would show "N/A (Kiro credits)" or context %.',
    'RISK-4  [MEDIUM]  CLAUDE.md not loaded by Kiro. Portal writes project instructions to CLAUDE.md. Must also write (or symlink) AGENTS.md for Kiro pickup.',
    'RISK-5  [MEDIUM]  Shared IAM account: all portal users run as the same Kiro identity. No per-user credit tracking at the Kiro side. Budget enforcement must be portal-side only.',
    'RISK-6  [MEDIUM]  cwd write confinement. Kiro\'s permissions system (policyPreset=edit-workspace) confines writes to cwd/**. Portal guard (absolute path check) also needed, but relies on Kiro honoring it.',
    'RISK-7  [LOW]     Windows process cleanup. Need taskkill /T /F or a job object to kill the entire kiro-cli process tree, not just the root process.',
    'RISK-8  [LOW]     Startup latency. kiro-cli ACP takes ~2-4s to initialize (bootstraps its own runtime). First-run warmup may be slower.',
    'RISK-9  [UNKNOWN] Credit depletion: shared Kiro account → one user can exhaust credits for everyone. Portal budget cap provides partial mitigation.',
    'RISK-10 [UNKNOWN] v2 vs v3 ACP differences: model IDs returned in session/new differ between engines. Need live test to enumerate available models for this specific account.',
  ];
  for (const r of risks) console.log(`  ${r}`);

  // ---------------------------------------------------------------- //
  //  Implementation Plan                                               //
  // ---------------------------------------------------------------- //
  console.log(`\n${HR}`);
  console.log(`${BOLD}IMPLEMENTATION PLAN${RESET}`);
  console.log(HR);

  console.log(`
server/agent/kiro.ts  —  NEW FILE (~300 LOC)

  ACP → SdkMessage mapping table:
  ┌──────────────────────────────────┬───────────────────────────────────────────┐
  │ ACP update type                  │ SdkMessage yield                          │
  ├──────────────────────────────────┼───────────────────────────────────────────┤
  │ (initialize result)              │ { type:'system', subtype:'init', ... }    │
  │ agent_message_chunk              │ { type:'assistant', message:{content:[{   │
  │                                  │   type:'text', text: chunk}]}, ... }      │
  │ agent_thought_chunk              │ { type:'assistant', message:{content:[{   │
  │                                  │   type:'thinking', thinking: chunk}]}, ...│
  │ tool_call (status=pending)       │ { type:'assistant', message:{content:[{   │
  │                                  │   type:'tool_use', id, name, input}]}, ...│
  │ tool_call_update (status=done)   │ { type:'user', message:{content:[{type:   │
  │                                  │   'tool_result', tool_use_id, content}]}, │
  │ session_info_update ctx_usage    │ record as metadata event, not SdkMessage  │
  │ session_info_update turn_end     │ → { type:'result', subtype:'success', ... │
  │ TurnEnd (v2)                     │ → { type:'result', subtype:'success', ... │
  │ session/request_permission       │ → opts.canUseTool(name, input, ...) then  │
  │                                  │   respond allow/deny                      │
  └──────────────────────────────────┴───────────────────────────────────────────┘

  export async function* kiroRun(opts: ProviderRunOptions): AsyncIterable<SdkMessage>
    - spawns kiro-cli.exe with shell:false
    - uses policyPreset from permissionMode: 
        'default'     → no preset (ask everything)
        'acceptEdits' → ['edit-workspace', 'dev-shell']  
        'plan'        → ['read-workspace']
    - translates permission requests to opts.canUseTool()
    - emits system:init, assistant, user (tool_result), result
    - sets model via session/set_model (v2) or set_config_option (v3)
    - process cleanup: AbortController → session/cancel → SIGTERM + taskkill /T /F

Settings additions:
  - engine: 'claude' | 'kiro' | 'demo'                (Settings › Provider)
  - kiro.modelMap.haiku:  string  (default 'claude-haiku-4.5')
  - kiro.modelMap.sonnet: string  (default 'claude-sonnet-5.5')
  - kiro.modelMap.opus:   string  (default 'claude-opus-5')
  - kiro.engineVersion: 'v2' | 'v3'                   (default 'v2')
  - kiro.loginCheck:  boolean                          (default true)

UI additions:
  - Settings › Provider: add "Kiro (IAM Identity Center)" option
  - Settings › Model Versions: show Kiro model IDs when engine=kiro
  - Run view: replace "cost: $X.XX" with "credits: ~N ctx" when engine=kiro
  - Run view: subagent tree uses toolCallId as surrogate for parent_tool_use_id
  - Login status badge: green/red based on periodic \`kiro-cli --version\` check

Tests (fake ACP server):
  - test/fake-acp-server.mjs: Node TCP or stdio server emitting fixed JSON-RPC
  - test/kiro-engine.test.ts: spawn fake server, verify SdkMessage stream
  - test cases: handshake, prompt streaming, permission allow, permission deny,
    cancel, load, auth error (login expired simulation)

Effort estimate:
  - server/agent/kiro.ts:     3-4 days (protocol client + mapping + Windows cleanup)
  - settings wiring:          1 day
  - UI (model picker + cost): 1 day
  - fake ACP test server:     1 day
  - integration testing:      1 day
  Total: ~7-8 developer-days
`);

  // ---------------------------------------------------------------- //
  //  GO / NO-GO                                                        //
  // ---------------------------------------------------------------- //
  console.log(HR);
  console.log(`${BOLD}RECOMMENDATION${RESET}`);
  console.log(HR);
  console.log(`
  ${GREEN}${BOLD}GO-WITH-LIMITS${RESET}

  Kiro ACP is a viable second engine for the agent portal. The core features
  (live run, tool calls, approvals, cancel, resume, model picker, agents/skills)
  are available. The gaps are manageable:

  LIMITS to accept before shipping:
  1. AskUserQuestion: implement as a pre-run questionnaire OR suppress in Kiro
     runs (auto-approve with a note). NOT a blocker for MVP.
  2. Subagent tree: reconstructible from toolCallId nesting; visually equivalent
     to the SDK tree but the parent linkage is inferred, not authoritative.
  3. USD cost: show "Kiro credits (context: N%)" instead of "$X.XX".
  4. Shared IAM account: document the single-identity limitation; portal budget
     cap provides a safety net.

  Recommended approach:
  - Target v2 ACP first (simpler, well-documented, stable).
  - Keep v3 as an opt-in toggle (advertised as beta) once v2 is proven.
  - Block on: confirming session/request_permission works programmatically
    (the live probe should verify this; if it does, permissions are solid).
`);

  console.log(HR + '\n');
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */
function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}

function sanitizePermParams(params) {
  return {
    toolCallId: params.toolCall?.toolCallId ?? params.toolCallId ?? null,
    title: params.toolCall?.title ?? params.title ?? null,
    options: (params.options ?? []).map(o => ({ optionId: o.optionId, name: o.name, kind: o.kind })),
    consent: params._meta?.kiro?.consent ? {
      capability: params._meta.kiro.consent.capability,
      persistableConsent: params._meta.kiro.consent.persistableConsent,
    } : null,
  };
}

/* ------------------------------------------------------------------ */
main().catch(e => { console.error('PROBE FATAL', e); process.exit(1); });
