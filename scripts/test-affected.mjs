#!/usr/bin/env node
/**
 * scripts/test-affected.mjs
 *
 * Run only the tests for modules whose source files changed since they last
 * passed. Uses content hashes to detect changes — uncommitted working-tree
 * edits are treated as changes.
 *
 * Backend tests and UI smoke tests are tracked separately per module.
 * A module is only re-run for the parts that are actually stale.
 *
 * Record format (per module in .test-pass-record.json):
 *   {
 *     "backend": { "hash": "<sha256>", "result": "pass|fail|known-failure", "at": "<iso>", "commit": "<ref>" },
 *     "ui":      { "hash": "<sha256>", "result": "pass|fail|known-failure", "at": "<iso>", "commit": "<ref>" }
 *   }
 * Old flat-format entries are discarded on load (they'll re-run as "never passed").
 *
 * Known failures:
 *   A module part whose every failure is listed in test/known-failures.json is recorded
 *   as "known-failure" (not "fail"). The hash is stored so the part is not re-run until
 *   its source files change. Exit code is 0 when the only failures are known ones.
 *
 * Usage:
 *   node scripts/test-affected.mjs [options]
 *
 * Options:
 *   --dry-run        Print affected modules and exact commands; don't run anything.
 *   --all            Force a full run regardless of hashes.
 *   --module <id>    Run only the named module.
 *   --backend-only   Skip UI smoke tests (only updates backend records).
 *   --ui-only        Skip backend tests (only updates UI records).
 *
 * Env vars:
 *   TEST_RECORD_FILE      Override path to the pass-record JSON (for testing without
 *                         clobbering the real record). Example:
 *                           TEST_RECORD_FILE=/tmp/my-record.json npm run test:affected
 *   TEST_FILE_TIMEOUT_MS  Per-file hard kill timeout in ms (default 180 000 = 3 min).
 *                         Override to tune for slower machines or speed up simulations:
 *                           TEST_FILE_TIMEOUT_MS=5000 npm run test:affected
 *   TEST_CONCURRENCY      Concurrent isolated backend files (default 1, CI uses 4).
 *
 * npm hook: npm run test:affected [-- <options>]
 */

import fs          from 'node:fs';
import path        from 'node:path';
import os          from 'node:os';
import { createHash } from 'node:crypto';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { runTestPool } from './test-pool.mjs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

// ── Paths ────────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT       = path.resolve(__dirname, '..');
const MAP_PATH   = path.join(ROOT, 'test', 'test-map.json');
const KF_PATH    = path.join(ROOT, 'test', 'known-failures.json');

// TEST_RECORD_FILE env var lets callers redirect the pass-record to a temp
// file so real run records are never clobbered during verification testing.
const RECORD_PATH = process.env.TEST_RECORD_FILE
  ? path.resolve(process.env.TEST_RECORD_FILE)
  : path.join(ROOT, '.test-pass-record.json');

// TEST_FILE_TIMEOUT_MS: per-file hard kill timeout.  Default 180 s (3 min).
// Healthy test files run in 5–17 s; hanging files are killed after this limit.
const FILE_TIMEOUT_MS = parseInt(process.env.TEST_FILE_TIMEOUT_MS ?? '', 10) || 180_000;
const TEST_CONCURRENCY = Number(process.env.TEST_CONCURRENCY ?? 1);

// ── Args ─────────────────────────────────────────────────────────────────────

const { values: args } = parseArgs({
  args: process.argv.slice(2),
  options: {
    'dry-run':      { type: 'boolean', default: false },
    'all':          { type: 'boolean', default: false },
    'module':       { type: 'string' },
    'backend-only': { type: 'boolean', default: false },
    'ui-only':      { type: 'boolean', default: false },
  },
  strict: false,
});

const DRY_RUN      = args['dry-run']      ?? false;
const FORCE_ALL    = args['all']          ?? false;
const ONLY_MODULE  = args['module']       ?? null;
const BACKEND_ONLY = args['backend-only'] ?? false;
const UI_ONLY      = args['ui-only']      ?? false;

// ── Known failures ────────────────────────────────────────────────────────────

/**
 * Load the known-failures list. Returns an empty array if the file is missing
 * or malformed (the feature gracefully degrades).
 *
 * Entry shape:
 *   {
 *     module:    string               — module ID (e.g. "repos")
 *     part:      "backend" | "ui"
 *     file?:     string               — relative test file (backend only)
 *     testName:  string               — exact test name; "__process_timeout__" for process kills
 *     sectionId?: string              — smoke section id (ui only)
 *     reason:    string
 *     addedAt:   string               — ISO date
 *   }
 */
function loadKnownFailures() {
  try {
    const raw = JSON.parse(fs.readFileSync(KF_PATH, 'utf8'));
    return Array.isArray(raw.entries) ? raw.entries : [];
  } catch {
    return [];
  }
}

// ── Glob expander ─────────────────────────────────────────────────────────────

function expandGlob(pattern) {
  if (!pattern.includes('*')) {
    const abs = path.join(ROOT, pattern.split('/').join(path.sep));
    if (!fs.existsSync(abs)) return [];
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      const files = [];
      collectAllFiles(abs, files);
      return files;
    }
    return [abs];
  }
  const parts = pattern.split('/');
  return expandGlobParts(ROOT, parts, 0);
}

function expandGlobParts(baseDir, parts, idx) {
  if (idx >= parts.length) {
    if (!fs.existsSync(baseDir)) return [];
    const st = fs.statSync(baseDir);
    return st.isFile() ? [baseDir] : [];
  }

  const part   = parts[idx];
  const isLast = idx === parts.length - 1;

  if (part === '**') {
    if (isLast) {
      const files = [];
      collectAllFiles(baseDir, files);
      return files;
    }
    const remaining = parts.slice(idx + 1);
    const dirs = [baseDir, ...collectAllDirs(baseDir)];
    const files = [];
    for (const dir of dirs) files.push(...expandGlobParts(dir, remaining, 0));
    return files;
  }

  if (part.includes('*')) {
    const regexStr = '^' + part
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '[^/\\\\]*') + '$';
    const regex = new RegExp(regexStr);
    let entries;
    try { entries = fs.readdirSync(baseDir, { withFileTypes: true }); }
    catch { return []; }
    const files = [];
    for (const entry of entries) {
      if (!regex.test(entry.name)) continue;
      const full = path.join(baseDir, entry.name);
      if (isLast) { if (entry.isFile()) files.push(full); }
      else if (entry.isDirectory()) files.push(...expandGlobParts(full, parts, idx + 1));
    }
    return files;
  }

  const next = path.join(baseDir, part);
  return expandGlobParts(next, parts, idx + 1);
}

function collectAllFiles(dir, result = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) collectAllFiles(full, result);
    else result.push(full);
  }
}

function collectAllDirs(dir, result = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return result; }
  for (const e of entries) {
    if (e.isDirectory()) {
      const full = path.join(dir, e.name);
      result.push(full);
      collectAllDirs(full, result);
    }
  }
  return result;
}

// ── Hash computation ──────────────────────────────────────────────────────────

function hashFiles(filePaths) {
  const sorted = [...new Set(filePaths)].sort();
  const h = createHash('sha256');
  for (const fp of sorted) {
    const rel = fp.replace(ROOT, '').replace(/\\/g, '/');
    h.update(rel);
    h.update('\0');
    try {
      h.update(fs.readFileSync(fp));
    } catch {
      h.update('__missing__');
    }
    h.update('\0');
  }
  return h.digest('hex');
}

/**
 * Return relative paths of source files in server/ and web/src/ that are not
 * covered by any module source or shared entry.
 */
function findUnmappedSourceFiles(map) {
  const coveredFiles = new Set();
  for (const [, mod] of Object.entries(map.modules)) {
    for (const pattern of (mod.sources ?? [])) {
      for (const f of expandGlob(pattern)) {
        coveredFiles.add(path.relative(ROOT, f).replace(/\\/g, '/'));
      }
    }
  }
  for (const entry of (map.shared ?? [])) {
    for (const pattern of (entry.sources ?? [])) {
      for (const f of expandGlob(pattern)) {
        coveredFiles.add(path.relative(ROOT, f).replace(/\\/g, '/'));
      }
    }
  }

  const allSourceFiles = [];
  const serverDir = path.join(ROOT, 'server');
  if (fs.existsSync(serverDir)) collectAllFiles(serverDir, allSourceFiles);
  const webSrcDir = path.join(ROOT, 'web', 'src');
  if (fs.existsSync(webSrcDir)) collectAllFiles(webSrcDir, allSourceFiles);

  const unmapped = [];
  for (const f of allSourceFiles) {
    if (f.includes('node_modules')) continue;
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    if (rel.endsWith('.map') || rel.endsWith('.d.ts')) continue;
    if (!coveredFiles.has(rel)) unmapped.push(rel);
  }
  return unmapped;
}

/**
 * Compute a content hash for one part ('backend' or 'ui') of a module.
 */
function computePartHash(modId, mod, shared, part) {
  const files = [];

  for (const pattern of (mod.sources ?? [])) {
    const expanded = expandGlob(pattern);
    if (part === 'backend') {
      for (const f of expanded) {
        const rel = path.relative(ROOT, f).replace(/\\/g, '/');
        if (!rel.startsWith('web/')) files.push(f);
      }
    } else {
      files.push(...expanded);
    }
  }

  if (part === 'backend') {
    for (const t of (mod.tests ?? [])) {
      const abs = path.join(ROOT, t.split('/').join(path.sep));
      files.push(abs);
    }
  }

  for (const entry of (shared ?? [])) {
    const { affects, sources = [], part: entryPart } = entry;

    const included =
      affects === '*' ||
      (Array.isArray(affects) && affects.includes(modId));
    if (!included) continue;

    if (entryPart && entryPart !== 'both' && entryPart !== part) continue;

    for (const pattern of sources) {
      files.push(...expandGlob(pattern));
    }
  }

  return hashFiles(files);
}

// ── Pass record ───────────────────────────────────────────────────────────────

function loadRecord() {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(RECORD_PATH, 'utf8')); }
  catch { return {}; }

  const record = {};
  for (const [id, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== 'object') continue;
    if ('backend' in entry || 'ui' in entry) {
      record[id] = entry;
    }
  }
  return record;
}

function saveRecord(record) {
  fs.writeFileSync(RECORD_PATH, JSON.stringify(record, null, 2) + '\n');
}

function getGitRef() {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: ROOT, stdio: ['pipe', 'pipe', 'ignore'], encoding: 'utf8',
    }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], {
      cwd: ROOT, stdio: ['pipe', 'pipe', 'ignore'], encoding: 'utf8',
    }).trim();
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return 'unknown';
  }
}

// ── Affected module detection ─────────────────────────────────────────────────

/**
 * Returns an array of affected module descriptors.
 * A part is stale when: never recorded, last result was 'fail', or hash changed.
 * 'known-failure' is treated the same as 'pass' — not stale unless hash changes.
 */
function detectAffected(map, record) {
  const results = [];
  for (const [id, mod] of Object.entries(map.modules)) {
    const hasBackend = (mod.tests ?? []).length > 0;
    const hasUI      = (mod.smokeIds ?? []).length > 0;

    const stored = record[id] ?? {};

    let backendStale = false;
    let uiStale      = false;
    let backendHash  = null;
    let uiHash       = null;
    const reasons    = [];

    if (hasBackend) {
      backendHash = computePartHash(id, mod, map.shared, 'backend');
      const sb = stored.backend;
      if (!sb) {
        backendStale = true;
        reasons.push('backend: never passed');
      } else if (sb.result !== 'pass' && sb.result !== 'known-failure') {
        backendStale = true;
        reasons.push('backend: last run failed');
      } else if (sb.hash !== backendHash) {
        backendStale = true;
        reasons.push('backend: source/test files changed');
      }
    }

    if (hasUI) {
      uiHash = computePartHash(id, mod, map.shared, 'ui');
      const su = stored.ui;
      if (!su) {
        uiStale = true;
        reasons.push('ui: never passed');
      } else if (su.result !== 'pass' && su.result !== 'known-failure') {
        uiStale = true;
        reasons.push('ui: last run failed');
      } else if (su.hash !== uiHash) {
        uiStale = true;
        reasons.push('ui: source files changed');
      }
    }

    if (backendStale || uiStale) {
      results.push({ id, mod, backendStale, uiStale, backendHash, uiHash,
        reason: reasons.join(', ') });
    }
  }
  return results;
}

// ── Build detection ───────────────────────────────────────────────────────────

function needsBuild(affectedModules, shared) {
  const affectedIds = new Set(affectedModules.map(a => a.id));

  const isBuildInput = (s) =>
    s.startsWith('web/') ||
    s.startsWith('server/') ||
    s === 'package.json' ||
    s === 'package-lock.json' ||
    s === 'tsconfig.json' ||
    s.startsWith('scripts/');

  for (const { mod } of affectedModules) {
    if ((mod.sources ?? []).some(isBuildInput)) return true;
  }

  for (const entry of (shared ?? [])) {
    const { affects, sources = [] } = entry;
    const affectsAny =
      affects === '*' ||
      (Array.isArray(affects) && affects.some(id => affectedIds.has(id)));
    if (!affectsAny) continue;
    if (sources.some(isBuildInput)) return true;
  }

  return false;
}

// ── Node executable ───────────────────────────────────────────────────────────

const NODE       = process.execPath;
const NODE_FLAGS = ['--disable-warning=ExperimentalWarning'];

// ── TAP parser ────────────────────────────────────────────────────────────────

/**
 * Normalise an absolute or relative path from a TAP file to a forward-slash
 * relative path from ROOT (e.g. "test/repos.test.ts").
 */
function normaliseTapPath(raw) {
  const cleaned = raw.replace(/'/g, '').trim();
  try {
    const rel = path.relative(ROOT, cleaned).replace(/\\/g, '/');
    if (!rel.startsWith('..')) return rel;
  } catch { /* fall through */ }
  return cleaned.replace(/\\/g, '/');
}

/**
 * Parse a TAP file produced by --test-reporter=tap and return an array of
 * individual test failures.
 *
 * Each entry:
 *   { testName: string, file: string|null, failureType: string }
 *
 * - testName includes the immediate parent suite if any: "Suite > Test"
 * - file is the relative path of the source file (from location: field) or null
 * - failureType: 'testCodeFailure' | 'testTimeoutFailure' | ...
 *
 * Composite suite failures (type:'suite', failureType:'subtestsFailed') are
 * excluded — only leaf test failures are returned.
 */
function parseTapFile(tapFile) {
  let content = '';
  try { content = fs.readFileSync(tapFile, 'utf8'); } catch { return []; }

  const failures = [];
  const lines = content.split('\n');

  // Stack of { name, indent } for tracking suite/subtest hierarchy
  const suiteStack = [];

  let currentNotOk = null; // { testName, fullName, indent }
  let inYaml = false;
  let currentYaml = {};

  for (const rawLine of lines) {
    if (inYaml) {
      const trimmed = rawLine.trim();
      if (trimmed === '...') {
        // End of YAML block — process the accumulated entry
        if (currentNotOk) {
          const type        = (currentYaml['type']        ?? '').replace(/'/g, '').trim();
          const failureType = (currentYaml['failureType'] ?? '').replace(/'/g, '').trim();
          const location    = (currentYaml['location']    ?? '').replace(/'/g, '').trim();

          // Skip composite suite failures
          if (type === 'suite' || failureType === 'subtestsFailed') {
            currentNotOk = null;
            inYaml = false;
            currentYaml = {};
            continue;
          }

          if (type === 'test') {
            // Determine source file from location (strip :line:col suffix)
            let file = null;
            if (location) {
              // location: C:\...\file.ts:1:2443  →  strip last two :N segments
              const noPos = location.replace(/:\d+:\d+$/, '').replace(/:\d+$/, '');
              file = normaliseTapPath(noPos);
            } else {
              // For file-level timeouts the test name IS the file path
              const tn = currentNotOk.testName;
              if (tn && (tn.includes('/') || tn.includes('\\'))) {
                file = normaliseTapPath(tn);
              }
            }

            failures.push({
              testName:    normaliseTapPath(currentNotOk.fullName),
              file:        file ? file.replace(/\\/g, '/') : null,
              failureType,
            });
          }
        }
        inYaml = false;
        currentNotOk = null;
        currentYaml = {};
        continue;
      }

      // Parse key: value lines inside YAML block
      const m = rawLine.match(/^\s+(\w+):\s+(.*)$/);
      if (m) currentYaml[m[1]] = m[2].trim();
      continue;
    }

    // ── Subtest header: track nesting for full test name ──────────────────
    const subtestM = rawLine.match(/^(\s*)# Subtest: (.+)$/);
    if (subtestM) {
      const indent = subtestM[1].length;
      const name   = subtestM[2].trim();
      // Remove any suites at the same or deeper indent (new scope)
      while (suiteStack.length && suiteStack[suiteStack.length - 1].indent >= indent) {
        suiteStack.pop();
      }
      suiteStack.push({ name, indent });
      continue;
    }

    // ── not ok line ────────────────────────────────────────────────────────
    const notOkM = rawLine.match(/^(\s*)not ok \d+ - (.+)$/);
    if (notOkM) {
      const indent   = notOkM[1].length;
      const testName = notOkM[2].trim();

      // Parent suites are those with indent strictly less than this test's indent
      const parents = suiteStack.filter(s => s.indent < indent).map(s => s.name);

      // Build full name: use only the immediate direct parent for clarity
      const fullName = parents.length > 0
        ? `${parents[parents.length - 1]} > ${testName}`
        : testName;

      currentNotOk = { testName, fullName, indent };
      continue;
    }

    // ── YAML start ─────────────────────────────────────────────────────────
    if (rawLine.trim() === '---' && currentNotOk) {
      inYaml = true;
    }
  }

  return failures;
}

// ── Known-failure matching ────────────────────────────────────────────────────

/**
 * Check whether all backend test failures (from TAP) plus any process-level
 * timeout are covered by the known-failures list for this module+part.
 *
 * Returns:
 *   { isKnown: boolean, unmatched: FailureEntry[] }
 *
 * isKnown is true only when:
 *   - There is at least one failure (empty failure list → just pass).
 *   - Every failure in the list has a matching entry in knownEntries.
 */
function checkBackendKnownFailures(moduleId, failures, knownEntries) {
  const relevant = knownEntries.filter(e => e.module === moduleId && e.part === 'backend');

  if (relevant.length === 0 || failures.length === 0) {
    return { isKnown: false, unmatched: failures };
  }

  const unmatched = [];
  for (const failure of failures) {
    const matched = relevant.some(entry => {
      // Process timeout: file is required and must match the killed file exactly.
      if (entry.testName === '__process_timeout__' && failure.failureType === 'processTimeout') {
        if (!entry.file || !failure.file) return false;
        const ef = entry.file.replace(/\\/g, '/').replace(/^\.\//, '');
        const ff = failure.file.replace(/\\/g, '/').replace(/^\.\//, '');
        return ef === ff;
      }

      // Test name match (normalise slashes)
      const entryName = entry.testName.replace(/\\/g, '/');
      const failName  = failure.testName.replace(/\\/g, '/');
      if (entryName !== failName) return false;

      // Optional file match
      if (!entry.file) return true; // no file constraint
      if (!failure.file) return true; // can't check file, accept
      const ef = entry.file.replace(/\\/g, '/').replace(/^\.\//, '');
      const ff = failure.file.replace(/\\/g, '/').replace(/^\.\//, '');
      return ef === ff;
    });

    if (!matched) unmatched.push(failure);
  }

  return {
    isKnown:   unmatched.length === 0,
    unmatched,
  };
}

/**
 * Check whether all UI failures in the smoke results for a module are covered
 * by the known-failures list.
 *
 * Returns: 'pass' | 'fail' | 'known-failure' | 'not-run'
 */
function checkUIKnownFailures(modId, failingSections, knownEntries) {
  const relevant = knownEntries.filter(e => e.module === modId && e.part === 'ui');
  if (relevant.length === 0) return 'fail';

  for (const section of failingSections) {
    const sectionFailures = section.failures ?? [];
    for (const f of sectionFailures) {
      const testName = (f.name ?? f.message ?? f.msg ?? '').trim();
      const matched = relevant.some(entry => {
        // sectionId can be either the smoke section's own id OR one of its module IDs
        if (entry.sectionId) {
          const sectionIdMatch =
            entry.sectionId === section.id ||
            (Array.isArray(section.modules) && section.modules.includes(entry.sectionId));
          if (!sectionIdMatch) return false;
        }
        return entry.testName === testName;
      });
      if (!matched) return 'fail';
    }
  }

  return 'known-failure';
}

// ── Run helpers ───────────────────────────────────────────────────────────────

/**
 * Run backend tests for a list of files.
 *
 * Each test file is run in a SEPARATE node --test invocation so that the TAP
 * reporter flushes its output incrementally. Running files together in one
 * process causes the TAP reporter to buffer across files and not flush when
 * one file hangs (e.g. repos-progress.test.ts).
 *
 * Uses dual reporters per file:
 *   - spec → stdout (human-readable console output)
 *   - tap  → temp file (machine-readable for known-failure detection)
 *
 * `--test-force-exit` is always passed so the Node.js event loop does not keep
 * the process alive after all tests (and their after() hooks) have finished.
 * Without it, server keep-alive connections and undici pool state can delay
 * process exit by several seconds, which trips the per-file kill timeout.
 *
 * A hard per-file timeout of 180 s (3 minutes, overridable with TEST_FILE_TIMEOUT_MS)
 * prevents hung test suites from blocking the runner indefinitely. If a file is killed,
 * a synthetic '__process_timeout__' failure is added for that file.
 *
 * Returns { ok: boolean, failures: TapFailure[] }
 */
function runBackendFile(file) {
  return new Promise((resolve, reject) => {
    const tapFile = path.join(os.tmpdir(),
      `portal-tap-${Date.now()}-${Math.random().toString(36).slice(2)}.tap`);

    const logFile = tapFile + '.log';
    const logFd = fs.openSync(logFile, 'w');
    const started = Date.now();
    const child = spawn(NODE, [
      ...NODE_FLAGS,
      '--import', 'tsx',
      '--test',
      '--test-force-exit',
      '--test-timeout=300000',
      '--test-reporter=spec',
      '--test-reporter-destination=stdout',
      '--test-reporter=tap',
      `--test-reporter-destination=${tapFile}`,
      file,
    ], {
      cwd:     ROOT,
      stdio:   ['ignore', logFd, logFd],
      env:     process.env,
      timeout: FILE_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    let spawnError;
    child.once('error', error => { spawnError = error; });
    child.once('close', (code, signal) => {
      try {
        fs.closeSync(logFd);
        const relFile = path.relative(ROOT, file).replace(/\\/g, '/');
        console.log(`${process.env.CI ? '::group::' : '\n'}${relFile} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
        try { process.stdout.write(fs.readFileSync(logFile)); } finally { fs.unlinkSync(logFile); }
        if (process.env.CI) console.log('::endgroup::');
        const killed = signal != null;
        const failures = parseTapFile(tapFile);
        try { fs.unlinkSync(tapFile); } catch { /* best effort */ }
        if (killed) failures.push({ testName: '__process_timeout__', file: relFile, failureType: 'processTimeout' });
        if (spawnError) failures.push({ testName: '__process_error__', file: relFile, failureType: 'processError' });
        resolve({ ok: code === 0 && !killed && !spawnError, failures });
      } catch (error) { reject(error); }
    });
  });
}

function runBuild() {
  const result = spawnSync(NODE, ['scripts/build.mjs'], {
    cwd: ROOT, stdio: 'inherit', env: process.env,
  });
  return result.status === 0;
}

/**
 * Run the smoke suite and return { ok, smokeResults }.
 */
function runSmoke(smokeIds) {
  const resultsFile = path.join(os.tmpdir(), `smoke-results-${Date.now()}.json`);
  const env = {
    ...process.env,
    SMOKE_RESULTS_FILE: resultsFile,
    ...(smokeIds.length > 0 ? { SMOKE_ONLY: smokeIds.join(',') } : {}),
  };
  const result = spawnSync(
    NODE,
    [...NODE_FLAGS, '--import', 'tsx', 'test/ui/smoke.ts'],
    { cwd: ROOT, stdio: 'inherit', env },
  );

  let smokeResults = null;
  try {
    if (fs.existsSync(resultsFile)) {
      smokeResults = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
      try { fs.unlinkSync(resultsFile); } catch { /* best effort */ }
    }
  } catch { /* ignore */ }

  return { ok: result.status === 0, smokeResults };
}

/**
 * Determine a module's UI result from smoke section data.
 * Returns 'pass' | 'fail' | 'known-failure' | 'not-run'
 */
function getModuleUIResult(modId, mod, smokeResults, knownEntries) {
  if (!smokeResults || !smokeResults.completed) return 'not-run';

  const smokeIds = mod.smokeIds ?? [];
  if (smokeIds.length === 0) return 'not-run';

  const relevant = smokeResults.sections.filter(s =>
    s.modules.some(m => smokeIds.includes(m)),
  );
  if (relevant.length === 0) return 'not-run';

  for (const s of relevant) {
    if (!s.ran) return 'not-run';
  }

  const failingSections = relevant.filter(s => s.failed > 0);
  if (failingSections.length === 0) return 'pass';

  // There are failures — check if every one is a known failure
  return checkUIKnownFailures(modId, failingSections, knownEntries);
}

/**
 * Collect per-module smoke failures for display.
 */
function collectSmokeFailures(affectedUiModules, smokeResults) {
  const byModule = new Map();
  if (!smokeResults) return byModule;

  for (const { id, mod } of affectedUiModules) {
    const smokeIds = mod.smokeIds ?? [];
    const failing = smokeResults.sections.filter(s =>
      s.modules.some(m => smokeIds.includes(m)) && s.failed > 0,
    );
    if (failing.length > 0) {
      byModule.set(id, failing.map(s => ({
        sectionId:    s.id,
        sectionLabel: s.label,
        failures:     s.failures ?? [],
      })));
    }
  }
  return byModule;
}

// ── Dry-run formatters ────────────────────────────────────────────────────────

function fmtBackendCmd(testFiles) {
  const rel = testFiles.map(f => path.relative(ROOT, f).replace(/\\/g, '/'));
  return `node --disable-warning=ExperimentalWarning --import tsx --test --test-timeout=300000 ${rel.join(' ')}`;
}

function fmtSmokeCmd(smokeIds, withBuild) {
  const lines = [];
  if (withBuild) lines.push('node scripts/build.mjs');
  const envPart = smokeIds.length > 0 ? `SMOKE_ONLY=${smokeIds.join(',')} ` : '';
  lines.push(`${envPart}node --disable-warning=ExperimentalWarning --import tsx test/ui/smoke.ts`);
  return lines;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  let map;
  try {
    map = JSON.parse(fs.readFileSync(MAP_PATH, 'utf8'));
  } catch (err) {
    console.error(`\nFatal: cannot read ${MAP_PATH}\n${err.message}`);
    process.exit(1);
  }

  const record        = loadRecord();
  const knownFailures = loadKnownFailures();

  // ── Unmapped files fail-safe ───────────────────────────────────────────────

  let forceAllDueToUnmapped = false;
  let unmappedSourceFiles   = [];

  if (!ONLY_MODULE && !FORCE_ALL) {
    unmappedSourceFiles = findUnmappedSourceFiles(map);
    if (unmappedSourceFiles.length > 0) {
      console.warn('\n⚠ Unmapped source files detected — forcing --all (fail-safe):');
      for (const f of unmappedSourceFiles) console.warn(`    ${f}`);
      forceAllDueToUnmapped = true;
    }
  }

  const shouldForceAll = FORCE_ALL || forceAllDueToUnmapped;

  // ── Determine affected set ─────────────────────────────────────────────────

  let affected;

  if (ONLY_MODULE) {
    const mod = map.modules[ONLY_MODULE];
    if (!mod) {
      console.error(`\nUnknown module "${ONLY_MODULE}". Available:\n  ${Object.keys(map.modules).join(', ')}`);
      process.exit(1);
    }
    const hasBackend = (mod.tests ?? []).length > 0;
    const hasUI      = (mod.smokeIds ?? []).length > 0;
    affected = [{
      id:          ONLY_MODULE,
      mod,
      reason:      '--module flag',
      backendStale: hasBackend,
      uiStale:      hasUI,
      backendHash:  hasBackend ? computePartHash(ONLY_MODULE, mod, map.shared, 'backend') : null,
      uiHash:       hasUI      ? computePartHash(ONLY_MODULE, mod, map.shared, 'ui')      : null,
    }];

  } else if (shouldForceAll) {
    const forceReason = forceAllDueToUnmapped ? 'unmapped source files detected' : '--all flag';
    affected = Object.entries(map.modules).map(([id, mod]) => {
      const hasBackend = (mod.tests ?? []).length > 0;
      const hasUI      = (mod.smokeIds ?? []).length > 0;
      return {
        id, mod,
        reason:      forceReason,
        backendStale: hasBackend,
        uiStale:      hasUI,
        backendHash:  hasBackend ? computePartHash(id, mod, map.shared, 'backend') : null,
        uiHash:       hasUI      ? computePartHash(id, mod, map.shared, 'ui')      : null,
      };
    });

  } else {
    affected = detectAffected(map, record);
  }

  // ── Gather work items ──────────────────────────────────────────────────────

  const backendItems = UI_ONLY ? [] :
    affected.filter(a => a.backendStale && (a.mod.tests ?? []).length > 0);

  const uiItems = affected.filter(a => a.uiStale && (a.mod.smokeIds ?? []).length > 0);
  const uiSmokeIds = [];
  for (const { mod } of uiItems) {
    for (const s of (mod.smokeIds ?? [])) {
      if (!uiSmokeIds.includes(s)) uiSmokeIds.push(s);
    }
  }

  const runBackend = backendItems.length > 0;
  const runUI      = !BACKEND_ONLY && uiSmokeIds.length > 0;
  const buildFirst = runUI && needsBuild(uiItems, map.shared);

  // ── Known-failure-only affected set (for dry-run display) ─────────────────
  // Modules that are stale only because their last result was 'known-failure'
  // (which the new code treats as not-stale). These are not stale — they show
  // as "known failure (skipped)" in dry-run when explicitly included via --all.
  //
  // In normal (non-force) mode, known-failure modules don't appear in affected
  // at all (they're up-to-date). Only --module or --all force them to re-run.
  const knownFailureSkips = [];
  if (!shouldForceAll && !ONLY_MODULE) {
    for (const [id, mod] of Object.entries(map.modules)) {
      const stored = record[id] ?? {};
      const backendKF = stored.backend?.result === 'known-failure';
      const uiKF      = stored.ui?.result      === 'known-failure';
      if (backendKF || uiKF) {
        knownFailureSkips.push({ id, backendKF, uiKF });
      }
    }
  }

  // ── Nothing to do ─────────────────────────────────────────────────────────

  if (affected.length === 0 && knownFailureSkips.length === 0) {
    console.log('\n✓ All modules are up-to-date — no tests to run.\n');
    return;
  }

  if (affected.length === 0) {
    // Only known-failure-skipped modules
    if (!DRY_RUN) {
      console.log('\n✓ All modules are up-to-date — no tests to run.');
      if (knownFailureSkips.length > 0) {
        console.log('  ⚑ Known failures (skipped):');
        for (const { id, backendKF, uiKF } of knownFailureSkips) {
          const parts = [];
          if (backendKF) parts.push('backend');
          if (uiKF)      parts.push('ui');
          console.log(`      ${id} [${parts.join(', ')}]`);
        }
      }
      console.log('');
      return;  // nothing stale — exit cleanly
    }
    // fall through to dry-run output below
  }

  if (!runBackend && !runUI && affected.length > 0) {
    const reason = BACKEND_ONLY ? '--backend-only: no stale backend tests'
                 : UI_ONLY      ? '--ui-only: no stale UI smoke sections'
                 :                'no work for current selection';
    console.log(`\n✓ Nothing to run (${reason}).\n`);
    return;
  }

  // ── Dry-run output ─────────────────────────────────────────────────────────

  if (DRY_RUN) {
    if (forceAllDueToUnmapped) {
      console.log('\n⚠ Forcing --all: unmapped source files found (fail-safe):');
      for (const f of unmappedSourceFiles) console.log(`    ${f}`);
    }

    if (affected.length > 0) {
      console.log('\n── Affected modules (' + affected.length + ') ──────────────────────────────────────');
      for (const { id, reason, backendStale, uiStale } of affected) {
        const parts = [];
        if (backendStale) parts.push('backend');
        if (uiStale)      parts.push('ui');
        const staleStr = parts.length > 0 ? `[${parts.join(', ')}] ` : '';
        console.log(`  ${id.padEnd(22)}  ${staleStr}${reason}`);
      }
    }

    if (knownFailureSkips.length > 0) {
      console.log('\n── Known failures (skipped) ──────────────────────────────────────────────────');
      for (const { id, backendKF, uiKF } of knownFailureSkips) {
        const parts = [];
        if (backendKF) parts.push('backend');
        if (uiKF)      parts.push('ui');
        console.log(`  ${id.padEnd(22)}  [${parts.join(', ')}] known failure (skipped)`);
      }
    }

    if (runBackend) {
      const allFiles = backendItems.flatMap(({ mod }) =>
        (mod.tests ?? []).map(t => path.join(ROOT, t.split('/').join(path.sep))),
      );
      console.log('\n── Backend tests ─────────────────────────────────────────────────────────────');
      console.log('  Modules: ' + backendItems.map(a => a.id).join(', '));
      console.log('\n  ' + fmtBackendCmd(allFiles));
    } else if (UI_ONLY && backendItems.length === 0 && affected.some(a => a.backendStale)) {
      console.log('\n── Backend tests ─────────────────────────────────────────────────────────────');
      console.log('  (skipped: --ui-only)');
    }

    if (runUI) {
      console.log('\n── UI smoke tests ────────────────────────────────────────────────────────────');
      console.log('  SMOKE_ONLY: ' + uiSmokeIds.join(','));
      const lines = fmtSmokeCmd(uiSmokeIds, buildFirst);
      for (const l of lines) console.log('  ' + l);
    } else if (BACKEND_ONLY && uiSmokeIds.length > 0) {
      console.log('\n── UI smoke tests ────────────────────────────────────────────────────────────');
      console.log('  (skipped: --backend-only)');
    }

    console.log('');

    // Exit 0 even in dry-run — don't re-exit for the empty-affected case
    if (affected.length === 0) return;
    return;
  }

  // ── Real run ───────────────────────────────────────────────────────────────

  const gitRef = getGitRef();
  const passedModules      = new Set();
  const failedModules      = new Set();
  const notRunModules      = new Set();
  const knownFailedModules = new Set();

  // ── Backend tests ──────────────────────────────────────────────────────────

  if (runBackend) {
    const filesToRun = backendItems.flatMap(({ mod }) => (mod.tests ?? []).map(t => path.join(ROOT, t.split('/').join(path.sep))));
    console.log(`\nRunning ${new Set(filesToRun).size} unique backend files with ${TEST_CONCURRENCY} worker(s).`);
    const fileResults = await runTestPool(filesToRun, runBackendFile, TEST_CONCURRENCY);
    console.log('\n── Backend tests ─────────────────────────────────────────────────────────────');

    for (const { id, mod, backendHash } of backendItems) {
      const files = (mod.tests ?? []).map(t =>
        path.join(ROOT, t.split('/').join(path.sep)),
      );
      console.log(`\n  [${id}] ${(mod.tests ?? []).join(', ')}`);

      const results = files.map(file => fileResults.get(file));
      const ok = results.every(result => result.ok);
      const failures = results.flatMap(result => result.failures);
      if (!record[id]) record[id] = {};

      if (ok) {
        record[id].backend = {
          hash:   backendHash,
          result: 'pass',
          at:     new Date().toISOString(),
          commit: gitRef,
        };
        passedModules.add(id);
        console.log(`  ✓ ${id} (backend)`);
      } else {
        // Check if all failures are known
        const { isKnown, unmatched } = checkBackendKnownFailures(id, failures, knownFailures);

        if (isKnown) {
          record[id].backend = {
            hash:   backendHash,
            result: 'known-failure',
            at:     new Date().toISOString(),
            commit: gitRef,
          };
          knownFailedModules.add(id);
          console.log(`  ⚑ ${id} (backend — known failure)`);
          // Print the matched known failures
          for (const f of failures) {
            if (f.failureType === 'processTimeout') {
              console.log(`      ⚑ [process timeout — known]`);
            } else {
              console.log(`      ⚑ ${f.testName}`);
            }
          }
        } else {
          const prev = record[id].backend ?? {};
          record[id].backend = {
            hash:   prev.hash ?? null,
            result: 'fail',
            at:     new Date().toISOString(),
            commit: gitRef,
          };
          failedModules.add(id);
          console.log(`  ✗ ${id} (backend)`);
          // Print unmatched (real) failures
          for (const f of unmatched) {
            if (f.failureType === 'processTimeout') {
              console.log(`      ✗ [process timeout — not in known-failures list]`);
            } else {
              console.log(`      ✗ ${f.testName}${f.file ? ` (${f.file})` : ''}`);
            }
          }
          if (failures.length > unmatched.length) {
            const known = failures.filter(f => !unmatched.includes(f));
            console.log(`      (${known.length} known failure(s) also present)`);
          }
        }

        // If a previously-known-failure module now passes all known checks but has
        // unknown failures too, print a helpful note about which known tests passed.
        // (Already handled in the unmatched display above.)

        // If the module now passes (handled above in ok branch), also check whether
        // any of its known-failure entries should be removed.
      }
    }

    // After a backend run completes, check if any module that WAS a known-failure
    // now passes — notify the user to remove that entry from the list.
    for (const { id } of backendItems) {
      if (passedModules.has(id)) {
        const hadKnown = knownFailures.some(e => e.module === id && e.part === 'backend');
        if (hadKnown) {
          console.log(`\n  ℹ  ${id} (backend) passed — all known-failure entries for this part can now be removed from test/known-failures.json`);
        }
      }
    }

    saveRecord(record);
  }

  // ── UI smoke tests ─────────────────────────────────────────────────────────

  if (runUI) {
    console.log('\n── UI smoke tests ────────────────────────────────────────────────────────────');
    console.log(`  SMOKE_ONLY: ${uiSmokeIds.join(',')}`);

    if (buildFirst) {
      console.log('  Building UI first…');
      if (!runBuild()) {
        console.error('  ✗ Build failed — skipping smoke tests');
        process.exit(1);
      }
    }

    const { smokeResults } = runSmoke(uiSmokeIds);

    if (!smokeResults) {
      console.warn('  ⚠ No results file written by smoke runner — UI results not recorded.');
    } else if (!smokeResults.completed) {
      console.warn('  ⚠ Smoke suite did not complete (timeout or crash) — no UI passes recorded.');
    }

    const smokeFailureMap = collectSmokeFailures(uiItems, smokeResults);

    for (const { id, mod, uiHash } of uiItems) {
      const uiResult = getModuleUIResult(id, mod, smokeResults, knownFailures);
      if (!record[id]) record[id] = {};

      if (uiResult === 'pass') {
        record[id].ui = {
          hash:   uiHash,
          result: 'pass',
          at:     new Date().toISOString(),
          commit: gitRef,
        };
        passedModules.add(id);
        console.log(`  ✓ ${id} (ui)`);

        // Notify if module had known-failure entries
        const hadKnown = knownFailures.some(e => e.module === id && e.part === 'ui');
        if (hadKnown) {
          console.log(`  ℹ  ${id} (ui) passed — known-failure entries for this part can now be removed from test/known-failures.json`);
        }

      } else if (uiResult === 'known-failure') {
        record[id].ui = {
          hash:   uiHash,
          result: 'known-failure',
          at:     new Date().toISOString(),
          commit: gitRef,
        };
        knownFailedModules.add(id);
        console.log(`  ⚑ ${id} (ui — known failure)`);
        const failingSections = smokeFailureMap.get(id) ?? [];
        for (const sec of failingSections) {
          console.log(`      ⚑ §${sec.sectionId} ${sec.sectionLabel}`);
          for (const f of sec.failures) {
            const firstLine = (f.name ?? f.message ?? f.msg ?? '').split('\n')[0];
            console.log(`             ⚑ ${firstLine}`);
          }
        }

      } else if (uiResult === 'fail') {
        const prev = record[id].ui ?? {};
        record[id].ui = {
          hash:   prev.hash ?? null,
          result: 'fail',
          at:     new Date().toISOString(),
          commit: gitRef,
        };
        failedModules.add(id);
        console.log(`  ✗ ${id} (ui)`);
        const failingSections = smokeFailureMap.get(id) ?? [];
        for (const sec of failingSections) {
          console.log(`      § ${sec.sectionId.padEnd(4)} ${sec.sectionLabel}`);
          for (const f of sec.failures) {
            const firstLine = (f.name ?? f.message ?? f.msg ?? '').split('\n')[0];
            console.log(`             ${firstLine}`);
          }
        }

      } else {
        // 'not-run'
        notRunModules.add(id);
        console.log(`  – ${id} (ui: not run — results missing or section skipped)`);
      }
    }
    saveRecord(record);
  }

  // ── Summary ────────────────────────────────────────────────────────────────

  console.log('\n── Summary ───────────────────────────────────────────────────────────────────');
  if (passedModules.size > 0) {
    console.log(`  ✓ Passed        (${passedModules.size}): ${[...passedModules].join(', ')}`);
  }
  if (knownFailedModules.size > 0) {
    console.log(`  ⚑ Known failure (${knownFailedModules.size}): ${[...knownFailedModules].join(', ')}`);
  }
  if (notRunModules.size > 0) {
    console.log(`  – Not run       (${notRunModules.size}): ${[...notRunModules].join(', ')}`);
  }
  if (failedModules.size > 0) {
    console.log(`  ✗ Failed        (${failedModules.size}): ${[...failedModules].join(', ')}`);
  }

  if (failedModules.size > 0 || notRunModules.size > 0) {
    process.exit(1);
  }
  console.log('');
}

main().catch(err => {
  console.error('\nFatal:', err.message ?? err);
  process.exit(1);
});
