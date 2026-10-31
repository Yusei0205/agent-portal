/**
 * Test vault: named logins/secrets (write-only) and named upload files.
 *
 * Routes:
 *   GET    /api/projects/:pid/tests/:tpid/vault               — list items (name/kind/username/hasTotp/updatedAt)
 *   POST   /api/projects/:pid/tests/:tpid/vault               — create/update item (browser-only)
 *   DELETE /api/projects/:pid/tests/:tpid/vault/:itemId        — delete item (browser-only)
 *   POST   /api/projects/:pid/tests/:tpid/vault/import        — CSV import (browser-only)
 *   GET    /api/projects/:pid/tests/:tpid/vault/files         — list vault files
 *   POST   /api/projects/:pid/tests/:tpid/vault/files         — upload vault file (browser-only, multipart)
 *   DELETE /api/projects/:pid/tests/:tpid/vault/files/:fileId — delete vault file (browser-only)
 *   GET    /api/projects/:pid/tests/:tpid/vault/files/:fileId/download — download vault file
 */

import fs from 'node:fs';
import path from 'node:path';
import { router, sendJson } from '../http.ts';
import type { PortalRequest, PortalResponse } from '../http.ts';
import { all, one, run, insert } from '../db.ts';
import type { Row } from '../db.ts';
import { generateId, now, str, badRequest } from '../util.ts';
import { encrypt, decrypt } from '../secrets.ts';
import { config } from '../config.ts';
import { auditRaw } from '../audit.ts';
import {
  requireTestProject,
  requireBrowserAuth,
  hasScope,
} from './helpers.ts';
import type { TestVaultItem } from './helpers.ts';
import { VAULT_REF_RE } from './types.ts';
import { totp } from './totp.ts';

// ── Multipart parser (replicates vault.ts pattern) ────────────────────────────

interface UploadedFile {
  filename: string;
  mimeType: string;
  data: Buffer;
}

function parseMultipart(
  rawBody: Buffer,
  contentType: string,
): { file: UploadedFile | null; fields: Record<string, string> } {
  const boundaryMatch = contentType.match(/boundary=([^\s;]+)/);
  if (!boundaryMatch) throw badRequest('Missing multipart boundary');
  const boundary = '--' + boundaryMatch[1];

  const bodyStr = rawBody.toString('binary');
  const boundaryBuf = Buffer.from(boundary, 'utf8');

  const parts: Buffer[] = [];
  let start = 0;
  while (true) {
    const idx = bodyStr.indexOf(boundary, start);
    if (idx < 0) break;
    if (start > 0) {
      let end = idx;
      if (bodyStr[end - 1] === '\n') end--;
      if (bodyStr[end - 1] === '\r') end--;
      parts.push(rawBody.slice(start, end));
    }
    start = idx + boundaryBuf.length;
    if (bodyStr[start] === '\r') start++;
    if (bodyStr[start] === '\n') start++;
    if (bodyStr.slice(idx + boundaryBuf.length, idx + boundaryBuf.length + 2) === '--') break;
  }

  let file: UploadedFile | null = null;
  const fields: Record<string, string> = {};

  for (const part of parts) {
    const partStr = part.toString('binary');
    const headerEnd = partStr.indexOf('\r\n\r\n');
    if (headerEnd < 0) continue;
    const headerSection = partStr.slice(0, headerEnd);
    const partData = part.slice(headerEnd + 4);
    const nameMatch = headerSection.match(/Content-Disposition:[^\r\n]*name="([^"]+)"/i);
    const filenameMatch = headerSection.match(/Content-Disposition:[^\r\n]*filename="([^"]+)"/i);
    const ctMatch = headerSection.match(/Content-Type:\s*([^\r\n]+)/i);
    const fieldName = nameMatch?.[1] ?? '';
    if (filenameMatch) {
      file = {
        filename: filenameMatch[1].trim(),
        mimeType: ctMatch ? ctMatch[1].trim() : 'application/octet-stream',
        data: partData,
      };
    } else if (fieldName) {
      fields[fieldName] = partData.toString('utf8').trim();
    }
  }
  return { file, fields };
}

// ── CSV parser ─────────────────────────────────────────────────────────────────

interface CsvRow {
  name: string;
  kind: string;
  username: string;
  password: string;
  totp: string;
  value: string;
}

function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim());
  if (lines.length === 0) return { headers: [], rows: [] };
  const parseRow = (line: string): string[] => {
    const cells: string[] = [];
    let cur = '';
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuote) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') { inQuote = false; }
        else { cur += ch; }
      } else {
        if (ch === '"') { inQuote = true; }
        else if (ch === ',') { cells.push(cur); cur = ''; }
        else { cur += ch; }
      }
    }
    cells.push(cur);
    return cells;
  };
  return {
    headers: parseRow(lines[0]).map((h) => h.trim().toLowerCase()),
    rows: lines.slice(1).map(parseRow),
  };
}

// ── Vault item view (never exposes secrets) ────────────────────────────────────

function vaultItemView(item: TestVaultItem) {
  return {
    id: item.id,
    name: item.name,
    kind: item.kind,
    username: item.kind === 'login' ? (item.username ?? null) : undefined,
    hasTotp: item.kind === 'login' ? Boolean(item.totp_secret_enc) : undefined,
    updatedAt: item.updated_at,
  };
}

// ── Route registration ─────────────────────────────────────────────────────────

export function registerTestVaultRoutes(): void {

  // GET /api/projects/:pid/tests/:tpid/vault/files — list vault files
  // Registered BEFORE /vault/:itemId to avoid route conflict
  router.get('/api/projects/:pid/tests/:tpid/vault/files', (req: PortalRequest, res: PortalResponse): void => {
    if (!hasScope(req, 'read')) { sendJson(res, 403, { error: 'read scope required' }); return; }
    const tp = requireTestProject(req, res, req.params.pid, req.params.tpid);
    if (!tp) return;
    const files = all<Row>(
      'SELECT id, name, size_bytes, mime_type, created_at FROM test_vault_files WHERE test_project_id = ? ORDER BY name',
      tp.id,
    );
    sendJson(res, 200, { files });
  });

  // POST /api/projects/:pid/tests/:tpid/vault/files — upload vault file (browser-only, multipart)
  router.post('/api/projects/:pid/tests/:tpid/vault/files', (req: PortalRequest, res: PortalResponse): void => {
    if (!requireBrowserAuth(req, res)) return;
    const tp = requireTestProject(req, res, req.params.pid, req.params.tpid, 'editor');
    if (!tp) return;

    if (!req.rawBody?.length) { sendJson(res, 400, { error: 'No file data received' }); return; }
    const contentType = String(req.headers['content-type'] ?? '');
    let parsed: ReturnType<typeof parseMultipart>;
    try { parsed = parseMultipart(req.rawBody, contentType); }
    catch (err) { sendJson(res, 400, { error: (err as Error).message }); return; }
    if (!parsed.file) { sendJson(res, 400, { error: 'No file in upload' }); return; }

    const { filename, mimeType, data } = parsed.file;
    const name = (parsed.fields.name || path.basename(filename)).trim().slice(0, 200);
    if (!name) { sendJson(res, 400, { error: 'name is required' }); return; }

    // Check for duplicate name
    const existing = one<Row>(
      'SELECT id FROM test_vault_files WHERE test_project_id = ? AND name = ?',
      tp.id, name,
    );
    if (existing) { sendJson(res, 409, { error: `A vault file named "${name}" already exists` }); return; }

    const fileId = generateId();
    const safeName = path.basename(filename).replace(/[^\w.\-]/g, '_').slice(0, 200);
    const relDir = path.join('test-vault', tp.id, 'files');
    const absDir = path.join(config.dataDir, relDir);
    fs.mkdirSync(absDir, { recursive: true });
    const absPath = path.join(absDir, `${fileId}-${safeName}`);
    const relPath = path.relative(config.dataDir, absPath);
    fs.writeFileSync(absPath, data);

    insert('test_vault_files', {
      id: fileId,
      test_project_id: tp.id,
      name,
      path: relPath,
      size_bytes: data.length,
      mime_type: mimeType,
      uploaded_by: req.user!.id,
      created_at: now(),
    });

    sendJson(res, 201, { file: one<Row>('SELECT id, name, size_bytes, mime_type, created_at FROM test_vault_files WHERE id = ?', fileId) });
  });

  // GET /api/projects/:pid/tests/:tpid/vault/files/:fileId/download
  router.get('/api/projects/:pid/tests/:tpid/vault/files/:fileId/download', (req: PortalRequest, res: PortalResponse): void => {
    if (!hasScope(req, 'read')) { sendJson(res, 403, { error: 'read scope required' }); return; }
    const tp = requireTestProject(req, res, req.params.pid, req.params.tpid);
    if (!tp) return;
    const file = one<Row>('SELECT * FROM test_vault_files WHERE id = ? AND test_project_id = ?', req.params.fileId, tp.id);
    if (!file) { sendJson(res, 404, { error: 'File not found' }); return; }
    const absPath = path.join(config.dataDir, String(file.path));
    if (!fs.existsSync(absPath)) { sendJson(res, 404, { error: 'File not on disk' }); return; }
    const stat = fs.statSync(absPath);
    res.writeHead(200, {
      'Content-Type': String(file.mime_type || 'application/octet-stream'),
      'Content-Length': stat.size,
      'Content-Disposition': `attachment; filename="${encodeURIComponent(String(file.name))}"`,
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(absPath).pipe(res);
  });

  // DELETE /api/projects/:pid/tests/:tpid/vault/files/:fileId
  router.delete('/api/projects/:pid/tests/:tpid/vault/files/:fileId', (req: PortalRequest, res: PortalResponse): void => {
    if (!requireBrowserAuth(req, res)) return;
    const tp = requireTestProject(req, res, req.params.pid, req.params.tpid, 'editor');
    if (!tp) return;
    const file = one<Row>('SELECT * FROM test_vault_files WHERE id = ? AND test_project_id = ?', req.params.fileId, tp.id);
    if (!file) { sendJson(res, 404, { error: 'File not found' }); return; }
    const absPath = path.join(config.dataDir, String(file.path));
    try { fs.rmSync(absPath, { force: true }); } catch { /* non-fatal */ }
    run('DELETE FROM test_vault_files WHERE id = ?', String(file.id));
    sendJson(res, 200, { ok: true });
  });

  // POST /api/projects/:pid/tests/:tpid/vault/import — CSV import (browser-only)
  router.post('/api/projects/:pid/tests/:tpid/vault/import', (req: PortalRequest, res: PortalResponse): void => {
    if (!requireBrowserAuth(req, res)) return;
    const tp = requireTestProject(req, res, req.params.pid, req.params.tpid, 'editor');
    if (!tp) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const csvText = str(body.csv, 'csv', { max: 500_000 });

    const { headers, rows } = parseCsv(csvText);
    const requiredHeaders = ['name', 'kind'];
    for (const h of requiredHeaders) {
      if (!headers.includes(h)) {
        sendJson(res, 400, { error: `CSV missing required column: ${h}` });
        return;
      }
    }
    const colIdx = (name: string) => headers.indexOf(name);
    const nameIdx = colIdx('name');
    const kindIdx = colIdx('kind');
    const usernameIdx = colIdx('username');
    const passwordIdx = colIdx('password');
    const totpIdx = colIdx('totp');
    const valueIdx = colIdx('value');

    const created: string[] = [];
    const errors: { row: number; error: string }[] = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNum = i + 2; // 1-based, header is row 1
      const name = (row[nameIdx] ?? '').trim();
      const kind = (row[kindIdx] ?? '').trim().toLowerCase();

      if (!name) { errors.push({ row: rowNum, error: 'name is required' }); continue; }
      if (kind !== 'login' && kind !== 'secret') { errors.push({ row: rowNum, error: `kind must be login or secret (got "${kind}")` }); continue; }

      const existing = one<Row>('SELECT id FROM test_vault_items WHERE test_project_id = ? AND name = ?', tp.id, name);
      if (existing) { errors.push({ row: rowNum, error: `vault item "${name}" already exists` }); continue; }

      try {
        const id = generateId();
        const ts = now();
        const password = passwordIdx >= 0 ? (row[passwordIdx] ?? '').trim() : '';
        const totp = totpIdx >= 0 ? (row[totpIdx] ?? '').trim() : '';
        const value = valueIdx >= 0 ? (row[valueIdx] ?? '').trim() : '';
        const username = usernameIdx >= 0 ? (row[usernameIdx] ?? '').trim() : '';

        insert('test_vault_items', {
          id,
          test_project_id: tp.id,
          name,
          kind,
          username: kind === 'login' ? username : null,
          password_enc: kind === 'login' && password ? encrypt(password, config.secretKey) : null,
          totp_secret_enc: kind === 'login' && totp ? encrypt(totp, config.secretKey) : null,
          value_enc: kind === 'secret' && value ? encrypt(value, config.secretKey) : null,
          created_by: req.user!.id,
          created_at: ts,
          updated_at: ts,
        });
        created.push(name);
      } catch (e) {
        errors.push({ row: rowNum, error: String((e as Error).message) });
      }
    }

    auditRaw(req.user!.id, 'test_vault.import', `test_project:${tp.id}`, { created: created.length, errors: errors.length });
    sendJson(res, 200, { created: created.length, errors });
  });

  // GET /api/projects/:pid/tests/:tpid/vault — list vault items (write-only: no secrets in response)
  router.get('/api/projects/:pid/tests/:tpid/vault', (req: PortalRequest, res: PortalResponse): void => {
    if (!hasScope(req, 'read')) { sendJson(res, 403, { error: 'read scope required' }); return; }
    const tp = requireTestProject(req, res, req.params.pid, req.params.tpid);
    if (!tp) return;
    const items = all<TestVaultItem>(
      'SELECT * FROM test_vault_items WHERE test_project_id = ? ORDER BY kind, name',
      tp.id,
    );
    sendJson(res, 200, { items: items.map(vaultItemView) });
  });

  // POST /api/projects/:pid/tests/:tpid/vault — create vault item (browser-only)
  router.post('/api/projects/:pid/tests/:tpid/vault', (req: PortalRequest, res: PortalResponse): void => {
    if (!requireBrowserAuth(req, res)) return;
    const tp = requireTestProject(req, res, req.params.pid, req.params.tpid, 'editor');
    if (!tp) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = str(body.name, 'name', { max: 200 }).trim();
    const kind = str(body.kind, 'kind', { max: 20 });
    if (kind !== 'login' && kind !== 'secret') {
      sendJson(res, 400, { error: 'kind must be login or secret' });
      return;
    }

    const existing = one<Row>('SELECT id FROM test_vault_items WHERE test_project_id = ? AND name = ?', tp.id, name);
    if (existing) { sendJson(res, 409, { error: `A vault item named "${name}" already exists` }); return; }

    const id = generateId();
    const ts = now();

    if (kind === 'login') {
      const username = typeof body.username === 'string' ? body.username.trim() : '';
      const password = typeof body.password === 'string' ? body.password : '';
      const totpSecret = typeof body.totpSecret === 'string' ? body.totpSecret.trim() : '';
      insert('test_vault_items', {
        id,
        test_project_id: tp.id,
        name,
        kind: 'login',
        username: username || null,
        password_enc: password ? encrypt(password, config.secretKey) : null,
        totp_secret_enc: totpSecret ? encrypt(totpSecret, config.secretKey) : null,
        value_enc: null,
        created_by: req.user!.id,
        created_at: ts,
        updated_at: ts,
      });
    } else {
      const value = typeof body.value === 'string' ? body.value : '';
      insert('test_vault_items', {
        id,
        test_project_id: tp.id,
        name,
        kind: 'secret',
        username: null,
        password_enc: null,
        totp_secret_enc: null,
        value_enc: value ? encrypt(value, config.secretKey) : null,
        created_by: req.user!.id,
        created_at: ts,
        updated_at: ts,
      });
    }

    auditRaw(req.user!.id, 'test_vault.create', `test_project:${tp.id}`, { name, kind });
    const item = one<TestVaultItem>('SELECT * FROM test_vault_items WHERE id = ?', id)!;
    sendJson(res, 201, { item: vaultItemView(item) });
  });

  // DELETE /api/projects/:pid/tests/:tpid/vault/:itemId — delete vault item (browser-only)
  router.delete('/api/projects/:pid/tests/:tpid/vault/:itemId', (req: PortalRequest, res: PortalResponse): void => {
    if (!requireBrowserAuth(req, res)) return;
    const tp = requireTestProject(req, res, req.params.pid, req.params.tpid, 'editor');
    if (!tp) return;
    const item = one<Row>('SELECT id FROM test_vault_items WHERE id = ? AND test_project_id = ?', req.params.itemId, tp.id);
    if (!item) { sendJson(res, 404, { error: 'Vault item not found' }); return; }
    run('DELETE FROM test_vault_items WHERE id = ?', req.params.itemId);
    auditRaw(req.user!.id, 'test_vault.delete', `test_project:${tp.id}`, { itemId: req.params.itemId });
    sendJson(res, 200, { ok: true });
  });
}

// ── Exported for runner (vault ref resolution) ─────────────────────────────────

export { decrypt } from '../secrets.ts';

/**
 * Resolve vault refs of the form {{vault.<name>.field}} in a string.
 * Decrypts and inserts values at run time. Never stored.
 * Throws if a referenced vault item does not exist or the field is unavailable.
 */
export async function resolveVaultRefs(
  value: string,
  testProjectId: string,
): Promise<string> {
  const matches = [...value.matchAll(new RegExp(VAULT_REF_RE.source, 'g'))];
  if (matches.length === 0) return value;

  let result = value;
  for (const match of matches) {
    const [full, name, field] = match;
    const item = one<TestVaultItem>(
      'SELECT * FROM test_vault_items WHERE test_project_id = ? AND name = ?',
      testProjectId,
      name,
    );
    if (!item) throw new Error(`Vault item "${name}" not found`);

    let resolved: string;
    switch (field) {
      case 'username':
        resolved = String(item.username ?? '');
        break;
      case 'password': {
        if (!item.password_enc) throw new Error(`Vault item "${name}" has no password`);
        resolved = decrypt(String(item.password_enc), config.secretKey);
        break;
      }
      case 'totp': {
        if (!item.totp_secret_enc) throw new Error(`Vault item "${name}" has no TOTP secret`);
        const totpSecret = decrypt(String(item.totp_secret_enc), config.secretKey);
        resolved = totp(totpSecret);
        break;
      }
      case 'value': {
        if (!item.value_enc) throw new Error(`Vault item "${name}" has no value`);
        resolved = decrypt(String(item.value_enc), config.secretKey);
        break;
      }
      default:
        throw new Error(`Unknown vault field "${field}"`);
    }
    result = result.replace(full, resolved);
  }
  return result;
}
