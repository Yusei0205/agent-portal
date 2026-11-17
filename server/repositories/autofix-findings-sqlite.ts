/**
 * SQLite implementation of AutofixFindingsRepository. All SQL for autofix_findings lives here.
 */

import { one, all, run as dbRun } from '../db.ts';
import type { Row } from '../db.ts';
import { generateId, now } from '../util.ts';
import { FINDING_STATUSES, PATCHABLE_FIELDS } from './autofix-findings.ts';
import type { AutofixFinding, AutofixFindingsRepository, FindingPatch, FindingStatus, UpsertFindingInput } from './autofix-findings.ts';

const str = (v: unknown): string | null => (v != null ? String(v) : null);

function toFinding(row: Row): AutofixFinding {
  return {
    id: String(row.id),
    project_id: String(row.project_id),
    source: String(row.source) as AutofixFinding['source'],
    kind: String(row.kind ?? ''),
    fingerprint: String(row.fingerprint),
    severity: String(row.severity) as AutofixFinding['severity'],
    evidence: String(row.evidence ?? ''),
    status: String(row.status) as FindingStatus,
    repo_id: str(row.repo_id),
    branch: str(row.branch),
    commit_sha: str(row.commit_sha),
    workflow_id: str(row.workflow_id),
    fix_branch: str(row.fix_branch),
    pr_number: row.pr_number != null ? Number(row.pr_number) : null,
    pr_url: str(row.pr_url),
    attempts: Number(row.attempts ?? 0),
    occurrences: Number(row.occurrences ?? 1),
    cost_usd: Number(row.cost_usd ?? 0),
    cooldown_until: str(row.cooldown_until),
    created_at: String(row.created_at ?? ''),
    updated_at: String(row.updated_at ?? ''),
  };
}

export class SqliteAutofixFindingsRepository implements AutofixFindingsRepository {
  async upsertByFingerprint(i: UpsertFindingInput): Promise<{ finding: AutofixFinding; created: boolean }> {
    const ts = now();
    const res = dbRun(
      `INSERT INTO autofix_findings (id, project_id, source, kind, fingerprint, severity, evidence, status, repo_id, branch,
         commit_sha, attempts, occurrences, cost_usd, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?, 0, 1, 0, ?, ?)
       ON CONFLICT(project_id, fingerprint) DO NOTHING`,
      generateId(), i.project_id, i.source, i.kind, i.fingerprint, i.severity, i.evidence, i.repo_id, i.branch, i.commit_sha, ts, ts,
    ) as { changes: number };
    const created = res.changes > 0;
    if (!created) {
      dbRun('UPDATE autofix_findings SET occurrences = occurrences + 1, updated_at = ? WHERE project_id = ? AND fingerprint = ?', ts, i.project_id, i.fingerprint);
    }
    const row = one<Row>('SELECT * FROM autofix_findings WHERE project_id = ? AND fingerprint = ?', i.project_id, i.fingerprint)!;
    return { finding: toFinding(row), created };
  }

  async getById(id: string): Promise<AutofixFinding | null> {
    const row = one<Row>('SELECT * FROM autofix_findings WHERE id = ?', id);
    return row ? toFinding(row) : null;
  }

  async getByFingerprint(projectId: string, fp: string): Promise<AutofixFinding | null> {
    const row = one<Row>('SELECT * FROM autofix_findings WHERE project_id = ? AND fingerprint = ?', projectId, fp);
    return row ? toFinding(row) : null;
  }

  async getByFixBranch(projectId: string, branch: string): Promise<AutofixFinding | null> {
    const row = one<Row>('SELECT * FROM autofix_findings WHERE project_id = ? AND fix_branch = ? ORDER BY created_at DESC LIMIT 1', projectId, branch);
    return row ? toFinding(row) : null;
  }

  async getByWorkflowId(workflowId: string): Promise<AutofixFinding | null> {
    const row = one<Row>('SELECT * FROM autofix_findings WHERE workflow_id = ? ORDER BY created_at DESC LIMIT 1', workflowId);
    return row ? toFinding(row) : null;
  }

  async list(projectId: string, o: { status?: FindingStatus; limit: number }): Promise<AutofixFinding[]> {
    const rows = o.status
      ? all<Row>('SELECT * FROM autofix_findings WHERE project_id = ? AND status = ? ORDER BY created_at DESC, rowid DESC LIMIT ?', projectId, o.status, o.limit)
      : all<Row>('SELECT * FROM autofix_findings WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?', projectId, o.limit);
    return rows.map(toFinding);
  }

  async transition(id: string, from: FindingStatus[], patch: FindingPatch): Promise<boolean> {
    if (from.length === 0) return false;
    const values: Record<string, string | number | null> = { ...(patch as Record<string, string | number | null>) };
    if (values.updated_at === undefined) values.updated_at = now();
    const keys = PATCHABLE_FIELDS.filter((k) => values[k] !== undefined);
    const res = dbRun(
      `UPDATE autofix_findings SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ? AND status IN (${from.map(() => '?').join(', ')})`,
      ...keys.map((k) => values[k] as string | number | null), id, ...from,
    ) as { changes: number };
    return res.changes > 0;
  }

  async countByStatus(projectId: string): Promise<Record<FindingStatus, number>> {
    const out = Object.fromEntries(FINDING_STATUSES.map((s) => [s, 0])) as Record<FindingStatus, number>;
    const rows = all<Row>('SELECT status, COUNT(*) AS n FROM autofix_findings WHERE project_id = ? GROUP BY status', projectId);
    for (const r of rows) out[String(r.status) as FindingStatus] = Number(r.n);
    return out;
  }

  async sumCostSince(projectId: string, sinceIso: string): Promise<number> {
    const row = one<{ total: number | null }>('SELECT SUM(cost_usd) AS total FROM autofix_findings WHERE project_id = ? AND updated_at >= ?', projectId, sinceIso);
    return Number(row?.total ?? 0);
  }
}
