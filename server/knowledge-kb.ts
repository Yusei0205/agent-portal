/**
 * Knowledge: an Amazon Bedrock Knowledge Base (classic, with S3 Vectors as its store) as a search backend.
 *
 * The portal copies each ready document's Markdown to kb/<project slug>/<docId>.md in its storage bucket; the
 * Knowledge Base's data source reads that folder. "Sync" copies any missing files and starts an ingestion job;
 * a search calls Retrieve and keeps the hits that belong to the project.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';
import { persistFile, forgetFile } from './durable-files.ts';
import { getStorage } from './storage-instance.ts';

export interface KbRef {
  knowledgeBaseId: string;
  dataSourceId: string;
  region: string;
}

/** The Knowledge Base this deployment was created with (infra context knowledgeBase=true), if any. */
export function kbFromEnv(): KbRef | null {
  const knowledgeBaseId = process.env.PORTAL_KB_ID;
  const dataSourceId = process.env.PORTAL_KB_DATA_SOURCE_ID;
  if (!knowledgeBaseId || !dataSourceId) return null;
  return { knowledgeBaseId, dataSourceId, region: process.env.PORTAL_KB_REGION || process.env.AWS_REGION || 'ap-southeast-1' };
}

export function kbCopyPath(slug: string, docId: string): string {
  return path.join(config.dataDir, 'kb', slug, `${docId}.md`);
}

/** Put a document's Markdown where the data source reads it. */
export async function writeKbCopy(slug: string, docId: string, markdown: string): Promise<void> {
  const abs = kbCopyPath(slug, docId);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, markdown, 'utf8');
  await persistFile(abs, 'text/markdown');
}

export async function removeKbCopy(slug: string, docId: string): Promise<void> {
  const abs = kbCopyPath(slug, docId);
  try { fs.rmSync(abs, { force: true }); } catch { /* none */ }
  await forgetFile(abs).catch(() => {});
}

/** Logical keys already copied for a project (to see which documents are missing). */
export async function listKbCopies(slug: string): Promise<Set<string>> {
  const keys = await getStorage().list(`kb/${slug}/`).catch(() => [] as string[]);
  return new Set(keys.map((k) => k.split('/').pop()!.replace(/\.md$/, '')));
}

// ── Bedrock calls ─────────────────────────────────────────────────────────────

export interface KbHit { docId: string; text: string; score: number }

export async function kbRetrieve(kb: KbRef, slug: string, question: string, limit: number): Promise<KbHit[]> {
  const { BedrockAgentRuntimeClient, RetrieveCommand } = await import('@aws-sdk/client-bedrock-agent-runtime');
  const client = new BedrockAgentRuntimeClient({ region: kb.region });
  const res = await client.send(new RetrieveCommand({
    knowledgeBaseId: kb.knowledgeBaseId,
    retrievalQuery: { text: question.slice(0, 1000) },
    // More than needed: hits of other projects in the same Knowledge Base are dropped below.
    retrievalConfiguration: { vectorSearchConfiguration: { numberOfResults: Math.min(100, Math.max(limit * 4, 20)) } },
  }));
  const out: KbHit[] = [];
  for (const r of res.retrievalResults ?? []) {
    const uri = r.location?.s3Location?.uri ?? '';
    const m = /\/kb\/([^/]+)\/([^/]+)\.md$/.exec(uri);
    if (!m || m[1] !== slug) continue;
    const text = r.content?.text?.trim();
    if (text) out.push({ docId: m[2], text, score: r.score ?? 0 });
  }
  return out.slice(0, limit);
}

export interface KbSyncState {
  status: string;
  startedAt: string | null;
  updatedAt: string | null;
  documents: { scanned: number; indexed: number; failed: number } | null;
  failure: string | null;
}

export async function kbStartSync(kb: KbRef): Promise<string> {
  const { BedrockAgentClient, StartIngestionJobCommand } = await import('@aws-sdk/client-bedrock-agent');
  const client = new BedrockAgentClient({ region: kb.region });
  const res = await client.send(new StartIngestionJobCommand({ knowledgeBaseId: kb.knowledgeBaseId, dataSourceId: kb.dataSourceId }));
  return res.ingestionJob?.ingestionJobId ?? '';
}

/** The latest ingestion job of the data source, or null when none has run. */
export async function kbSyncState(kb: KbRef): Promise<KbSyncState | null> {
  const { BedrockAgentClient, ListIngestionJobsCommand } = await import('@aws-sdk/client-bedrock-agent');
  const client = new BedrockAgentClient({ region: kb.region });
  const res = await client.send(new ListIngestionJobsCommand({
    knowledgeBaseId: kb.knowledgeBaseId,
    dataSourceId: kb.dataSourceId,
    maxResults: 1,
    sortBy: { attribute: 'STARTED_AT', order: 'DESCENDING' },
  }));
  const j = res.ingestionJobSummaries?.[0];
  if (!j) return null;
  return {
    status: String(j.status ?? ''),
    startedAt: j.startedAt ? j.startedAt.toISOString() : null,
    updatedAt: j.updatedAt ? j.updatedAt.toISOString() : null,
    documents: j.statistics
      ? { scanned: j.statistics.numberOfDocumentsScanned ?? 0, indexed: j.statistics.numberOfNewDocumentsIndexed ?? 0, failed: j.statistics.numberOfDocumentsFailed ?? 0 }
      : null,
    failure: null,
  };
}
