/**
 * Unit tests for server/agent/agent-notes.ts
 *
 * Run with:
 *   node --test test/agent-notes.test.ts
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPreviousRunNotes } from '../server/agent/agent-notes.ts';
import {
  setOutputFilesRepository,
  clearOutputFilesRepository,
} from '../server/repositories/output-files.ts';
import {
  setVaultFilesRepository,
  clearVaultFilesRepository,
} from '../server/repositories/vault-files.ts';
import type { OutputFilesRepository, OutputFileRecord } from '../server/repositories/output-files.ts';
import type { VaultFilesRepository } from '../server/repositories/vault-files.ts';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRecord(overrides: Partial<OutputFileRecord> = {}): OutputFileRecord {
  return {
    id: 'rec-1',
    workflow_id: 'wf-1',
    run_id: 'run-1',
    name: 'security-reviewer.md',
    path: '.agent-notes/security-reviewer.md',
    size_bytes: 100,
    mime_type: 'text/markdown',
    version: 1,
    refused_reason: null,
    hash: null,
    vault_file_id: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeOutputRepo(records: OutputFileRecord[]): OutputFilesRepository {
  return {
    async create() { throw new Error('not implemented'); },
    async getById() { return null; },
    async getLatestByPath() { return null; },
    async listLatestByWorkflow() { return records; },
    async updateVaultFileId() {},
    async countByWorkflow() { return records.length; },
  };
}

function makeVaultRepo(): VaultFilesRepository {
  return {
    async create() { throw new Error('not implemented'); },
    async getById() { return null; },
    async getByIdForProject() { return null; },
    async listByProject() { return []; },
    async listByScope() { return []; },
    async listPortal() { return []; },
    async delete() {},
    async updateSizeAndMime() {},
    async updateFolder() {},
    async bulkDelete() {},
    async bulkUpdateFolder() {},
    async findByWorkflowFolderName() { return null; },
    async validateProjectFiles() { return null; },
    async getByIds() { return []; },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('loadPreviousRunNotes', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-notes-test-'));
    setVaultFilesRepository(makeVaultRepo());
  });

  afterEach(() => {
    clearOutputFilesRepository();
    clearVaultFilesRepository();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty array when no output files exist', async () => {
    setOutputFilesRepository(makeOutputRepo([]));
    const result = await loadPreviousRunNotes('wf-1');
    assert.deepEqual(result, []);
  });

  it('returns empty array when output files exist but none match .agent-notes/ prefix', async () => {
    setOutputFilesRepository(makeOutputRepo([
      makeRecord({ path: 'report.md', name: 'report.md' }),
      makeRecord({ path: 'docs/diagram.md', name: 'diagram.md' }),
    ]));
    const result = await loadPreviousRunNotes('wf-1');
    assert.deepEqual(result, []);
  });

  it('returns InputFile entries for matching files when workDir has the files', async () => {
    const notesContent = '# Agent Notes: security-reviewer\nRun: 2026-11-06\n\n## Findings\nNo issues.';
    const notesDir = path.join(tmpDir, '.agent-notes');
    fs.mkdirSync(notesDir, { recursive: true });
    fs.writeFileSync(path.join(notesDir, 'security-reviewer.md'), notesContent);

    setOutputFilesRepository(makeOutputRepo([makeRecord()]));
    const result = await loadPreviousRunNotes('wf-1', tmpDir);

    assert.equal(result.length, 1);
    assert.equal(result[0].path, 'docs/md/.agent-notes-previous/security-reviewer.md');
    assert.equal(Buffer.from(result[0].data, 'base64').toString(), notesContent);
  });

  it('skips files with a refused_reason', async () => {
    const notesContent = 'refused content';
    const notesDir = path.join(tmpDir, '.agent-notes');
    fs.mkdirSync(notesDir, { recursive: true });
    fs.writeFileSync(path.join(notesDir, 'security-reviewer.md'), notesContent);

    setOutputFilesRepository(makeOutputRepo([
      makeRecord({ refused_reason: 'contains secrets' }),
    ]));
    const result = await loadPreviousRunNotes('wf-1', tmpDir);
    assert.deepEqual(result, []);
  });

  it('returns empty array when vault_file_id is null and workDir does not have the file', async () => {
    setOutputFilesRepository(makeOutputRepo([makeRecord({ vault_file_id: null })]));
    // No file written to tmpDir — local read will find nothing, no vault_file_id to fall back to
    const result = await loadPreviousRunNotes('wf-1', tmpDir);
    assert.deepEqual(result, []);
  });

  it('skips files that would exceed MAX_NOTES_BYTES', async () => {
    // Write two large notes, the second of which would push us over the 200 KB limit
    const bigContent = 'x'.repeat(150_000);
    const notesDir = path.join(tmpDir, '.agent-notes');
    fs.mkdirSync(notesDir, { recursive: true });
    fs.writeFileSync(path.join(notesDir, 'agent-a.md'), bigContent);
    fs.writeFileSync(path.join(notesDir, 'agent-b.md'), bigContent);

    setOutputFilesRepository(makeOutputRepo([
      makeRecord({ id: 'rec-a', path: '.agent-notes/agent-a.md', name: 'agent-a.md' }),
      makeRecord({ id: 'rec-b', path: '.agent-notes/agent-b.md', name: 'agent-b.md' }),
    ]));
    const result = await loadPreviousRunNotes('wf-1', tmpDir);
    // First file fits (150 KB < 200 KB), second would push to 300 KB — skipped
    assert.equal(result.length, 1);
    assert.equal(result[0].path, 'docs/md/.agent-notes-previous/agent-a.md');
  });
});
