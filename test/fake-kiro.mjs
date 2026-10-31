#!/usr/bin/env node
// Fake kiro-cli for portal engine tests.
// Dispatches based on process.argv[2] (the subcommand):
//   chat      → agent run scenarios (existing)
//   whoami    → login status check (new)
//   login     → device-flow login (new)
//   logout    → sign out (new)
//
// Scenario controlled via PORTAL_FAKE_KIRO_SCENARIO env var.

const subCommand = process.argv[2]; // '--version', 'chat', 'whoami', 'login', 'logout'
const scenario = process.env.PORTAL_FAKE_KIRO_SCENARIO || 'normal';

// ── --version ─────────────────────────────────────────────────────────────────

if (subCommand === '--version') {
  process.stdout.write((process.env.PORTAL_FAKE_KIRO_VERSION || '2.37.0-fake') + '\n');
  process.exit(0);
}

// ── whoami ────────────────────────────────────────────────────────────────────

if (subCommand === 'whoami') {
  if (scenario === 'not-installed' || scenario === 'missing') {
    process.exit(127);
  }
  if (scenario === 'signed-out') {
    process.stderr.write('Not signed in\n');
    process.exit(1);
  }
  if (scenario === 'builder-id') {
    process.stdout.write('Logged in with Builder ID\nEmail: user@example.com\n');
    process.exit(0);
  }
  if (scenario === 'identity-center') {
    process.stdout.write(
      'Logged in with IAM Identity Center (https://d-xxxxxxxxxx.awsapps.com/start)\nEmail: admin@example.com\nProfile: CorpSSO\n',
    );
    process.exit(0);
  }
  // idc-hook-ignored: simulate a kiro-cli version that ignores KIRO_TEST_DB_PATH.
  // Returns the machine's own session regardless of whether KIRO_TEST_DB_PATH is set.
  if (scenario === 'idc-hook-ignored') {
    process.stdout.write(
      'Logged in with IAM Identity Center (https://d-xxxxxxxxxx.awsapps.com/start)\nEmail: machine@example.com\n',
    );
    process.exit(0);
  }
  // whoami-unrelated-error: simulate a failure unrelated to login state
  // (e.g. "error: home directory not found") — neither "signed in" nor "not signed in".
  if (scenario === 'whoami-unrelated-error') {
    process.stderr.write('error: home directory not found\n');
    process.exit(1);
  }
  // Default behaviour: honour KIRO_TEST_DB_PATH.
  // When KIRO_TEST_DB_PATH is set (self-check mode with an empty DB), report "not signed in"
  // to confirm the hook is active.  Without it, report the normal signed-in state.
  if (process.env.KIRO_TEST_DB_PATH) {
    process.stderr.write('Not signed in\n');
    process.exit(1);
  }
  // Default: signed in with IAM Identity Center
  process.stdout.write(
    'Logged in with IAM Identity Center (https://d-xxxxxxxxxx.awsapps.com/start)\nEmail: user@example.com\nProfile: MyProfile\n',
  );
  process.exit(0);
}

// ── login ─────────────────────────────────────────────────────────────────────

if (subCommand === 'login') {
  if (scenario === 'login-url') {
    // Combined URL shape
    process.stdout.write(
      'To sign in, visit: https://device.sso.us-east-1.amazonaws.com/?user_code=ABCD-1234\n',
    );
    // Hang until killed (simulating waiting for browser auth)
    await new Promise((r) => setTimeout(r, 30_000));
    process.exit(0);
  }
  if (scenario === 'login-url-separate') {
    // Separate URL and code shape
    process.stdout.write('Verification URL: https://device.sso.us-east-1.amazonaws.com\n');
    process.stdout.write('User code: WXYZ-5678\n');
    // Hang until killed
    await new Promise((r) => setTimeout(r, 30_000));
    process.exit(0);
  }
  if (scenario === 'login-complete') {
    // Prints URL then exits 0 quickly (login complete immediately)
    process.stdout.write(
      'To sign in, visit: https://device.sso.us-east-1.amazonaws.com/?user_code=DONE-0000\n',
    );
    await new Promise((r) => setTimeout(r, 50));
    process.exit(0);
  }
  if (scenario === 'login-failed') {
    process.stdout.write(
      'To sign in, visit: https://device.sso.us-east-1.amazonaws.com/?user_code=FAIL-1111\n',
    );
    await new Promise((r) => setTimeout(r, 50));
    process.exit(1);
  }
  if (scenario === 'login-no-url') {
    // Never prints a URL — timeout scenario
    await new Promise((r) => setTimeout(r, 30_000));
    process.exit(0);
  }
  // Default: print URL and hang
  process.stdout.write(
    'To sign in, visit: https://device.sso.us-east-1.amazonaws.com/?user_code=ABCD-1234\n',
  );
  await new Promise((r) => setTimeout(r, 30_000));
  process.exit(0);
}

// ── logout ────────────────────────────────────────────────────────────────────

if (subCommand === 'logout') {
  process.exit(0);
}

// ── chat with --list-models ───────────────────────────────────────────────────
// kiro-cli 2.37+: kiro-cli chat --list-models --format json  (preferred)
// kiro-cli 2.36.x: kiro-cli chat --list-models (plain text only)
//
// The fake returns JSON when --format json is requested, plain text otherwise.
// Scenario 'list-models-json-fallback' forces plain text even when JSON is
// requested (simulates an older CLI that ignores --format).

if (subCommand === 'chat' && process.argv.includes('--list-models')) {
  // Detect --format json or -f json
  const fIdx = process.argv.indexOf('--format');
  const sfIdx = process.argv.indexOf('-f');
  const fmtArg = fIdx >= 0 ? process.argv[fIdx + 1] : (sfIdx >= 0 ? process.argv[sfIdx + 1] : 'plain');
  const wantsJson = fmtArg === 'json' || fmtArg === 'json-pretty';

  // Plain-text table used by the plain-text fallback path and plain-format tests.
  // Format matches the real kiro-cli 2.36.0 output exactly.
  const TABLE =
    'Available models (* = default):\n' +
    '\n' +
    '* auto                 1.00x credits      Models chosen by task for optimal usage and consistent quality\n' +
    '  claude-sonnet-5.5    1.30x credits      Claude Sonnet 5.5 model with 1M context window\n' +
    '  claude-haiku-4.5     0.40x credits      The latest Claude Haiku model\n';

  // JSON response: 5 representative models across 4 vendors
  const JSON_RESPONSE = {
    models: [
      { model_name: 'auto', description: 'Models chosen by task for optimal usage and consistent quality', model_id: 'auto', context_window_tokens: 1000000, rate_multiplier: 1.0, rate_unit: 'Credit' },
      { model_name: 'claude-sonnet-5.5', description: 'Claude Sonnet 5.5 model with 1M context window', model_id: 'claude-sonnet-5.5', context_window_tokens: 1000000, rate_multiplier: 1.3, rate_unit: 'Credit' },
      { model_name: 'claude-haiku-4.5', description: 'The latest Claude Haiku model', model_id: 'claude-haiku-4.5', context_window_tokens: 200000, rate_multiplier: 0.4, rate_unit: 'Credit' },
      { model_name: 'gpt-5.6-luna', description: 'OpenAI GPT 5.6 Luna with 1M context window', model_id: 'gpt-5.6-luna', context_window_tokens: 986000, rate_multiplier: 0.6, rate_unit: 'Credit' },
      { model_name: 'deepseek-3.2', description: 'Experimental preview of DeepSeek V3.2', model_id: 'deepseek-3.2', context_window_tokens: 164000, rate_multiplier: 0.25, rate_unit: 'Credit' },
    ],
    default_model: 'auto',
  };

  if (scenario === 'list-models-error') {
    process.stderr.write('Error: token expired, please sign in again\n');
    process.exit(1);
  }
  if (scenario === 'list-models-timeout') {
    await new Promise((r) => setTimeout(r, 30_000));
    process.exit(0);
  }
  if (scenario === 'list-models-empty') {
    if (wantsJson) {
      process.stdout.write(JSON.stringify({ models: [], default_model: 'auto' }) + '\n');
    } else {
      process.stdout.write('Available models (* = default):\n');
    }
    process.exit(0);
  }
  // list-models-json-fallback: always return plain text even when --format json was requested.
  // Simulates an older CLI version that doesn't support --format and just prints the table.
  if (scenario === 'list-models-json-fallback') {
    process.stdout.write(TABLE);
    process.exit(0);
  }
  // list-models-writeback: writes a refreshed token to the temp DB then returns model list.
  // Used to test the portal token write-back mechanic during model listing.
  if (scenario === 'list-models-writeback') {
    const dbPath = process.env.KIRO_TEST_DB_PATH;
    if (dbPath) {
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(dbPath, { open: true });
      try {
        const row = db.prepare('SELECT value FROM auth_kv WHERE key = ?').get('kirocli:odic:token');
        if (row) {
          const parsed = JSON.parse(row.value);
          parsed.access_token = 'refreshed-access-token-by-kiro-list';
          parsed.expires_at = new Date(Date.now() + 7_200_000).toISOString();
          db.prepare('INSERT OR REPLACE INTO auth_kv (key, value) VALUES (?, ?)').run('kirocli:odic:token', JSON.stringify(parsed));
        }
      } finally {
        db.close();
      }
    }
    process.stdout.write(TABLE);
    process.exit(0);
  }
  // Default / list-models-ok: return JSON when requested, plain text otherwise
  if (wantsJson) {
    process.stdout.write(JSON.stringify(JSON_RESPONSE) + '\n');
  } else {
    process.stdout.write(TABLE);
  }
  process.exit(0);
}

// ── chat (existing behavior) ──────────────────────────────────────────────────

if (scenario === 'missing') {
  process.exit(127);
}

if (scenario === 'error') {
  process.stderr.write('kiro-cli: fatal error\n');
  process.exit(1);
}

if (scenario === 'home-check') {
  // Emit the HOME value so the test can verify it was set by the engine
  const homeVal = process.env.HOME ?? process.env.USERPROFILE ?? 'not-set';
  process.stdout.write(`HOME=${homeVal}\n`);
  process.exit(0);
}

if (scenario === 'home-env-check') {
  // Emit both HOME and USERPROFILE separately so tests can verify each one.
  // Used to guard the Windows USERPROFILE-must-not-be-overridden invariant.
  process.stdout.write(`HOME=${process.env.HOME ?? 'not-set'}\n`);
  process.stdout.write(`USERPROFILE=${process.env.USERPROFILE ?? 'not-set'}\n`);
  process.exit(0);
}

if (scenario === 'kiro-test-db-check') {
  // Emit KIRO_TEST_DB_PATH (or 'not-set') so tests can verify it was injected.
  process.stdout.write(`KIRO_TEST_DB_PATH=${process.env.KIRO_TEST_DB_PATH ?? 'not-set'}\n`);
  process.exit(0);
}

if (scenario === 'kiro-test-db-writeback') {
  // Write a refreshed access_token into the temp DB (simulates kiro-cli refreshing
  // its token during a run). Used to test the portal write-back mechanic.
  const dbPath = process.env.KIRO_TEST_DB_PATH;
  if (dbPath) {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbPath, { open: true });
    try {
      const row = db.prepare('SELECT value FROM auth_kv WHERE key = ?').get('kirocli:odic:token');
      if (row) {
        const parsed = JSON.parse(row.value);
        parsed.access_token = 'refreshed-access-token-by-kiro-run';
        parsed.expires_at = new Date(Date.now() + 7_200_000).toISOString();
        parsed.refresh_token = 'refreshed-refresh-token-by-kiro-run';
        db.prepare('INSERT OR REPLACE INTO auth_kv (key, value) VALUES (?, ?)').run('kirocli:odic:token', JSON.stringify(parsed));
      }
    } finally {
      db.close();
    }
  }
  process.stdout.write('token refreshed by kiro\n');
  process.exit(0);
}

// Read stdin (the prompt)
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
await new Promise((r) => process.stdin.once('end', r));

if (scenario === 'kiro-model-ok') {
  // Scenario for callTextModel (model-provider.ts) tests.
  // Verifies that --trust-all-tools is NOT present (security constraint),
  // echoes metadata for test assertions, and returns a JSON step array.
  if (process.argv.includes('--trust-all-tools')) {
    process.stderr.write('kiro-model-ok: --trust-all-tools must NOT be passed to the text model path\n');
    process.exit(1);
  }
  // Verify --trust-tools= flag is present (no tool execution allowed)
  const hasTrustTools = process.argv.some((a) => a.startsWith('--trust-tools'));
  if (!hasTrustTools) {
    process.stderr.write('kiro-model-ok: --trust-tools= flag is required but missing\n');
    process.exit(1);
  }
  const modelIdx = process.argv.indexOf('--model');
  const modelVal = modelIdx >= 0 ? process.argv[modelIdx + 1] : 'none';
  process.stdout.write('[{"kind":"goto","path":"/test"}]\n');
  process.stdout.write(`prompt_length=${input.length}\n`);
  process.stdout.write(`model=${modelVal}\n`);
  process.exit(0);
}

if (scenario === 'kiro-model-not-signed-in') {
  process.stderr.write('Not signed in. Please sign in to continue.\n');
  process.exit(1);
}

if (scenario === 'kiro-model-token-expired') {
  process.stderr.write('Error: session token expired\n');
  process.exit(1);
}

if (scenario === 'review') {
  process.stdout.write('Reviewing the diff...\n');
  // Output a structured review response with a JSON findings block
  process.stdout.write('Review Findings\n\n');
  process.stdout.write('```json\n');
  process.stdout.write('[{"file":"src/app.ts","line":10,"severity":"high","title":"Issue","body":"desc","confidence":0.9}]\n');
  process.stdout.write('```\n');
  process.exit(0);
}

if (scenario === 'json') {
  // Output in JSON mode (line-delimited)
  process.stdout.write(JSON.stringify({ type: 'text', text: 'Kiro is running.' }) + '\n');
  process.stdout.write(JSON.stringify({ type: 'tool_start', tool: 'Read', toolInput: '{"file_path":"README.md"}' }) + '\n');
  process.stdout.write(JSON.stringify({ type: 'tool_end', tool: 'Read', toolOutput: '# README' }) + '\n');
  process.stdout.write(JSON.stringify({ type: 'text', text: 'Task complete.' }) + '\n');
  process.stdout.write(JSON.stringify({ type: 'result', credits: 0.5 }) + '\n');
  process.exit(0);
}

// Normal text mode
process.stdout.write('Kiro is analyzing the task.\n');
// Echo the model arg if present so tests can verify it was passed
const modelIdx = process.argv.indexOf('--model');
if (modelIdx >= 0 && process.argv[modelIdx + 1]) {
  process.stdout.write(`model=${process.argv[modelIdx + 1]}\n`);
}
process.stdout.write('I will now process: ' + input.slice(0, 40) + '\n');
process.stdout.write('Task complete.\n');
process.exit(0);
