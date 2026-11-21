#!/usr/bin/env node
/**
 * scripts/test-map-check.mjs
 *
 * Validates test/test-map.json:
 *   1. Every test/*.test.ts file is covered by at least one module.
 *   2. Every mapped source path actually exists (warns for those that do not).
 *   3. Every server/ and web/src/ source file is in a module or the shared
 *      section (warns for unmapped files rather than hard-failing, so adding
 *      new server/web files does not immediately break CI).
 *   4. If SMOKE_LIST=1 is available, checks that all smokeIds in the map are
 *      in the smoke test's own registry. Skips with a warning if unavailable.
 *
 * Exits 1 if any hard error is found.
 *
 * npm hook: npm run test:map:check
 */

import fs          from 'node:fs';
import path        from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT       = path.resolve(__dirname, '..');
const MAP_PATH   = path.join(ROOT, 'test', 'test-map.json');

// ── Glob helper (same logic as test-affected.mjs) ─────────────────────────────

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

// ── Normalise absolute path → relative forward-slash key ─────────────────────

function toRelKey(abs) {
  return abs.replace(ROOT + path.sep, '').replace(/\\/g, '/');
}

// ── Main ──────────────────────────────────────────────────────────────────────

let errors   = 0;
let warnings = 0;

// Use process.stdout/stderr directly so PowerShell's NativeCommandError is not
// triggered by console.warn writing to stderr (which would set exit code 1).
function error(msg)   { process.stdout.write('  ✗ ' + msg + '\n');  errors++;   }
function warn(msg)    { process.stdout.write('  ⚠ ' + msg + '\n');  warnings++; }
function ok(msg)      { process.stdout.write('  ✓ ' + msg + '\n');               }

// ── Load map ──────────────────────────────────────────────────────────────────

let map;
try {
  map = JSON.parse(fs.readFileSync(MAP_PATH, 'utf8'));
} catch (err) {
  console.error(`Cannot read ${MAP_PATH}: ${err.message}`);
  process.exit(1);
}

console.log('\n── test-map.json validation ─────────────────────────────────────────────────');

// ── 1. Check every test/*.test.ts is in at least one module ──────────────────

console.log('\n1. Backend test file coverage');

const testDir = path.join(ROOT, 'test');
const allTestFiles = fs.readdirSync(testDir)
  .filter(f => f.endsWith('.test.ts'))
  .map(f => 'test/' + f);

const mappedTestFiles = new Set();
for (const [, mod] of Object.entries(map.modules)) {
  for (const t of (mod.tests ?? [])) {
    mappedTestFiles.add(t.replace(/\\/g, '/'));
  }
}

let unmappedTests = 0;
for (const f of allTestFiles) {
  if (!mappedTestFiles.has(f)) {
    error(`Unmapped test file: ${f}`);
    unmappedTests++;
  }
}
if (unmappedTests === 0) {
  ok(`All ${allTestFiles.length} test files are mapped.`);
}

// ── 2. Check mapped source paths exist ───────────────────────────────────────

console.log('\n2. Mapped source paths exist');

let missingCount = 0;
for (const [id, mod] of Object.entries(map.modules)) {
  for (const pattern of (mod.sources ?? [])) {
    const expanded = expandGlob(pattern);
    if (expanded.length === 0) {
      // Only warn for wildcards (they might be future files); error for exact paths
      if (pattern.includes('*')) {
        warn(`Module "${id}": glob "${pattern}" matched no files`);
      } else {
        error(`Module "${id}": source path not found — "${pattern}"`);
        missingCount++;
      }
    }
  }
}
for (const entry of (map.shared ?? [])) {
  for (const pattern of (entry.sources ?? [])) {
    const expanded = expandGlob(pattern);
    if (expanded.length === 0) {
      if (pattern.includes('*')) {
        warn(`Shared entry "${entry.description ?? '?'}": glob "${pattern}" matched no files`);
      } else {
        error(`Shared entry "${entry.description ?? '?'}": source path not found — "${pattern}"`);
        missingCount++;
      }
    }
  }
}
if (missingCount === 0 && warnings === 0) {
  ok('All exact source paths resolve to existing files.');
}

// ── 3. Check every server/ and web/src/ file is mapped ───────────────────────

console.log('\n3. Source file coverage (server/ and web/src/)');

// Collect all files covered by modules + shared
const coveredFiles = new Set();

for (const [, mod] of Object.entries(map.modules)) {
  for (const pattern of (mod.sources ?? [])) {
    for (const f of expandGlob(pattern)) coveredFiles.add(toRelKey(f));
  }
}
for (const entry of (map.shared ?? [])) {
  for (const pattern of (entry.sources ?? [])) {
    for (const f of expandGlob(pattern)) coveredFiles.add(toRelKey(f));
  }
}

// Enumerate server/ and web/src/ (skip node_modules inside web if any)
const serverFiles = [];
collectAllFiles(path.join(ROOT, 'server'), serverFiles);

const webSrcFiles = [];
collectAllFiles(path.join(ROOT, 'web', 'src'), webSrcFiles);

const allSourceFiles = [...serverFiles, ...webSrcFiles]
  .filter(f => !f.includes('node_modules'));

let uncoveredCount = 0;
for (const f of allSourceFiles) {
  const rel = toRelKey(f);
  // Skip test helpers, generated assets, map files, etc.
  if (rel.endsWith('.map') || rel.endsWith('.d.ts')) continue;
  if (!coveredFiles.has(rel)) {
    warn(`Unmapped source file: ${rel}`);
    uncoveredCount++;
  }
}
if (uncoveredCount === 0) {
  ok(`All ${allSourceFiles.length} server/web source files are mapped.`);
} else {
  warn(`${uncoveredCount} source file(s) not mapped to any module or shared entry.`);
  warn('  These will trigger a full run when changed (fail-safe behaviour).');
}

// ── 4. Check mapped test files exist on disk ──────────────────────────────────

console.log('\n4. Mapped test files exist on disk');

let missingTestFiles = 0;
for (const [id, mod] of Object.entries(map.modules)) {
  for (const t of (mod.tests ?? [])) {
    const abs = path.join(ROOT, t.split('/').join(path.sep));
    if (!fs.existsSync(abs)) {
      error(`Module "${id}": test file not found — "${t}"`);
      missingTestFiles++;
    }
  }
}
if (missingTestFiles === 0) ok('All mapped test files exist on disk.');

// ── 5. Validate module IDs in shared "affects" arrays ────────────────────────

console.log('\n5. Shared "affects" references valid module IDs');

const allModuleIds = new Set(Object.keys(map.modules));
let badAffects = 0;
for (const entry of (map.shared ?? [])) {
  if (Array.isArray(entry.affects)) {
    for (const id of entry.affects) {
      if (!allModuleIds.has(id)) {
        error(`Shared entry "${entry.description ?? '?'}": unknown module in affects — "${id}"`);
        badAffects++;
      }
    }
  }
}
if (badAffects === 0) ok('All shared "affects" references are valid module IDs.');

// ── 5b. Validate "part" field in shared entries ───────────────────────────────

console.log('\n5b. Shared "part" field validation');

const VALID_PARTS = new Set(['backend', 'ui', 'both']);
let badParts = 0;
for (const entry of (map.shared ?? [])) {
  const { part, sources = [], description = '?' } = entry;
  if (part === undefined) continue;   // absent is valid (means both)
  if (!VALID_PARTS.has(part)) {
    error(`Shared entry "${description}": invalid "part" value "${part}" — must be "backend", "ui", "both", or absent`);
    badParts++;
    continue;
  }
  // Advisory: warn if declared part doesn't match source paths.
  // test/ui/** files are UI test infrastructure, so part="ui" is correct for them.
  const allWeb          = sources.every(s => s.startsWith('web/'));
  const allBackendTests = sources.every(s => s.startsWith('test/') && !s.startsWith('test/ui/'));
  const allServer       = sources.every(s => s.startsWith('server/'));
  if (part === 'ui' && allBackendTests) {
    warn(`Shared entry "${description}": part="ui" but sources are backend test files — did you mean "backend"?`);
  }
  if (part === 'backend' && allWeb) {
    warn(`Shared entry "${description}": part="backend" but sources are all web/ files — did you mean "ui"?`);
  }
  if (part === 'ui' && allServer) {
    warn(`Shared entry "${description}": part="ui" but sources are all server/ files. Server changes affect the running server seen by smoke tests; consider removing the part restriction.`);
  }
}
if (badParts === 0) ok('All shared "part" values are valid.');

// ── 6. SMOKE_LIST validation (skip if not available) ─────────────────────────
// Rather than running the full smoke suite (slow), we check whether smoke.ts
// mentions "SMOKE_LIST" in its source. If the other agent's changes are in,
// we do a real parse of the SMOKE_LIST=1 output.

console.log('\n6. Smoke ID validation via SMOKE_LIST=1');

const smokeIdsInMap = new Set();
for (const [, mod] of Object.entries(map.modules)) {
  for (const s of (mod.smokeIds ?? [])) smokeIdsInMap.add(s);
}

const smokeSrc = (() => {
  try { return fs.readFileSync(path.join(ROOT, 'test', 'ui', 'smoke.ts'), 'utf8'); }
  catch { return ''; }
})();

if (!smokeSrc.includes('SMOKE_LIST')) {
  warn('SMOKE_LIST is not yet implemented in test/ui/smoke.ts — skipping smoke ID check.');
  warn('Re-run `npm run test:map:check` after the smoke-suite agent adds SMOKE_LIST support.');
} else {
  // SMOKE_LIST is implemented: run it with a short timeout and parse the JSON.
  // The runner prints banner text before the JSON array, so we extract the
  // first '[...]' block from stdout rather than parsing the whole output.
  const smokeResult = spawnSync(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', '--import', 'tsx', 'test/ui/smoke.ts'],
    {
      cwd: ROOT,
      env:      { ...process.env, SMOKE_LIST: '1' },
      encoding: 'utf8',
      timeout:  20_000,
      stdio:    ['ignore', 'pipe', 'pipe'],
    },
  );

  const smokeRaw = (smokeResult.stdout ?? '');
  // Extract the JSON array — everything from the first '[' to the last ']'
  const jsonStart = smokeRaw.indexOf('[');
  const jsonEnd   = smokeRaw.lastIndexOf(']');
  const jsonSlice = jsonStart !== -1 && jsonEnd > jsonStart
    ? smokeRaw.slice(jsonStart, jsonEnd + 1)
    : '';

  if (!jsonSlice) {
    warn('SMOKE_LIST=1 produced no parseable JSON — skipping smoke ID check.');
  } else {
    let smokeRegistry = null;
    try { smokeRegistry = JSON.parse(jsonSlice); } catch { /* ignore */ }

    if (!Array.isArray(smokeRegistry)) {
      warn('SMOKE_LIST=1 JSON is not an array — skipping smoke ID check.');
    } else {
      // Each entry: { section: "47. Dashboard", modules: ["dashboard"] }
      // Collect every module ID registered across all sections.
      const registeredIds = new Set();
      for (const entry of smokeRegistry) {
        if (Array.isArray(entry.modules)) {
          for (const m of entry.modules) registeredIds.add(m.toLowerCase());
        }
      }

      let badSmoke = 0;
      for (const id of smokeIdsInMap) {
        if (!registeredIds.has(id.toLowerCase())) {
          error(`Smoke ID "${id}" is in the map but not registered in any SMOKE_LIST section`);
          badSmoke++;
        }
      }
      if (badSmoke === 0) {
        ok(`All ${smokeIdsInMap.size} map smoke IDs found across ${smokeRegistry.length} smoke sections.`);
      }
    }
  }
}

// ── 7. Known-failures validation ─────────────────────────────────────────────

console.log('\n7. Known-failures list (test/known-failures.json)');

const KF_PATH = path.join(ROOT, 'test', 'known-failures.json');

let knownFailures = [];
try {
  const kfRaw = JSON.parse(fs.readFileSync(KF_PATH, 'utf8'));
  knownFailures = Array.isArray(kfRaw.entries) ? kfRaw.entries : [];
} catch {
  warn('test/known-failures.json is missing or malformed — skipping known-failure validation.');
}

if (knownFailures.length > 0) {
  const allModuleIds  = new Set(Object.keys(map.modules));
  const validParts    = new Set(['backend', 'ui']);
  let kfErrors        = 0;
  let kfWarnings      = 0;

  for (let i = 0; i < knownFailures.length; i++) {
    const entry = knownFailures[i];
    const label = `known-failures[${i}]`;

    // module must exist
    if (!entry.module || !allModuleIds.has(entry.module)) {
      error(`${label}: unknown module "${entry.module}"`);
      kfErrors++;
      continue;
    }

    // part must be valid
    if (!entry.part || !validParts.has(entry.part)) {
      error(`${label}: invalid "part" "${entry.part}" — must be "backend" or "ui"`);
      kfErrors++;
      continue;
    }

    // testName must be present
    if (!entry.testName) {
      error(`${label}: missing "testName"`);
      kfErrors++;
      continue;
    }

    // reason and addedAt are recommended
    if (!entry.reason)   process.stdout.write(`  ⚠ ${label}: missing "reason"\n`);
    if (!entry.addedAt)  process.stdout.write(`  ⚠ ${label}: missing "addedAt"\n`);

    if (entry.part === 'backend') {
      // file should exist on disk if provided
      if (entry.file) {        const absFile = path.join(ROOT, entry.file.split('/').join(path.sep));
        if (!fs.existsSync(absFile)) {
          error(`${label}: test file not found — "${entry.file}"`);
          kfErrors++;
          continue;
        }
        // Verify the module actually has this test file
        const mod = map.modules[entry.module];
        const modTestFiles = (mod.tests ?? []).map(t => t.replace(/\\/g, '/'));
        if (!modTestFiles.includes(entry.file.replace(/\\/g, '/'))) {
          error(`${label}: file "${entry.file}" is not in module "${entry.module}" tests list`);
          kfErrors++;
          continue;
        }

        // Try to verify that testName appears somewhere in the file (static check, warns only)
        if (entry.testName !== '__process_timeout__') {
          try {
            const src = fs.readFileSync(absFile, 'utf8');
            // The testName may contain " > " separating suite from test;
            // look for the leaf part of the testName in the source.
            const leafName = entry.testName.split(' > ').pop().trim();
            // Strip surrounding quotes if present
            const cleanLeaf = leafName.replace(/^["']|["']$/g, '');
            if (cleanLeaf && !src.includes(cleanLeaf)) {
              process.stdout.write(
                `  ⚠ ${label}: test name "${cleanLeaf}" not found statically in ${entry.file} — verify it matches exactly\n`,
              );
              kfWarnings++;
            }
          } catch { /* ignore */ }
        }
      } else if (entry.testName === '__process_timeout__') {
        // Timeout entries must have a file — otherwise they match the wrong hung file in the same module
        error(`${label}: "__process_timeout__" entries must include a "file" field`);
        kfErrors++;
        continue;
      } else {
        // Non-timeout entries without a file: warn
        process.stdout.write(`  ⚠ ${label}: no "file" specified — consider adding the test file path\n`);
        kfWarnings++;
      }
    }

    if (entry.part === 'ui') {
      // sectionId should match a known smoke ID for this module
      if (entry.sectionId) {
        const mod = map.modules[entry.module];
        const smokeIds = mod.smokeIds ?? [];
        if (!smokeIds.includes(entry.sectionId)) {
          error(`${label}: sectionId "${entry.sectionId}" is not in module "${entry.module}" smokeIds`);
          kfErrors++;
        }
      } else {
        process.stdout.write(`  ⚠ ${label}: no "sectionId" specified for ui part — consider adding it\n`);
        kfWarnings++;
      }
    }
  }

  if (kfErrors === 0 && kfWarnings === 0) {
    ok(`All ${knownFailures.length} known-failure entries are valid.`);
  } else if (kfErrors === 0) {
    ok(`Known-failures entries are valid (${kfWarnings} advisory warning(s)).`);
  }
}

// ── Result ────────────────────────────────────────────────────────────────────

console.log('\n─────────────────────────────────────────────────────────────────────────────');
if (errors > 0) {
  console.error(`\n✗ ${errors} error(s), ${warnings} warning(s). Fix errors before running tests.\n`);
  process.exit(1);
} else if (warnings > 0) {
  console.log(`\n⚠ 0 errors, ${warnings} warning(s). Map is usable but review warnings.\n`);
} else {
  console.log('\n✓ Map validation passed.\n');
}
