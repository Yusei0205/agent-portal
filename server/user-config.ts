/**
 * F5 — Personal configuration editor (~/.kiro, ~/.claude, ~/.aws).
 *
 * Storage layout (disk):
 *   {dataDir}/user-config/{userId}/{folder}/{rel_path}
 *
 * Encryption:
 *   aws folder files are encrypted at rest with AES-256-GCM (server/secrets.ts).
 *   kiro and claude files are stored as plain text.
 *
 * Team defaults:
 *   Admins publish versioned snapshots in team_config_versions.
 *   A user who has never edited follows the latest team version.
 *   First edit forks the user off the team version.
 *   Reset restores the latest team version.
 *
 * Routes:
 *   GET  /api/user-config/agents                   — list agents for engine
 *   GET  /api/user-config/:folder/status           — follow state
 *   GET  /api/user-config/:folder/tree             — file tree
 *   GET  /api/user-config/:folder/file             — read file
 *   POST /api/user-config/:folder/file             — create file
 *   PUT  /api/user-config/:folder/file             — write file (JSON validated)
 *   DELETE /api/user-config/:folder/file           — delete
 *   POST /api/user-config/:folder/folder           — create directory
 *   PATCH /api/user-config/:folder/rename          — rename
 *   POST /api/user-config/:folder/reset            — reset to team version
 *   GET  /api/user-config/:folder/export           — download zip
 *   POST /api/user-config/:folder/import           — import zip
 *   POST /api/user-config/:folder/import-local     — import from OS home dir (localhost only)
 *   POST /api/admin/user-config/:folder/publish    — publish team default (admin)
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { router, sendJson, requireAuth } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { one } from './db.ts';
import type { Row } from './db.ts';
import { generateId, now, badRequest, safeJoin, sha256 } from './util.ts';
import { config } from './config.ts';
import { encrypt, decrypt } from './secrets.ts';
import { appendAudit, auditRaw } from './audit.ts';
import { getDb } from './db.ts';
import { getUserConfigRepository } from './repositories/user-config.ts';

import { getWorkflowRow } from './project-access.ts';
// ── Constants ─────────────────────────────────────────────────────────────────

const VALID_FOLDERS = ['kiro', 'claude', 'aws'] as const;
export type ConfigFolder = (typeof VALID_FOLDERS)[number];

/** Max file content size when reading/writing via API. */
const MAX_FILE_BYTES = 1 * 1024 * 1024;  // 1 MB
/** Max total folder size when importing a zip. */
const MAX_FOLDER_BYTES = 50 * 1024 * 1024; // 50 MB

// ── Types ─────────────────────────────────────────────────────────────────────

/** One entry in a team config version's files array. */
interface TeamFile {
  path: string;
  /** File content (plaintext for kiro/claude; encrypted-string for aws). null for dirs. */
  content: string | null;
  isDir: boolean;
}

interface TreeEntry {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size?: number;
}

// ── Path helpers ──────────────────────────────────────────────────────────────

function userConfigRoot(userId: string, folder: ConfigFolder): string {
  return path.join(config.dataDir, 'user-config', userId, folder);
}

/**
 * Resolve a user-supplied relative path inside a folder, refusing traversal.
 * Decodes percent-encoded characters before checking (e.g., %2e%2e → ..).
 * Returns the absolute path.
 */
function resolveConfigPath(userId: string, folder: ConfigFolder, relPath: string): string {
  const root = userConfigRoot(userId, folder);
  if (!relPath || relPath === '.') return root;
  // Decode percent-encoded chars to catch %2e%2e → .. traversal attempts
  let decoded: string;
  try {
    decoded = decodeURIComponent(relPath);
  } catch {
    throw badRequest('Invalid path encoding');
  }
  const resolved = path.resolve(root, decoded);
  const resolvedRoot = path.resolve(root);
  if (!resolved.startsWith(resolvedRoot + path.sep) && resolved !== resolvedRoot) {
    throw badRequest('Path traversal detected');
  }
  return resolved;
}

// ── Cache-file exclusion for zip exports ─────────────────────────────────────

const CACHE_DIR_PATTERNS = [
  'sso/cache',
  '.sso/cache',
  'cli/cache',
  '.cli/cache',
];

const CACHE_FILE_NAMES = new Set([
  '.credentials.json',
  '.auth.json',
  'credentials.json',
]);

/** Returns true if the given relative path is a token/cache file to omit from exports. */
export function isCacheExcluded(relPath: string): boolean {
  const p = relPath.replace(/\\/g, '/');
  for (const dir of CACHE_DIR_PATTERNS) {
    if (p === dir || p.startsWith(dir + '/')) return true;
  }
  const base = p.split('/').pop() ?? '';
  if (base.endsWith('.token') || base.endsWith('.tokeninfo')) return true;
  if (CACHE_FILE_NAMES.has(base)) return true;
  return false;
}

// ── Encryption helpers for aws ────────────────────────────────────────────────

/** Read a config file from disk, decrypting if it belongs to the aws folder. */
function readConfigFileSync(absPath: string, folder: ConfigFolder): string {
  const raw = fs.readFileSync(absPath, 'utf8');
  if (folder === 'aws') {
    return decrypt(raw, config.secretKey);
  }
  return raw;
}

/** Write a config file to disk, encrypting if it belongs to the aws folder. */
function writeConfigFileSync(absPath: string, content: string, folder: ConfigFolder): void {
  const data = folder === 'aws' ? encrypt(content, config.secretKey) : content;
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, data, 'utf8');
}

// ── DB helpers ────────────────────────────────────────────────────────────────

interface UserConfigState {
  following: boolean;
  customisedAt: string | null;
  teamVersionId: string | null;
}

async function getState(userId: string, folder: ConfigFolder): Promise<UserConfigState> {
  const row = await getUserConfigRepository().getState(userId, folder);
  if (!row) return { following: true, customisedAt: null, teamVersionId: null };
  return {
    following: Boolean(row.following),
    customisedAt: row.customised_at ?? null,
    teamVersionId: row.team_version_id ?? null,
  };
}

async function getLatestTeamVersion(folder: ConfigFolder) {
  return getUserConfigRepository().getLatestTeamVersion(folder);
}

function parseTeamFiles(tv: { files_json: string }): TeamFile[] {
  try {
    const arr = JSON.parse(tv.files_json ?? '[]');
    return Array.isArray(arr) ? arr as TeamFile[] : [];
  } catch {
    return [];
  }
}

/**
 * If the user is currently following the team version, fork them off.
 */
async function ensureNotFollowing(userId: string, folder: ConfigFolder): Promise<void> {
  const state = await getState(userId, folder);
  if (!state.following) return;

  const tv = await getLatestTeamVersion(folder);
  if (tv) {
    const files = parseTeamFiles(tv);
    const root = userConfigRoot(userId, folder);
    for (const f of files) {
      const abs = path.join(root, f.path);
      if (f.isDir) {
        fs.mkdirSync(abs, { recursive: true });
      } else if (f.content !== null) {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, f.content, 'utf8');
      }
    }
  }

  const ts = now();
  const tvId = tv?.id ?? null;
  await getUserConfigRepository().setState(userId, folder, {
    following: 0,
    customised_at: ts,
    team_version_id: tvId,
  });
}

/** Build the status payload for the status endpoint. */
async function buildStatus(userId: string, folder: ConfigFolder): Promise<object> {
  const state = await getState(userId, folder);
  const tv = await getLatestTeamVersion(folder);
  return {
    following: state.following,
    customisedAt: state.customisedAt ?? null,
    teamVersion: tv ? tv.id : null,
    teamPublishedAt: tv ? tv.published_at : null,
  };
}

// ── Tree listing ──────────────────────────────────────────────────────────────

function listDirEntries(absDir: string, root: string): TreeEntry[] {
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const entries: TreeEntry[] = [];
  for (const d of dirents) {
    const absPath = path.join(absDir, d.name);
    const relPath = path.relative(root, absPath);
    if (d.isDirectory()) {
      entries.push({ name: d.name, path: relPath, type: 'dir' });
    } else if (d.isFile()) {
      let size: number | undefined;
      try { size = fs.statSync(absPath).size; } catch { /* best-effort */ }
      entries.push({ name: d.name, path: relPath, type: 'file', size });
    }
  }
  return entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function buildTreeFromTeamFiles(files: TeamFile[], relPath: string): TreeEntry[] {
  // Filter to entries at the requested level
  const prefix = relPath ? relPath.replace(/\\/g, '/') + '/' : '';
  const seen = new Set<string>();
  const entries: TreeEntry[] = [];

  for (const f of files) {
    const fp = f.path.replace(/\\/g, '/');
    if (!fp.startsWith(prefix)) continue;
    const rest = fp.slice(prefix.length);
    if (!rest || rest.includes('/')) continue; // deeper level — skip
    if (seen.has(rest)) continue;
    seen.add(rest);
    if (f.isDir) {
      entries.push({ name: rest, path: f.path, type: 'dir' });
    } else {
      const size = f.content ? Buffer.byteLength(f.content, 'utf8') : 0;
      entries.push({ name: rest, path: f.path, type: 'file', size });
    }
  }
  return entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

// ── JSON validation ───────────────────────────────────────────────────────────

/** Returns an error message if content is invalid JSON, or null if valid / not a JSON file. */
function validateJson(filePath: string, content: string): string | null {
  if (!filePath.endsWith('.json') && !filePath.endsWith('.jsonc')) return null;
  try {
    JSON.parse(content);
    return null;
  } catch (e: unknown) {
    return String((e as Error)?.message ?? 'Invalid JSON');
  }
}

// ── Zip helpers ───────────────────────────────────────────────────────────────

/** Build a zip of the user's (or team's) effective config folder, omitting cache files. */
async function buildExportZip(userId: string, folder: ConfigFolder): Promise<Buffer> {
  const zip = new JSZip();
  const state = await getState(userId, folder);

  if (state.following) {
    const tv = await getLatestTeamVersion(folder);
    if (tv) {
      const files = parseTeamFiles(tv);
      for (const f of files) {
        if (f.isDir || f.content === null) continue;
        if (isCacheExcluded(f.path)) continue;
        // Decrypt aws content before adding to zip
        const content = folder === 'aws' ? decrypt(f.content, config.secretKey) : f.content;
        zip.file(f.path, content);
      }
    }
  } else {
    const root = userConfigRoot(userId, folder);
    const walkDir = (dir: string): void => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const abs = path.join(dir, e.name);
        const rel = path.relative(root, abs).replace(/\\/g, '/');
        if (isCacheExcluded(rel)) continue;
        if (e.isDirectory()) {
          walkDir(abs);
        } else if (e.isFile()) {
          try {
            const content = readConfigFileSync(abs, folder); // decrypts if aws
            zip.file(rel, content);
          } catch {
            // Skip unreadable files
          }
        }
      }
    };
    walkDir(root);
  }

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// Caps for zip bomb protection
const MAX_ZIP_ENTRIES = 2000;
const MAX_DECLARED_SIZE_PER_ENTRY = MAX_FOLDER_BYTES; // single entry can't exceed total limit

/** Parse a zip buffer and return file entries, validating paths. */
async function parseImportZip(
  zipBuffer: Buffer,
  folder: ConfigFolder,
): Promise<Array<{ path: string; content: string }>> {
  const zip = await JSZip.loadAsync(zipBuffer);

  const allFiles = Object.entries(zip.files) as Array<[string, JSZip.JSZipObject]>;

  // Guard 1: entry count cap
  const fileEntries = allFiles.filter(([, f]) => !f.dir);
  if (fileEntries.length > MAX_ZIP_ENTRIES) {
    throw badRequest(`Zip contains too many entries (${fileEntries.length} > ${MAX_ZIP_ENTRIES})`);
  }

  const result: Array<{ path: string; content: string }> = [];
  let totalDeclaredSize = 0;
  let totalDecompressedSize = 0;

  for (const [name, file] of allFiles) {
    if (file.dir) continue;
    const rel = name.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!rel) continue;

    // Validate path does not escape
    try {
      safeJoin('/fake-root', rel);
    } catch {
      continue;
    }

    if (isCacheExcluded(rel)) continue;

    // Guard 2: check declared uncompressed size before decompressing (zip bomb prevention).
    // JSZip stores the parsed central-directory metadata in _data; access via cast.
    const declaredSize: number = (file as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
    if (declaredSize > MAX_DECLARED_SIZE_PER_ENTRY) {
      throw badRequest(
        `Zip entry "${rel}" declares uncompressed size ${declaredSize} bytes which exceeds the per-entry limit`,
      );
    }
    totalDeclaredSize += declaredSize;
    if (totalDeclaredSize > MAX_FOLDER_BYTES) {
      throw badRequest(`Import exceeds ${MAX_FOLDER_BYTES / 1024 / 1024} MB limit (declared sizes)`);
    }

    const content = await file.async('string');
    const actualSize = Buffer.byteLength(content, 'utf8');

    // Guard 3: actual decompressed size mismatch check (detects malformed zips)
    if (declaredSize > 0 && actualSize > declaredSize * 2 + 64) {
      throw badRequest(
        `Zip entry "${rel}" decompressed to ${actualSize} bytes but declared only ${declaredSize} — possible zip bomb`,
      );
    }

    totalDecompressedSize += actualSize;
    if (totalDecompressedSize > MAX_FOLDER_BYTES) {
      throw badRequest(`Import exceeds ${MAX_FOLDER_BYTES / 1024 / 1024} MB limit`);
    }

    result.push({ path: rel, content });
  }
  return result;
}

// ── Local import ─────────────────────────────────────────────────────────────
//
// Copies setup files from the OS user's home directory (.kiro or .claude)
// into the portal's per-user configuration storage.
//
// Include rules:
//   kiro   — agents/, skills/, steering/, hooks/, settings/, prompts/,
//            design-skills/
//   claude — agents/, skills/, commands/, hooks/, rules/, steering/,
//            design-skills/, output-styles/, plus root-level CLAUDE.md and
//            settings.json
//
// Exclude rules (applied within included dirs):
//   dirs:  sessions/, projects/, todos/, shell-snapshots/, statsig/, state/,
//          backups/, logs/, cache/, ide/, node_modules/, .git/, .trash/
//   files: .credentials.json, *credential*, *token*, *.sqlite*, history.jsonl,
//          .last-cleanup, mcp-needs-auth-cache*, *.bak*, *.lock, .DS_Store
//   size:  files over MAX_FILE_BYTES (1 MB)
//   links: symbolic links are always skipped
//
// JSON secret redaction:
//   env objects: keys matching KEY|TOKEN|SECRET|PASSWORD → "<set-in-vault>"
//   headers objects: Authorization, X-Api-Key, X-Goog-Api-Key, or any key
//     matching key|token|secret|auth → "<set-in-vault>"

/** Max size for a single file imported from the local OS home. */
const LOCAL_MAX_FILE_BYTES = MAX_FILE_BYTES; // 1 MB

/** Top-level directories included in kiro local imports. */
const KIRO_INCLUDE_DIRS = new Set([
  'agents', 'skills', 'steering', 'hooks', 'settings', 'prompts', 'design-skills',
]);

/** Top-level directories included in claude local imports. */
const CLAUDE_INCLUDE_DIRS = new Set([
  'agents', 'skills', 'commands', 'hooks', 'rules', 'steering', 'design-skills', 'output-styles',
]);

/** Root-level files included from the .claude folder (lower-cased). */
const CLAUDE_ROOT_FILES = new Set(['claude.md', 'settings.json']);

/** Directory segment names that trigger exclusion when found anywhere in a path. */
const LOCAL_EXCLUDED_DIR_SEGS = new Set([
  'sessions', 'projects', 'todos', 'shell-snapshots', 'statsig', 'state',
  'backups', 'logs', 'cache', 'ide', 'node_modules', '.git', '.trash', 'browser',
]);

/** Exact base-name matches (lower-cased) that are always excluded. */
const LOCAL_EXCLUDED_NAMES = new Set([
  '.credentials.json', 'history.jsonl', '.last-cleanup', '.ds_store', '.gitkeep',
]);

/** Regexes tested against the lower-cased base name. */
const LOCAL_EXCLUDED_RES: RegExp[] = [
  /credential/i,
  /\btoken\b/i,
  /\.sqlite/i,
  /^mcp-needs-auth-cache/i,
  /\.bak(\.|$|-)/i,
  /\.lock$/i,
];

/**
 * Decide whether a file from the OS home .kiro or .claude should be included
 * in a portal config import.
 *
 * @param folder    'kiro' | 'claude'
 * @param relPath   Forward-slash path relative to .kiro or .claude root
 * @param sizeBytes File size in bytes
 */
export function shouldIncludeLocalFile(
  folder: 'kiro' | 'claude',
  relPath: string,
  sizeBytes: number,
): { include: boolean; reason?: string } {
  const p = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!p) return { include: false, reason: 'empty path' };

  const parts = p.split('/');
  const base = parts[parts.length - 1];
  const baseLower = base.toLowerCase();
  const topDir = parts[0];
  const isRoot = parts.length === 1;

  // 1. Per-folder top-level include guard
  if (folder === 'kiro') {
    if (!KIRO_INCLUDE_DIRS.has(topDir)) {
      return { include: false, reason: `not in an included kiro directory (${topDir})` };
    }
  } else {
    if (isRoot) {
      if (!CLAUDE_ROOT_FILES.has(baseLower)) {
        return { include: false, reason: `root-level file not in include list (${base})` };
      }
    } else if (!CLAUDE_INCLUDE_DIRS.has(topDir)) {
      return { include: false, reason: `not in an included claude directory (${topDir})` };
    }
  }

  // 2. Excluded directory segments anywhere in the path (not the file name itself)
  for (const seg of parts.slice(0, -1)) {
    if (LOCAL_EXCLUDED_DIR_SEGS.has(seg.toLowerCase())) {
      return { include: false, reason: `in excluded directory (${seg})` };
    }
  }

  // 3. Excluded exact file names
  if (LOCAL_EXCLUDED_NAMES.has(baseLower)) {
    return { include: false, reason: `excluded file name (${base})` };
  }

  // 4. Excluded name patterns
  for (const re of LOCAL_EXCLUDED_RES) {
    if (re.test(baseLower)) {
      return { include: false, reason: `excluded by name pattern (${base})` };
    }
  }

  // 5. Size limit
  if (sizeBytes > LOCAL_MAX_FILE_BYTES) {
    return { include: false, reason: `file too large (${sizeBytes} bytes)` };
  }

  return { include: true };
}

/** Env-key regex for secret redaction. */
const REDACT_ENV_KEY_RE = /KEY|TOKEN|SECRET|PASSWORD/i;
/** Exact lower-cased header names to redact. */
const REDACT_HEADER_EXACT = new Set(['authorization', 'x-api-key', 'x-goog-api-key']);
/** Regex for any other header key that looks like a credential. */
const REDACT_HEADER_RE = /key|token|secret|auth/i;
const REDACT_PLACEHOLDER = '<set-in-vault>';

export interface RedactResult {
  content: string;
  redacted: string[];
}

/**
 * Parse a JSON file's content, replace obvious secret values with
 * REDACT_PLACEHOLDER, and return the (possibly modified) content plus a list
 * of the key paths that were redacted.  Non-JSON files are returned unchanged.
 */
export function redactJsonSecrets(relPath: string, content: string): RedactResult {
  if (!relPath.endsWith('.json') && !relPath.endsWith('.jsonc')) {
    return { content, redacted: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { content, redacted: [] };
  }

  const redacted: string[] = [];

  function visit(node: unknown, keyPath: string): void {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) return;
    const obj = node as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      const childPath = keyPath ? `${keyPath}.${key}` : key;
      const val = obj[key];

      if (key === 'env' && typeof val === 'object' && val !== null && !Array.isArray(val)) {
        const envObj = val as Record<string, unknown>;
        for (const envKey of Object.keys(envObj)) {
          if (
            REDACT_ENV_KEY_RE.test(envKey) &&
            typeof envObj[envKey] === 'string' &&
            (envObj[envKey] as string).length > 0 &&
            envObj[envKey] !== REDACT_PLACEHOLDER
          ) {
            redacted.push(`${childPath}.${envKey}`);
            envObj[envKey] = REDACT_PLACEHOLDER;
          }
        }
      } else if (key === 'headers' && typeof val === 'object' && val !== null && !Array.isArray(val)) {
        const hObj = val as Record<string, unknown>;
        for (const hKey of Object.keys(hObj)) {
          const hLower = hKey.toLowerCase();
          if (
            (REDACT_HEADER_EXACT.has(hLower) || REDACT_HEADER_RE.test(hLower)) &&
            typeof hObj[hKey] === 'string' &&
            (hObj[hKey] as string).length > 0 &&
            hObj[hKey] !== REDACT_PLACEHOLDER
          ) {
            redacted.push(`${childPath}.${hKey}`);
            hObj[hKey] = REDACT_PLACEHOLDER;
          }
        }
      } else if (typeof val === 'object') {
        visit(val, childPath);
      }
    }
  }

  visit(parsed, '');

  return {
    content: redacted.length > 0 ? JSON.stringify(parsed, null, 2) : content,
    redacted,
  };
}

export interface LocalImportSummary {
  /** Files imported, grouped by top-level directory (or root file name). */
  imported: Record<string, string[]>;
  /** Files that were skipped, with the reason each was excluded. */
  skipped: Array<{ path: string; reason: string }>;
  /** JSON key paths whose values were replaced with '<set-in-vault>'. */
  valuesRedacted: string[];
  /** Absolute path of the backup taken before writing, or null if there was nothing to back up. */
  backupPath: string | null;
}

/**
 * Back up the user's current portal config folder to data/backups/ if it
 * contains any files.  Returns the backup path, or null if the folder was
 * empty or non-existent.
 */
export async function backupUserConfigFolder(
  userId: string,
  folder: ConfigFolder,
  dataDir: string,
): Promise<string | null> {
  const root = userConfigRoot(userId, folder);
  if (!fs.existsSync(root)) return null;

  // Quick check for any file in the tree
  let hasFiles = false;
  const scan = (dir: string): void => {
    if (hasFiles) return;
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isFile()) { hasFiles = true; return; }
        if (e.isDirectory()) scan(path.join(dir, e.name));
      }
    } catch { /* ignore */ }
  };
  scan(root);
  if (!hasFiles) return null;

  const ts = new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .slice(0, 19); // 2026-11-01_14-30-00
  const backupDir = path.join(
    dataDir, 'backups', `user-config-${userId}-${folder}-${ts}`,
  );
  await fsp.mkdir(backupDir, { recursive: true });

  const copyDir = async (src: string, dst: string): Promise<void> => {
    await fsp.mkdir(dst, { recursive: true });
    for (const e of await fsp.readdir(src, { withFileTypes: true })) {
      const srcP = path.join(src, e.name);
      const dstP = path.join(dst, e.name);
      if (e.isDirectory()) {
        await copyDir(srcP, dstP);
      } else if (e.isFile()) {
        await fsp.copyFile(srcP, dstP);
      }
    }
  };
  await copyDir(root, backupDir);
  return backupDir;
}

/**
 * Import setup files from the OS user's home directory (homeDir/.kiro or
 * homeDir/.claude) into the portal's per-user config storage for `folder`.
 *
 * - Only copies files that pass shouldIncludeLocalFile.
 * - Redacts obvious secret values in JSON files before writing.
 * - Backs up the existing portal config (if any) to data/backups/ first.
 * - Marks the user's config as customised (following = false).
 *
 * @param userId  Portal user ID.
 * @param folder  'kiro' | 'claude'.
 * @param homeDir OS home directory (defaults to os.homedir()).
 */
export async function importLocalConfig(
  userId: string,
  folder: 'kiro' | 'claude',
  homeDir?: string,
): Promise<LocalImportSummary> {
  const home = homeDir ?? os.homedir();
  const srcRoot = path.join(home, folder === 'kiro' ? '.kiro' : '.claude');
  const destRoot = userConfigRoot(userId, folder);

  // Back up existing portal config before touching anything
  const backupPath = await backupUserConfigFolder(userId, folder, config.dataDir);

  const importedByTop: Record<string, string[]> = {};
  const skipped: Array<{ path: string; reason: string }> = [];
  const allRedacted: string[] = [];

  const walkDir = async (srcDir: string, relBase: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(srcDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const e of entries) {
      const relPath = relBase ? `${relBase}/${e.name}` : e.name;

      if (e.isSymbolicLink()) {
        skipped.push({ path: relPath, reason: 'symbolic link skipped' });
        continue;
      }

      if (e.isDirectory()) {
        await walkDir(path.join(srcDir, e.name), relPath);
        continue;
      }

      if (!e.isFile()) continue;

      let sizeBytes = 0;
      try {
        const stat = await fsp.stat(path.join(srcDir, e.name));
        sizeBytes = stat.size;
      } catch {
        skipped.push({ path: relPath, reason: 'could not stat file' });
        continue;
      }

      const check = shouldIncludeLocalFile(folder, relPath, sizeBytes);
      if (!check.include) {
        skipped.push({ path: relPath, reason: check.reason ?? 'excluded' });
        continue;
      }

      let content: string;
      try {
        content = await fsp.readFile(path.join(srcDir, e.name), 'utf8');
      } catch {
        skipped.push({ path: relPath, reason: 'unreadable (binary or permission denied)' });
        continue;
      }

      // Redact obvious secrets in JSON
      const { content: clean, redacted } = redactJsonSecrets(relPath, content);
      content = clean;
      if (redacted.length > 0) allRedacted.push(...redacted);

      // Path-containment: destination must stay inside destRoot
      let destPath: string;
      try {
        destPath = safeJoin(destRoot, relPath);
      } catch {
        skipped.push({ path: relPath, reason: 'path traversal detected' });
        continue;
      }

      try {
        await fsp.mkdir(path.dirname(destPath), { recursive: true });
        await fsp.writeFile(destPath, content, 'utf8');
      } catch (e2: unknown) {
        skipped.push({
          path: relPath,
          reason: `write failed: ${String((e2 as Error)?.message ?? e2)}`,
        });
        continue;
      }

      const topLevel = relPath.split('/')[0];
      (importedByTop[topLevel] ??= []).push(relPath);
    }
  };

  if (fs.existsSync(srcRoot)) {
    await walkDir(srcRoot, '');
  }

  // Mark config as customised (following = false)
  const ts = now();
  await getUserConfigRepository().setState(userId, folder, {
    following: 0,
    customised_at: ts,
    team_version_id: null,
  });

  return { imported: importedByTop, skipped, valuesRedacted: allRedacted, backupPath };
}

// ── Run home directory registry ───────────────────────────────────────────────
// Stores workDir/home paths keyed by runId so engines can optionally set HOME.

const _runHomeDirs = new Map<string, string>();

export function getRunHomeDir(runId: string): string | null {
  return _runHomeDirs.get(runId) ?? null;
}

// NOTE: kiro-cli ACP saves sessions to the REAL user profile at
// %USERPROFILE%\.kiro\sessions\cli\ regardless of where HOME is pointed.
// The materialised temp HOME never contains Kiro session data, so no
// copy/restore step is needed (the previous preserve/restoreKiroSessions
// functions were dead code built on a wrong assumption).

/**
 * Delete the materialised home directory for a run and remove it from the registry.
 * Called from agent/runner.ts after the engine exits to remove decrypted secrets.
 * Never deletes workDir itself — only the `home/` subdirectory inside it.
 *
 * Retries up to 3 times with backoff: on Windows, newly-written files can be
 * briefly locked by antivirus or the OS file indexer (EBUSY/EPERM), causing an
 * immediate rm to fail. Remaining failures are logged so the operator knows that
 * decrypted credentials may still be on disk.
 */
export async function cleanupRunHome(runId: string): Promise<void> {
  const homeDir = _runHomeDirs.get(runId);
  _runHomeDirs.delete(runId);
  if (!homeDir) return;
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      await new Promise<void>((res) => setTimeout(res, 150 * attempt));
    }
    try {
      await fsp.rm(homeDir, { recursive: true, force: true });
      return;
    } catch (e: unknown) {
      lastError = e;
    }
  }
  // All three attempts failed — log so the operator is aware that decrypted
  // secrets were not removed from the run home directory.
  console.error(`[user-config] cleanupRunHome failed for run ${runId} after 3 attempts:`, lastError);
}

// ── Materialise for run ───────────────────────────────────────────────────────

/**
 * Materialise the workflow owner's effective config into {workDir}/home/.
 * Called from runner.ts as a one-line hook after createWorkDir().
 *
 * Creates:
 *   {workDir}/home/.kiro/    — owner's kiro config (or team default)
 *   {workDir}/home/.claude/  — owner's claude config (or team default)
 *   {workDir}/home/.aws/     — owner's aws config (decrypted)
 *
 * Stores the home dir in _runHomeDirs so engines can set HOME={workDir}/home.
 */
export async function materialiseForRun(
  workflowId: string,
  _runId: string,
  workDir: string,
): Promise<void> {
  try {
    const wf = await getWorkflowRow(workflowId);
    if (!wf || !wf.created_by) return;
    const userId = String(wf.created_by);

    const homeDir = path.join(workDir, 'home');
    await fsp.mkdir(homeDir, { recursive: true });

    // Register home dir for this run
    _runHomeDirs.set(_runId, homeDir);
    // Clean up after run ends (non-blocking, best-effort)
    setTimeout(() => { _runHomeDirs.delete(_runId); }, 24 * 3600_000).unref();

    for (const folder of VALID_FOLDERS) {
      const destDir = path.join(homeDir, `.${folder}`); // .kiro, .claude, .aws
      await fsp.mkdir(destDir, { recursive: true });

      const state = await getState(userId, folder);

      if (state.following) {
        // Use team version
        const tv = await getLatestTeamVersion(folder);
        if (!tv) continue;
        const files = parseTeamFiles(tv);
        for (const f of files) {
          const dest = path.join(destDir, f.path);
          if (f.isDir) {
            await fsp.mkdir(dest, { recursive: true });
          } else if (f.content !== null) {
            await fsp.mkdir(path.dirname(dest), { recursive: true });
            const plaintext = folder === 'aws' ? decrypt(f.content, config.secretKey) : f.content;
            await fsp.writeFile(dest, plaintext, 'utf8');
          }
        }
      } else {
        // Copy user's disk files (decrypting aws)
        const root = userConfigRoot(userId, folder);
        if (!fs.existsSync(root)) continue;
        const copyDir = async (src: string, dst: string): Promise<void> => {
          await fsp.mkdir(dst, { recursive: true });
          const entries = await fsp.readdir(src, { withFileTypes: true });
          for (const e of entries) {
            const srcPath = path.join(src, e.name);
            const dstPath = path.join(dst, e.name);
            if (e.isDirectory()) {
              await copyDir(srcPath, dstPath);
            } else if (e.isFile()) {
              try {
                const plaintext = readConfigFileSync(srcPath, folder);
                await fsp.writeFile(dstPath, plaintext, 'utf8');
              } catch {
                // Skip unreadable/unencryptable files
              }
            }
          }
        };
        await copyDir(root, destDir);
      }
    }
  } catch (e: unknown) {
    // Materialisation is non-fatal — log but don't abort the run
    console.warn(`[user-config] materialiseForRun failed for ${workflowId}:`, e);
  }
}

// ── Auth helpers ──────────────────────────────────────────────────────────────

function validateFolder(
  req: PortalRequest,
  res: PortalResponse,
): ConfigFolder | null {
  const f = req.params.folder as string;
  if (!(VALID_FOLDERS as readonly string[]).includes(f)) {
    sendJson(res, 400, { error: `folder must be one of: ${VALID_FOLDERS.join(', ')}` });
    return null;
  }
  return f as ConfigFolder;
}

/**
 * Returns true if the request carries any Bearer token (API-token auth).
 * Applies regardless of the token prefix so that aws-folder and write-scope
 * rules fire correctly even if TOKEN_PREFIX ever changes.
 */
function isTokenAuth(req: PortalRequest): boolean {
  const authHeader = req.headers.authorization;
  return !!(authHeader && String(authHeader).startsWith('Bearer '));
}

/** Get the scope of the bearer token using the already-populated req.tokenScopes. */
function getTokenScope(req: PortalRequest): string | null {
  if (!isTokenAuth(req)) return null;
  // req.tokenScopes is set by auth.ts authenticator; no DB lookup needed.
  const scopes = req.tokenScopes ?? [];
  return scopes.includes('write') ? 'write' : 'read';
}

/** Checks write scope for API token requests; browser sessions are always allowed. */
function requireWriteScope(req: PortalRequest, res: PortalResponse): boolean {
  if (!isTokenAuth(req)) return true; // browser session: always allowed
  // Use req.tokenScopes (populated by auth.ts) instead of a legacy DB re-lookup
  if (!(req.tokenScopes ?? []).includes('write')) {
    sendJson(res, 403, { error: 'Write scope required for this operation' });
    return false;
  }
  return true;
}

// ── Agents endpoint helper ────────────────────────────────────────────────────

interface AgentEntry {
  name: string;
  description?: string;
}

export async function listAgentsForEngine(userId: string, engine: string): Promise<AgentEntry[]> {
  const agents: AgentEntry[] = [];

  if (engine === 'kiro') {
    // Read kiro agents: ~/.kiro/agents/*.json
    const state = await getState(userId, 'kiro');
    let agentFiles: Array<{ path: string; content: string }> = [];

    if (state.following) {
      const tv = await getLatestTeamVersion('kiro');
      if (tv) {
        const files = parseTeamFiles(tv);
        agentFiles = files
          .filter((f) => !f.isDir && f.content !== null && /^agents\/[^/]+\.json$/.test(f.path))
          .map((f) => ({ path: f.path, content: f.content! }));
      }
    } else {
      const root = userConfigRoot(userId, 'kiro');
      const agentsDir = path.join(root, 'agents');
      if (fs.existsSync(agentsDir)) {
        for (const name of fs.readdirSync(agentsDir)) {
          if (!name.endsWith('.json')) continue;
          try {
            const content = fs.readFileSync(path.join(agentsDir, name), 'utf8');
            agentFiles.push({ path: `agents/${name}`, content });
          } catch { /* skip */ }
        }
      }
    }

    for (const { path: fp, content } of agentFiles) {
      try {
        const parsed = JSON.parse(content) as Record<string, unknown>;
        const name = String(parsed.name ?? path.basename(fp, '.json'));
        const description = parsed.description ? String(parsed.description) : undefined;
        agents.push({ name, description });
      } catch { /* skip invalid JSON */ }
    }
  } else if (engine === 'claude-code') {
    // Read claude agents: ~/.claude/agents/*.md
    const state = await getState(userId, 'claude');
    let agentFiles: Array<{ path: string; content: string }> = [];

    if (state.following) {
      const tv = await getLatestTeamVersion('claude');
      if (tv) {
        const files = parseTeamFiles(tv);
        agentFiles = files
          .filter((f) => !f.isDir && f.content !== null && /^agents\/[^/]+\.md$/.test(f.path))
          .map((f) => ({ path: f.path, content: f.content! }));
      }
    } else {
      const root = userConfigRoot(userId, 'claude');
      const agentsDir = path.join(root, 'agents');
      if (fs.existsSync(agentsDir)) {
        for (const name of fs.readdirSync(agentsDir)) {
          if (!name.endsWith('.md')) continue;
          try {
            const content = fs.readFileSync(path.join(agentsDir, name), 'utf8');
            agentFiles.push({ path: `agents/${name}`, content });
          } catch { /* skip */ }
        }
      }
    }

    for (const { path: fp, content } of agentFiles) {
      // Claude Code subagents are identified by YAML front matter (name, description).
      // Fall back to the first heading, then the filename, for older files.
      const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      const fmField = (key: string): string | undefined => {
        if (!fm) return undefined;
        const m = fm[1].match(new RegExp(`^${key}:\\s*(.*)$`, 'm'));
        const v = m?.[1].trim().replace(/^['"]|['"]$/g, '');
        return v && v !== '>-' && v !== '|' ? v : undefined;
      };
      const headingMatch = content.match(/^#\s+(.+)/m);
      const descMatch = content.match(/^(?:>|Description:)\s*(.+)/m);
      const name = fmField('name') ?? (headingMatch ? headingMatch[1].trim() : path.basename(fp, '.md'));
      const description = fmField('description') ?? (descMatch ? descMatch[1].trim() : undefined);
      agents.push({ name, description });
    }
  }

  return agents;
}

// ── Route registration ────────────────────────────────────────────────────────

export function registerUserConfigRoutes(): void {

  // ── Agents discovery (must be before /:folder routes) ─────────────────────

  // GET /api/user-config/agents?engine=kiro|claude-code
  router.get('/api/user-config/agents', requireAuth(async (req: PortalRequest, res: PortalResponse) => {
    const engine = req.query.get('engine') ?? '';
    if (!['kiro', 'claude-code'].includes(engine)) {
      sendJson(res, 400, { error: 'engine must be kiro or claude-code' });
      return;
    }
    const agents = await listAgentsForEngine(req.user!.id, engine);
    sendJson(res, 200, { engine, agents });
  }));

  // ── Per-folder status ──────────────────────────────────────────────────────

  // GET /api/user-config/:folder/status
  router.get('/api/user-config/:folder/status', requireAuth(async (req: PortalRequest, res: PortalResponse) => {
    const folder = validateFolder(req, res);
    if (!folder) return;
    sendJson(res, 200, await buildStatus(req.user!.id, folder));
  }));

  // ── Tree listing ───────────────────────────────────────────────────────────

  // GET /api/user-config/:folder/tree
  router.get('/api/user-config/:folder/tree', requireAuth(async (req: PortalRequest, res: PortalResponse) => {
    const folder = validateFolder(req, res);
    if (!folder) return;

    const userId = req.user!.id;
    const relPath = req.query.get('path') ?? '';

    const state = await getState(userId, folder);

    if (state.following) {
      const tv = await getLatestTeamVersion(folder);
      const files = tv ? parseTeamFiles(tv) : [];
      sendJson(res, 200, { following: true, entries: buildTreeFromTeamFiles(files, relPath) });
      return;
    }

    const root = userConfigRoot(userId, folder);
    let absDir: string;
    try {
      absDir = relPath ? resolveConfigPath(userId, folder, relPath) : root;
    } catch {
      sendJson(res, 400, { error: 'Invalid path' });
      return;
    }

    if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) {
      sendJson(res, 200, { following: false, entries: [] });
      return;
    }

    sendJson(res, 200, { following: false, entries: listDirEntries(absDir, root) });
  }));

  // ── File read ──────────────────────────────────────────────────────────────

  // GET /api/user-config/:folder/file?path=
  router.get('/api/user-config/:folder/file', requireAuth(async (req: PortalRequest, res: PortalResponse) => {
    const folder = validateFolder(req, res);
    if (!folder) return;

    // aws folder: browser session only
    if (folder === 'aws' && isTokenAuth(req)) {
      sendJson(res, 403, { error: 'The aws folder is only accessible from a browser session' });
      return;
    }

    const userId = req.user!.id;
    const relPath = req.query.get('path') ?? '';
    if (!relPath) { sendJson(res, 400, { error: 'path query parameter required' }); return; }

    const state = await getState(userId, folder);

    if (state.following) {
      const tv = await getLatestTeamVersion(folder);
      if (!tv) { sendJson(res, 404, { error: 'File not found' }); return; }
      const files = parseTeamFiles(tv);
      const entry = files.find((f) => !f.isDir && f.path === relPath.replace(/\\/g, '/'));
      if (!entry || entry.content === null) { sendJson(res, 404, { error: 'File not found' }); return; }
      const content = folder === 'aws' ? decrypt(entry.content, config.secretKey) : entry.content;
      sendJson(res, 200, { path: relPath, content, following: true });
      return;
    }

    let absPath: string;
    try {
      absPath = resolveConfigPath(userId, folder, relPath);
    } catch {
      sendJson(res, 400, { error: 'Invalid path' }); return;
    }

    if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
      sendJson(res, 404, { error: 'File not found' }); return;
    }

    const stat = fs.statSync(absPath);
    if (stat.size > MAX_FILE_BYTES * 3) { // encrypted aws files are ~1.35x larger
      sendJson(res, 400, { error: 'File too large to read via API' }); return;
    }

    let content: string;
    try {
      content = readConfigFileSync(absPath, folder);
    } catch {
      sendJson(res, 500, { error: 'Could not read file' }); return;
    }

    sendJson(res, 200, { path: relPath, content, following: false });
  }));

  // ── File write (PUT) ───────────────────────────────────────────────────────

  // PUT /api/user-config/:folder/file — write existing or new file
  router.put('/api/user-config/:folder/file', requireAuth(async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const folder = validateFolder(req, res);
    if (!folder) return;
    if (folder === 'aws' && isTokenAuth(req)) {
      sendJson(res, 403, { error: 'The aws folder is only accessible from a browser session' }); return;
    }
    if (!requireWriteScope(req, res)) return;

    const userId = req.user!.id;
    const body = req.body as Record<string, unknown>;
    const relPath = String(body.path ?? '');
    const content = String(body.content ?? '');
    const force = Boolean(body.force);

    if (!relPath) { sendJson(res, 400, { error: 'path required' }); return; }
    if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
      sendJson(res, 413, { error: `File content exceeds ${MAX_FILE_BYTES / 1024} KB limit` }); return;
    }

    const jsonError = validateJson(relPath, content);
    if (jsonError && !force) {
      sendJson(res, 400, { error: `Invalid JSON: ${jsonError}`, invalidJson: true }); return;
    }

    await ensureNotFollowing(userId, folder);

    let absPath: string;
    try {
      absPath = resolveConfigPath(userId, folder, relPath);
    } catch {
      sendJson(res, 400, { error: 'Invalid path' }); return;
    }

    try {
      writeConfigFileSync(absPath, content, folder);
    } catch (e: unknown) {
      sendJson(res, 500, { error: String((e as Error)?.message ?? e) }); return;
    }

    appendAudit(getDb(), userId, 'user-config.write', `user:${userId}:${folder}:${relPath}`, { folder, path: relPath }, req.ip);
    sendJson(res, 200, { ok: true, path: relPath });
  }));

  // ── File create (POST) ─────────────────────────────────────────────────────

  // POST /api/user-config/:folder/file — create new file
  router.post('/api/user-config/:folder/file', requireAuth(async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const folder = validateFolder(req, res);
    if (!folder) return;
    if (folder === 'aws' && isTokenAuth(req)) {
      sendJson(res, 403, { error: 'The aws folder is only accessible from a browser session' }); return;
    }
    if (!requireWriteScope(req, res)) return;

    const userId = req.user!.id;
    const body = req.body as Record<string, unknown>;
    const relPath = String(body.path ?? '');
    const content = String(body.content ?? '');
    const force = Boolean(body.force);

    if (!relPath) { sendJson(res, 400, { error: 'path required' }); return; }
    if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
      sendJson(res, 413, { error: `File content exceeds ${MAX_FILE_BYTES / 1024} KB limit` }); return;
    }

    const jsonError = validateJson(relPath, content);
    if (jsonError && !force) {
      sendJson(res, 400, { error: `Invalid JSON: ${jsonError}`, invalidJson: true }); return;
    }

    await ensureNotFollowing(userId, folder);

    let absPath: string;
    try {
      absPath = resolveConfigPath(userId, folder, relPath);
    } catch {
      sendJson(res, 400, { error: 'Invalid path' }); return;
    }

    if (fs.existsSync(absPath)) {
      sendJson(res, 409, { error: 'File already exists' }); return;
    }

    try {
      writeConfigFileSync(absPath, content, folder);
    } catch (e: unknown) {
      sendJson(res, 500, { error: String((e as Error)?.message ?? e) }); return;
    }

    appendAudit(getDb(), userId, 'user-config.create', `user:${userId}:${folder}:${relPath}`, { folder, path: relPath }, req.ip);
    sendJson(res, 201, { ok: true, path: relPath });
  }));

  // ── File delete ────────────────────────────────────────────────────────────

  // DELETE /api/user-config/:folder/file?path=
  router.delete('/api/user-config/:folder/file', requireAuth(async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const folder = validateFolder(req, res);
    if (!folder) return;
    if (folder === 'aws' && isTokenAuth(req)) {
      sendJson(res, 403, { error: 'The aws folder is only accessible from a browser session' }); return;
    }
    if (!requireWriteScope(req, res)) return;

    const userId = req.user!.id;
    const relPath = req.query.get('path') ?? '';
    if (!relPath) { sendJson(res, 400, { error: 'path query parameter required' }); return; }

    await ensureNotFollowing(userId, folder);

    let absPath: string;
    try {
      absPath = resolveConfigPath(userId, folder, relPath);
    } catch {
      sendJson(res, 400, { error: 'Invalid path' }); return;
    }

    const root = userConfigRoot(userId, folder);
    if (path.resolve(absPath) === path.resolve(root)) {
      sendJson(res, 400, { error: 'Cannot delete the root folder' }); return;
    }

    if (!fs.existsSync(absPath)) { sendJson(res, 404, { error: 'File not found' }); return; }

    if (fs.statSync(absPath).isDirectory()) {
      await fsp.rm(absPath, { recursive: true, force: true });
    } else {
      await fsp.rm(absPath, { force: true });
    }

    appendAudit(getDb(), userId, 'user-config.delete', `user:${userId}:${folder}:${relPath}`, { folder, path: relPath }, req.ip);
    sendJson(res, 200, { ok: true });
  }));

  // ── Create directory ───────────────────────────────────────────────────────

  // POST /api/user-config/:folder/folder
  router.post('/api/user-config/:folder/folder', requireAuth(async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const folder = validateFolder(req, res);
    if (!folder) return;
    if (folder === 'aws' && isTokenAuth(req)) {
      sendJson(res, 403, { error: 'The aws folder is only accessible from a browser session' }); return;
    }
    if (!requireWriteScope(req, res)) return;

    const userId = req.user!.id;
    const body = req.body as Record<string, unknown>;
    const relPath = String(body.path ?? '');
    if (!relPath) { sendJson(res, 400, { error: 'path required' }); return; }

    await ensureNotFollowing(userId, folder);

    let absPath: string;
    try {
      absPath = resolveConfigPath(userId, folder, relPath);
    } catch {
      sendJson(res, 400, { error: 'Invalid path' }); return;
    }

    await fsp.mkdir(absPath, { recursive: true });
    sendJson(res, 201, { ok: true, path: relPath });
  }));

  // ── Rename ─────────────────────────────────────────────────────────────────

  // PATCH /api/user-config/:folder/rename
  router.patch('/api/user-config/:folder/rename', requireAuth(async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const folder = validateFolder(req, res);
    if (!folder) return;
    if (folder === 'aws' && isTokenAuth(req)) {
      sendJson(res, 403, { error: 'The aws folder is only accessible from a browser session' }); return;
    }
    if (!requireWriteScope(req, res)) return;

    const userId = req.user!.id;
    const body = req.body as Record<string, unknown>;
    const from = String(body.from ?? body.path ?? '');
    const to = String(body.to ?? body.newPath ?? '');

    if (!from || !to) { sendJson(res, 400, { error: 'from and to are required' }); return; }

    await ensureNotFollowing(userId, folder);

    let srcPath: string;
    let dstPath: string;
    try {
      srcPath = resolveConfigPath(userId, folder, from);
      dstPath = resolveConfigPath(userId, folder, to);
    } catch {
      sendJson(res, 400, { error: 'Invalid path' }); return;
    }

    if (!fs.existsSync(srcPath)) { sendJson(res, 404, { error: 'Source not found' }); return; }
    if (fs.existsSync(dstPath)) { sendJson(res, 409, { error: 'Destination already exists' }); return; }

    await fsp.mkdir(path.dirname(dstPath), { recursive: true });
    await fsp.rename(srcPath, dstPath);

    appendAudit(getDb(), userId, 'user-config.rename', `user:${userId}:${folder}`, { folder, from, to }, req.ip);
    sendJson(res, 200, { ok: true, path: to });
  }));

  // ── Reset to team version ──────────────────────────────────────────────────

  // POST /api/user-config/:folder/reset
  router.post('/api/user-config/:folder/reset', requireAuth(async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const folder = validateFolder(req, res);
    if (!folder) return;
    if (folder === 'aws' && isTokenAuth(req)) {
      sendJson(res, 403, { error: 'The aws folder is only accessible from a browser session' }); return;
    }
    if (!requireWriteScope(req, res)) return;

    const userId = req.user!.id;
    const tv = await getLatestTeamVersion(folder);
    if (!tv) {
      sendJson(res, 400, { error: 'No team version has been published yet' }); return;
    }

    // Clear user's disk folder
    const root = userConfigRoot(userId, folder);
    if (fs.existsSync(root)) {
      await fsp.rm(root, { recursive: true, force: true });
    }
    await fsp.mkdir(root, { recursive: true });

    // Restore team version files to disk
    const files = parseTeamFiles(tv);
    for (const f of files) {
      const abs = path.join(root, f.path);
      if (f.isDir) {
        await fsp.mkdir(abs, { recursive: true });
      } else if (f.content !== null) {
        await fsp.mkdir(path.dirname(abs), { recursive: true });
        await fsp.writeFile(abs, f.content, 'utf8'); // already in right format (enc/plain)
      }
    }

    // Mark as following
    await getUserConfigRepository().setState(userId, folder, {
      following: 1,
      customised_at: null,
      team_version_id: tv.id,
    });

    appendAudit(getDb(), userId, 'user-config.reset', `user:${userId}:${folder}`, { folder, teamVersionId: tv.id }, req.ip);
    sendJson(res, 200, { ok: true, ...await buildStatus(userId, folder) });
  }));

  // ── Zip export ─────────────────────────────────────────────────────────────

  // GET /api/user-config/:folder/export
  router.get('/api/user-config/:folder/export', requireAuth(async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const folder = validateFolder(req, res);
    if (!folder) return;
    if (folder === 'aws' && isTokenAuth(req)) {
      sendJson(res, 403, { error: 'The aws folder is only accessible from a browser session' }); return;
    }

    const userId = req.user!.id;
    let buf: Buffer;
    try {
      buf = await buildExportZip(userId, folder);
    } catch (e: unknown) {
      sendJson(res, 500, { error: String((e as Error)?.message ?? e) }); return;
    }

    const filename = `${folder}-config.zip`;
    const res2 = res as import('node:http').ServerResponse;
    res2.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': buf.length,
      'Cache-Control': 'no-store',
    });
    res2.end(buf);
  }));

  // ── Zip import (user) ──────────────────────────────────────────────────────

  // POST /api/user-config/:folder/import
  router.post('/api/user-config/:folder/import', requireAuth(async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const folder = validateFolder(req, res);
    if (!folder) return;
    if (folder === 'aws' && isTokenAuth(req)) {
      sendJson(res, 403, { error: 'The aws folder is only accessible from a browser session' }); return;
    }
    if (!requireWriteScope(req, res)) return;

    const userId = req.user!.id;
    if (!req.rawBody || req.rawBody.length === 0) {
      sendJson(res, 400, { error: 'Upload a zip file' }); return;
    }

    let entries: Array<{ path: string; content: string }>;
    try {
      entries = await parseImportZip(req.rawBody, folder);
    } catch (e: unknown) {
      sendJson(res, 400, { error: String((e as Error)?.message ?? e) }); return;
    }

    // Clear existing folder
    const root = userConfigRoot(userId, folder);
    if (fs.existsSync(root)) {
      await fsp.rm(root, { recursive: true, force: true });
    }
    await fsp.mkdir(root, { recursive: true });

    // Write files (encrypt if aws)
    for (const e of entries) {
      const abs = path.join(root, e.path);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      writeConfigFileSync(abs, e.content, folder);
    }

    // Mark as customised
    const ts = now();
    await getUserConfigRepository().setState(userId, folder, {
      following: 0,
      customised_at: ts,
      team_version_id: null,
    });

    appendAudit(getDb(), userId, 'user-config.import', `user:${userId}:${folder}`, { folder, fileCount: entries.length }, req.ip);
    sendJson(res, 200, { ok: true, fileCount: entries.length, ...await buildStatus(userId, folder) });
  }));

  // ── Admin: publish team default ────────────────────────────────────────────

  // POST /api/admin/user-config/:folder/publish
  // Body: multipart zip upload OR raw zip body
  router.post('/api/admin/user-config/:folder/publish', requireAuth(async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!req.user?.is_admin) {
      sendJson(res, 403, { error: 'Admin access required' }); return;
    }
    const folder = validateFolder(req, res);
    if (!folder) return;

    if (!req.rawBody || req.rawBody.length === 0) {
      sendJson(res, 400, { error: 'Upload a zip file' }); return;
    }

    let entries: Array<{ path: string; content: string }>;
    try {
      entries = await parseImportZip(req.rawBody, folder);
    } catch (e: unknown) {
      sendJson(res, 400, { error: String((e as Error)?.message ?? e) }); return;
    }

    // Build team version files array
    const teamFiles: TeamFile[] = entries.map((e) => ({
      path: e.path,
      // Encrypt aws content for storage in DB
      content: folder === 'aws' ? encrypt(e.content, config.secretKey) : e.content,
      isDir: false,
    }));

    // Version ID: YYYYMMDDTHHMMSSz-<short hash>
    const ts = now();
    const datePart = ts.replace(/[-:]/g, '').replace('T', 'T').split('.')[0] + 'Z';
    const hash = createHash('sha256')
      .update(JSON.stringify(teamFiles))
      .digest('hex')
      .slice(0, 8);
    const versionId = `${datePart}-${hash}`;

    await getUserConfigRepository().publishTeamVersion({
      id: versionId,
      folder,
      published_by: req.user.id,
      published_at: ts,
      files_json: JSON.stringify(teamFiles),
    });

    appendAudit(getDb(), req.user.id, 'user-config.publish', `team:${folder}`, { folder, versionId, fileCount: entries.length }, req.ip);
    sendJson(res, 201, { ok: true, versionId, publishedAt: ts, fileCount: entries.length });
  }));

  // ── Local import (localhost-only, browser session only) ────────────────────

  // POST /api/user-config/:folder/import-local
  // Copies setup files from os.homedir()/.kiro or .claude into the portal
  // config for the signed-in user.  Only allowed when the portal is bound to
  // localhost (single-user mode); on a shared server this would expose another
  // user's home directory, so the route returns 403.
  router.post('/api/user-config/:folder/import-local', requireAuth(async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const folder = validateFolder(req, res);
    if (!folder) return;

    if (folder === 'aws') {
      sendJson(res, 400, { error: 'Local import is not available for the aws folder' }); return;
    }

    // Browser session only — API tokens must not be able to trigger home-dir reads
    if (isTokenAuth(req)) {
      sendJson(res, 403, { error: 'Local import is only available from a browser session' }); return;
    }

    // Localhost guard — on a shared server, os.homedir() is the server process
    // owner's home, not the signed-in portal user's home.
    const boundHost = config.host;
    if (boundHost !== '127.0.0.1' && boundHost !== 'localhost' && boundHost !== '::1') {
      sendJson(res, 403, {
        error:
          'Local import is only allowed when the portal is bound to localhost. ' +
          "On a shared server the portal's home directory is not the signed-in user's.",
      }); return;
    }

    const userId = req.user!.id;
    let summary: LocalImportSummary;
    try {
      summary = await importLocalConfig(userId, folder as 'kiro' | 'claude');
    } catch (e: unknown) {
      sendJson(res, 500, { error: String((e as Error)?.message ?? e) }); return;
    }

    const totalImported = Object.values(summary.imported).flat().length;
    appendAudit(
      getDb(), userId, 'user-config.import-local', `user:${userId}:${folder}`,
      { folder, fileCount: totalImported, skippedCount: summary.skipped.length, redactedCount: summary.valuesRedacted.length },
      req.ip,
    );
    sendJson(res, 200, { ok: true, ...summary });
  }));
}
