/**
 * Pre-flight check for the Agent Portal.
 *
 * Checks every tool the portal depends on and prints one line per item:
 *   ok        <item>   — found / writable
 *   missing   <item>   — not found (REQUIRED items cause a non-zero exit)
 *   optional-off <item> — not found but not required
 *
 * Exit codes:
 *   0 — all REQUIRED items are present
 *   1 — one or more REQUIRED items are missing
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const here = path.dirname(fileURLToPath(import.meta.url));

// ── helpers ────────────────────────────────────────────────────────────────

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

function ok(label) {
  console.log(`${GREEN}ok          ${RESET}${label}`);
}
function missing(label, hint = '') {
  console.log(`${RED}missing     ${RESET}${label}${hint ? '  # ' + hint : ''}`);
}
function optionalOff(label, hint = '') {
  console.log(`${YELLOW}optional-off${RESET} ${label}${hint ? '  # ' + hint : ''}`);
}

/** Try running `cmd --version` (or a custom probe). Returns true on success. */
async function probe(cmd, args = ['--version']) {
  try {
    await execFileAsync(cmd, args, { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** Try running a Python import check. */
async function pythonModule(mod) {
  try {
    await execFileAsync('python3', ['-c', `import ${mod}`], { timeout: 5000 });
    return true;
  } catch {
    try {
      await execFileAsync('python', ['-c', `import ${mod}`], { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }
}

// ── data directory write check ─────────────────────────────────────────────

async function checkDataDir() {
  const dataDir = process.env.DATA_DIR || path.join(here, '..', 'data');
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const testFile = path.join(dataDir, '.preflight-write-test');
    fs.writeFileSync(testFile, 'ok');
    fs.unlinkSync(testFile);
    ok(`data directory writable (${dataDir})`);
    return true;
  } catch (e) {
    missing(`data directory writable (${dataDir})`, String(e.message ?? e));
    return false;
  }
}

// ── find the Claude Code CLI bundled with the Agent SDK ───────────────────

async function findClaudeCode() {
  // The Agent SDK embeds the Claude Code binary inside its platform-specific optional
  // package (e.g. @anthropic-ai/claude-agent-sdk-linux-x64/claude).
  // The SDK extracts it to a temp directory at runtime via extractFromBunfs; there is
  // no stable bin/ path we can check before the first run. What we *can* verify is that
  // the SDK package itself is installed (a non-empty sdk.mjs means the package is
  // present and will extract the binary on demand).
  const r = createRequire(path.join(here, '..', 'package.json'));
  try {
    const sdkPkg = r.resolve('@anthropic-ai/claude-agent-sdk/package.json');
    return path.dirname(sdkPkg); // directory, not a binary path
  } catch {
    return null;
  }
}

// ── optional tool packs (reuse server/tool-packs logic) ──────────────────

async function checkToolPacks() {
  // We cannot import the TypeScript server module directly from a plain .mjs preflight
  // script (it would need tsx). Replicate the detection logic here instead.
  const results = {};

  // uv
  results.uv = await probe('uvx');

  // kiro (respecting a custom command in the env)
  const kiroCmd = process.env.KIRO_CLI_COMMAND || 'kiro-cli';
  results.kiro = await probe(kiroCmd);

  // browser MCP
  const browserUrl = process.env.PORTAL_BROWSER_MCP_URL;
  if (!browserUrl) {
    results.browser = null; // not configured
  } else {
    try {
      const r = await fetch(browserUrl, { signal: AbortSignal.timeout(5000) });
      results.browser = r.ok || r.status < 500;
    } catch {
      results.browser = false;
    }
  }

  return results;
}

// ── main ──────────────────────────────────────────────────────────────────

let failed = false;

// REQUIRED: git
if (await probe('git')) ok('git');
else { missing('git', 'install Git'); failed = true; }

// OPTIONAL: pandoc
if (await probe('pandoc')) ok('pandoc (.odt/.rtf/.epub conversion)');
else optionalOff('pandoc (.odt/.rtf/.epub conversion)', 'install pandoc for extra upload formats');

// OPTIONAL: aws CLI
if (await probe('aws')) ok('aws CLI');
else optionalOff('aws CLI', 'install awscli for CodeCommit / Bedrock');

// OPTIONAL: git-remote-codecommit
// git-remote-codecommit has no --version flag; check it is importable by Python instead.
if (await pythonModule('git_remote_codecommit')) ok('git-remote-codecommit');
else optionalOff('git-remote-codecommit', 'pip install git-remote-codecommit for codecommit:// URLs');

// OPTIONAL: Python modules
for (const mod of ['docx', 'pptx', 'docxtpl']) {
  if (await pythonModule(mod)) ok(`python: ${mod}`);
  else optionalOff(`python: ${mod}`, `pip install ${mod === 'docx' ? 'python-docx' : mod === 'pptx' ? 'python-pptx' : 'docxtpl'}`);
}

// INFORMATIONAL: Claude Code CLI (bundled with the Agent SDK)
// The SDK embeds the binary and extracts it at runtime; there is no stable on-disk
// path to probe before the first run. We verify only that the npm package is present.
const claudeSdkDir = await findClaudeCode();
if (claudeSdkDir) {
  ok(`Claude Code SDK present (${claudeSdkDir}) — binary extracted at runtime`);
} else {
  // Not found as an npm package. Check if 'claude' is on PATH as a fallback.
  if (await probe('claude')) {
    ok('Claude Code CLI (on PATH)');
  } else {
    // Informational: the SDK may still work if it can extract from the Bun virtual FS.
    optionalOff('Claude Code SDK not found in node_modules', 'run: npm install  (or npm ci)');
  }
}

// REQUIRED: data directory writable
const dataOk = await checkDataDir();
if (!dataOk) failed = true;

// OPTIONAL: tool packs
const packs = await checkToolPacks();

if (packs.uv) ok('uv / uvx (AWS integration, custom MCP servers)');
else optionalOff('uv / uvx', 'admin can install via Settings › Tools');

if (packs.kiro) ok('kiro-cli (Kiro engine)');
else optionalOff('kiro-cli', 'admin can install via Settings › Tools');

if (packs.browser === null) optionalOff('browser MCP (PORTAL_BROWSER_MCP_URL not set)', 'run: docker compose --profile browser up -d');
else if (packs.browser) ok('browser MCP');
else optionalOff('browser MCP (URL set but not reachable)', 'run: docker compose --profile browser up -d');

// ── exit ──────────────────────────────────────────────────────────────────

if (failed) {
  console.log(`\n${RED}One or more REQUIRED items are missing. The portal will not start correctly.${RESET}`);
  process.exit(1);
} else {
  console.log(`\n${GREEN}All required items are present.${RESET}`);
  process.exit(0);
}
