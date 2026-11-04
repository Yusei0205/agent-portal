/**
 * Knowledge: one shared Amazon Bedrock Knowledge Base (S3 Vectors as its store) as a search backend.
 *
 * One Knowledge Base serves every project. The deploy creates only what is idle and free: the S3 Vectors index and
 * the service role. The Knowledge Base and its data source are created from the portal (Knowledge > Search setup)
 * by an admin, once. Documents of different projects are kept apart by a label: each document's Markdown is copied
 * to kb/<project slug>/<docId>.md with a <docId>.md.metadata.json beside it that says which project it belongs to,
 * and a search asks Bedrock for that project's label only (the filter is applied before ranking, so other projects
 * never take a project's places).
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';
import { getDb } from './db.ts';
import { getSetting, setSetting } from './settings.ts';
import { persistFile, forgetFile } from './durable-files.ts';
import { getStorage } from './storage-instance.ts';

export interface KbRef {
  knowledgeBaseId: string;
  dataSourceId: string;
  region: string;
}

const SHARED_KEY = 'knowledge.kb';

const regionOf = (): string => process.env.AWS_REGION || 'ap-southeast-1';

/** The shared Knowledge Base the portal created (or, on older deployments, the one the stack created). */
export function sharedKb(): KbRef | null {
  try {
    const raw = getSetting(getDb(), SHARED_KEY);
    if (raw) {
      const v = JSON.parse(raw) as Partial<KbRef>;
      if (v.knowledgeBaseId && v.dataSourceId) return { knowledgeBaseId: v.knowledgeBaseId, dataSourceId: v.dataSourceId, region: v.region || regionOf() };
    }
  } catch { /* none saved */ }
  const knowledgeBaseId = process.env.PORTAL_KB_ID;
  const dataSourceId = process.env.PORTAL_KB_DATA_SOURCE_ID;
  if (knowledgeBaseId && dataSourceId) return { knowledgeBaseId, dataSourceId, region: process.env.PORTAL_KB_REGION || regionOf() };
  return null;
}

/** True when this deployment has what a Knowledge Base needs (index, role, model, bucket) so the portal can create one. */
export function kbCreatable(): boolean {
  return Boolean(process.env.PORTAL_KB_ROLE_ARN && process.env.PORTAL_KB_INDEX_ARN && process.env.PORTAL_KB_EMBED_MODEL_ARN && process.env.PORTAL_KB_BUCKET_ARN);
}

// ── Creating and removing the shared Knowledge Base ───────────────────────────

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Create the shared Knowledge Base and its data source, and remember them. Throws a message fit for the person. */
export async function createSharedKb(): Promise<KbRef> {
  if (sharedKb()) throw new Error('A Knowledge Base already exists.');
  if (!kbCreatable()) throw new Error('This deployment has no Knowledge Base prerequisites (vector index and role). Deploy the latest stack first.');
  const { BedrockAgentClient, CreateKnowledgeBaseCommand, GetKnowledgeBaseCommand, CreateDataSourceCommand, DeleteKnowledgeBaseCommand } = await import('@aws-sdk/client-bedrock-agent');
  const region = regionOf();
  const client = new BedrockAgentClient({ region });

  const created = await client.send(new CreateKnowledgeBaseCommand({
    name: 'agent-portal-knowledge',
    description: 'Project documents of the Agent Portal, kept apart by project.',
    roleArn: process.env.PORTAL_KB_ROLE_ARN!,
    knowledgeBaseConfiguration: { type: 'VECTOR', vectorKnowledgeBaseConfiguration: { embeddingModelArn: process.env.PORTAL_KB_EMBED_MODEL_ARN! } },
    storageConfiguration: { type: 'S3_VECTORS', s3VectorsConfiguration: { indexArn: process.env.PORTAL_KB_INDEX_ARN! } },
  }));
  const knowledgeBaseId = created.knowledgeBase?.knowledgeBaseId;
  if (!knowledgeBaseId) throw new Error('Bedrock did not return a Knowledge Base id.');

  try {
    // The data source can only be added once the Knowledge Base is active (usually within half a minute).
    for (let i = 0; i < 25; i++) {
      const s = (await client.send(new GetKnowledgeBaseCommand({ knowledgeBaseId }))).knowledgeBase?.status;
      if (s === 'ACTIVE') break;
      if (s === 'FAILED') throw new Error('The Knowledge Base could not be created (Bedrock reported FAILED).');
      await sleep(3000);
    }
    const ds = await client.send(new CreateDataSourceCommand({
      knowledgeBaseId,
      name: 'project-documents',
      dataSourceConfiguration: { type: 'S3', s3Configuration: { bucketArn: process.env.PORTAL_KB_BUCKET_ARN!, inclusionPrefixes: ['data/kb/'] } },
      vectorIngestionConfiguration: { chunkingConfiguration: { chunkingStrategy: 'FIXED_SIZE', fixedSizeChunkingConfiguration: { maxTokens: 300, overlapPercentage: 20 } } },
    }));
    const dataSourceId = ds.dataSource?.dataSourceId;
    if (!dataSourceId) throw new Error('Bedrock did not return a data source id.');
    const ref: KbRef = { knowledgeBaseId, dataSourceId, region };
    await setSetting(getDb(), SHARED_KEY, JSON.stringify(ref));
    return ref;
  } catch (e) {
    // Do not leave a half-made Knowledge Base behind.
    await client.send(new DeleteKnowledgeBaseCommand({ knowledgeBaseId })).catch(() => {});
    throw e;
  }
}

/** Remove the shared Knowledge Base and its data source (the documents themselves are not touched). */
export async function deleteSharedKb(): Promise<void> {
  const kb = sharedKb();
  if (!kb) return;
  const { BedrockAgentClient, DeleteDataSourceCommand, DeleteKnowledgeBaseCommand } = await import('@aws-sdk/client-bedrock-agent');
  const client = new BedrockAgentClient({ region: kb.region });
  await client.send(new DeleteDataSourceCommand({ knowledgeBaseId: kb.knowledgeBaseId, dataSourceId: kb.dataSourceId })).catch(() => {});
  await client.send(new DeleteKnowledgeBaseCommand({ knowledgeBaseId: kb.knowledgeBaseId }));
  await setSetting(getDb(), SHARED_KEY, JSON.stringify(''));
}

// ── The document copies a data source reads ───────────────────────────────────

export function kbCopyPath(slug: string, docId: string): string {
  return path.join(config.dataDir, 'kb', slug, `${docId}.md`);
}

/** The label file beside a copy: which project the document belongs to (used by the retrieval filter). */
export function kbMetadata(projectId: string): string {
  return JSON.stringify({ metadataAttributes: { projectId } });
}

/** The retrieval filter that keeps one project's documents. */
export function projectFilter(projectId: string): { equals: { key: string; value: string } } {
  return { equals: { key: 'projectId', value: projectId } };
}

/** Put a document's Markdown, and its project label, where the data source reads them. */
export async function writeKbCopy(project: { id: string; slug: string }, docId: string, markdown: string): Promise<void> {
  const abs = kbCopyPath(project.slug, docId);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, markdown, 'utf8');
  fs.writeFileSync(`${abs}.metadata.json`, kbMetadata(project.id), 'utf8');
  await persistFile(abs, 'text/markdown');
  await persistFile(`${abs}.metadata.json`, 'application/json');
}

export async function removeKbCopy(slug: string, docId: string): Promise<void> {
  const abs = kbCopyPath(slug, docId);
  for (const f of [abs, `${abs}.metadata.json`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* none */ }
    await forgetFile(f).catch(() => {});
  }
}

/** Document ids already copied for a project, and which of them have their label file. */
export async function listKbCopies(slug: string): Promise<{ copied: Set<string>; labelled: Set<string> }> {
  const keys = await getStorage().list(`kb/${slug}/`).catch(() => [] as string[]);
  const copied = new Set<string>();
  const labelled = new Set<string>();
  for (const k of keys) {
    const name = k.split('/').pop()!;
    if (name.endsWith('.md.metadata.json')) labelled.add(name.replace(/\.md\.metadata\.json$/, ''));
    else if (name.endsWith('.md')) copied.add(name.replace(/\.md$/, ''));
  }
  return { copied, labelled };
}

// ── Bedrock calls ─────────────────────────────────────────────────────────────

export interface KbHit { docId: string; text: string; score: number }

export async function kbRetrieve(kb: KbRef, project: { id: string; slug: string }, question: string, limit: number): Promise<KbHit[]> {
  const { BedrockAgentRuntimeClient, RetrieveCommand } = await import('@aws-sdk/client-bedrock-agent-runtime');
  const client = new BedrockAgentRuntimeClient({ region: kb.region });
  const res = await client.send(new RetrieveCommand({
    knowledgeBaseId: kb.knowledgeBaseId,
    retrievalQuery: { text: question.slice(0, 1000) },
    retrievalConfiguration: { vectorSearchConfiguration: { numberOfResults: Math.min(100, Math.max(limit * 2, 10)), filter: projectFilter(project.id) } },
  }));
  const out: KbHit[] = [];
  for (const r of res.retrievalResults ?? []) {
    const uri = r.location?.s3Location?.uri ?? '';
    // Belt and braces: the filter already limits the results to the project, and so must the folder.
    const m = /\/kb\/([^/]+)\/([^/]+)\.md$/.exec(uri);
    if (!m || m[1] !== project.slug) continue;
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
