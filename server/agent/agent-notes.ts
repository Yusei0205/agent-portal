/**
 * Cross-run agent notes: load .agent-notes/*.md files from the previous run of this workflow
 * and return them as InputFile records under docs/md/.agent-notes-previous/.
 *
 * Level 2 of the Agent Coordination Notes feature.
 * Level 1 (in-run notes) needs no code — agents write to .agent-notes/ and the skill instructs them.
 */
import path from 'node:path';
import fs from 'node:fs';
import { getOutputFilesRepository } from '../repositories/output-files.ts';
import { getVaultFilesRepository } from '../repositories/vault-files.ts';
import { restoreFile } from '../durable-files.ts';
import { config } from '../config.ts';
import type { InputFile } from './runner-files.ts';

/** Max total bytes of notes to carry forward (keep payloads small). */
const MAX_NOTES_BYTES = 200_000;
/** Max number of note files to carry forward. */
const MAX_NOTES_FILES = 20;
/** Prefix for notes in the work dir. */
const NOTES_PREFIX = '.agent-notes/';
/** Where notes are staged for the new run (under docs/md/ so writeInputFiles accepts them). */
const STAGED_DIR = 'docs/md/.agent-notes-previous';

/**
 * Returns InputFile entries for .agent-notes/*.md from the workflow's last run.
 * Always returns an array (empty if none found, vault not set up, or any error occurs).
 */
export async function loadPreviousRunNotes(
  workflowId: string,
  currentWorkDir?: string | null,
): Promise<InputFile[]> {
  const result: InputFile[] = [];
  let totalBytes = 0;

  let records;
  try {
    records = await getOutputFilesRepository().listLatestByWorkflow(workflowId);
  } catch (e) {
    console.warn('[agent-notes] Could not list output files:', e instanceof Error ? e.message : e);
    return result;
  }

  const noteRecords = records.filter(
    (f) => f.path.startsWith(NOTES_PREFIX) && f.refused_reason === null,
  );

  for (const file of noteRecords) {
    if (result.length >= MAX_NOTES_FILES) break;

    let content: Buffer | null = null;

    // Try reading from currentWorkDir first (same run or local dev)
    if (currentWorkDir) {
      const localPath = path.join(currentWorkDir, file.path);
      try {
        if (fs.existsSync(localPath)) {
          content = fs.readFileSync(localPath);
        }
      } catch (e) {
        console.warn('[agent-notes] Could not read local note', file.path, ':', e instanceof Error ? e.message : e);
      }
    }

    // Fall back to vault
    if (content === null && file.vault_file_id) {
      try {
        const vf = await getVaultFilesRepository().getById(file.vault_file_id);
        if (vf) {
          const absPath = path.join(config.dataDir, vf.path);
          const restored = await restoreFile(absPath);
          if (restored) {
            content = fs.readFileSync(absPath);
          }
        }
      } catch (e) {
        console.warn('[agent-notes] Could not restore vault note', file.path, ':', e instanceof Error ? e.message : e);
      }
    }

    if (content === null) continue;
    if (totalBytes + content.length > MAX_NOTES_BYTES) {
      console.warn('[agent-notes] Skipping note', file.path, '— would exceed MAX_NOTES_BYTES');
      continue;
    }

    totalBytes += content.length;
    result.push({
      path: `${STAGED_DIR}/${path.basename(file.path)}`,
      data: content.toString('base64'),
    });
  }

  return result;
}
