/**
 * Saving imported specifications as drafts: a new API, or the next version of one that is already there.
 *
 * An API is the same one when it was read from the same place before (`key`, such as a sheet name) or, failing that,
 * when its first operation has the same method and path as the latest version of an existing API. The second rule is
 * what lets an updated Word or Excel document, whose headings may have been renamed, update the right API.
 */

import { generateId, now } from '../util.ts';
import { getSimulationRepository } from '../repositories/simulation.ts';
import type { SimApiRecord } from '../repositories/simulation.ts';
import type { ApiSpec } from './types.ts';

export interface DraftInput {
  key: string;
  name: string;
  spec: ApiSpec;
  /** The client's real address, when the document gives one. Used only when the API is new. */
  liveBaseUrl?: string;
  /** Environments read from the file (encrypted, see environments.ts); the live address above should be the active one's. */
  environmentsEnc?: string | null;
}

export interface ImportedApi { id: string; name: string; version: number; isNew: boolean; group: string }

export interface ImportOptions {
  /** The group the APIs belong to (the client or document). Matching an earlier import only looks inside the group. */
  group?: string;
  /** What to call the version being added, for example the document version "v1.9". */
  label?: string;
}

/** A group name as stored: trimmed, one line, at most 120 characters. */
export function cleanGroup(raw: unknown): string {
  return typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
}

export const sameGroup = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();


/** "POST /flash/update" for the first operation of a spec. */
export function signatureOf(spec: ApiSpec): string {
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(item)) if (op) return `${method.toUpperCase()} ${path}`;
  }
  return '';
}

/**
 * A new version keeps the operation ids of the version before it, matched by method and path. The ids are made from the
 * name the document gives the API, which can change between documents; mock rules and the version diff follow the id.
 */
export function keepOperationIds(before: ApiSpec, after: ApiSpec): void {
  const old = new Map<string, string>();
  for (const [path, item] of Object.entries(before.paths)) for (const [m, op] of Object.entries(item)) if (op) old.set(`${m} ${path}`, op.operationId);
  const taken = new Set<string>();
  for (const [path, item] of Object.entries(after.paths)) {
    for (const [m, op] of Object.entries(item)) {
      const prev = old.get(`${m} ${path}`);
      if (op && prev && !taken.has(prev)) { op.operationId = prev; taken.add(prev); }
    }
  }
}

/**
 * A URL path someone typed in is not lost when the document is read again. If the new draft has no path for an
 * operation (the document never gave one) and the version before it did, the new draft takes that path and the
 * "path needed" flag is cleared. Operations are matched by operation id.
 */
export function carryOverPaths(before: ApiSpec, after: ApiSpec): void {
  const old = new Map<string, { path: string; method: string }>();
  for (const [path, item] of Object.entries(before.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (op && !(op['x-flags'] ?? []).some((f) => f.code === 'MISSING_PATH')) old.set(op.operationId, { path, method });
    }
  }
  for (const [path, item] of Object.entries({ ...after.paths })) {
    for (const [method, op] of Object.entries(item)) {
      if (!op || !(op['x-flags'] ?? []).some((f) => f.code === 'MISSING_PATH')) continue;
      const prev = old.get(op.operationId);
      if (!prev || prev.method !== method || after.paths[prev.path]?.[method as 'get']) continue;
      delete after.paths[path][method as 'get'];
      if (Object.keys(after.paths[path]).length === 0) delete after.paths[path];
      (after.paths[prev.path] ??= {})[method as 'get'] = op;
      op['x-flags'] = (op['x-flags'] ?? []).filter((f) => f.code !== 'MISSING_PATH');
      if (op['x-flags'].length === 0) delete op['x-flags'];
    }
  }
}

export async function importDrafts(projectId: string, userId: string, drafts: DraftInput[], opts: ImportOptions = {}): Promise<ImportedApi[]> {
  const repo = getSimulationRepository();
  const group = cleanGroup(opts.group);
  const label = (opts.label ?? '').trim().slice(0, 60);
  // An earlier import is only the same API when it is in the same group.
  const existing = (await repo.listApis(projectId)).filter((e) => sameGroup(e.group_name, group));

  // Signatures of what is stored now, read once and only if some draft has no match by key.
  let signatures: Map<string, SimApiRecord> | null = null;
  const bySignature = async (sig: string): Promise<SimApiRecord | undefined> => {
    if (!sig) return undefined;
    if (!signatures) {
      signatures = new Map();
      for (const e of existing) {
        const v = await repo.getVersion(e.id, e.latest_version);
        const s = v ? signatureOf(v.spec) : '';
        if (s && !signatures.has(s)) signatures.set(s, e);
      }
    }
    return signatures.get(sig);
  };

  const out: ImportedApi[] = [];
  const used = new Set<string>();
  for (const d of drafts) {
    const found = existing.find((e) => e.source_key === d.key && !used.has(e.id)) ?? await bySignature(signatureOf(d.spec));
    const at = now();
    if (found && !used.has(found.id)) {
      used.add(found.id);
      const version = found.latest_version + 1;
      const prev = await repo.getVersion(found.id, found.latest_version);
      if (prev) { keepOperationIds(prev.spec, d.spec); carryOverPaths(prev.spec, d.spec); }
      await repo.addVersion({ api_id: found.id, version, status: 'draft', label, spec: d.spec, created_by: userId, created_at: at });
      await repo.updateApi(projectId, found.id, { latest_version: version });
      out.push({ id: found.id, name: found.name, version, isNew: false, group: found.group_name });
    } else {
      const id = generateId();
      await repo.createApi({
        id, project_id: projectId, name: d.name, group_name: group, source_key: d.key, mode: 'mock', live_base_url: d.liveBaseUrl ?? '',
        require_explicit_rule: false, log_bodies: false, live_headers_enc: null, environments_enc: d.environmentsEnc ?? null, operation_modes: {}, approved_version: 0, latest_version: 1,
        created_by: userId, created_at: at, updated_at: at,
      });
      await repo.addVersion({ api_id: id, version: 1, status: 'draft', label, spec: d.spec, created_by: userId, created_at: at });
      out.push({ id, name: d.name, version: 1, isNew: true, group });
    }
  }
  return out;
}
