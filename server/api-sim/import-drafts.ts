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
}

export interface ImportedApi { id: string; name: string; version: number; isNew: boolean }

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

export async function importDrafts(projectId: string, userId: string, drafts: DraftInput[]): Promise<ImportedApi[]> {
  const repo = getSimulationRepository();
  const existing = await repo.listApis(projectId);

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
      if (prev) keepOperationIds(prev.spec, d.spec);
      await repo.addVersion({ api_id: found.id, version, status: 'draft', spec: d.spec, created_by: userId, created_at: at });
      await repo.updateApi(projectId, found.id, { latest_version: version });
      out.push({ id: found.id, name: found.name, version, isNew: false });
    } else {
      const id = generateId();
      await repo.createApi({
        id, project_id: projectId, name: d.name, source_key: d.key, mode: 'mock', live_base_url: d.liveBaseUrl ?? '',
        require_explicit_rule: false, operation_modes: {}, approved_version: 0, latest_version: 1,
        created_by: userId, created_at: at, updated_at: at,
      });
      await repo.addVersion({ api_id: id, version: 1, status: 'draft', spec: d.spec, created_by: userId, created_at: at });
      out.push({ id, name: d.name, version: 1, isNew: true });
    }
  }
  return out;
}
