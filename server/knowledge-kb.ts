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
  /** The portal created it (so removing it deletes it). A linked Knowledge Base is only unlinked, never deleted. */
  owned?: boolean;
  name?: string;
}

const SHARED_KEY = 'knowledge.kb';

const regionOf = (): string => process.env.AWS_REGION || 'ap-southeast-1';

/** The shared Knowledge Base the portal created (or, on older deployments, the one the stack created). */
export function sharedKb(): KbRef | null {
  try {
    const raw = getSetting(getDb(), SHARED_KEY);
    if (raw) {
      const v = JSON.parse(raw) as Partial<KbRef>;
      if (v.knowledgeBaseId && v.dataSourceId) return { knowledgeBaseId: v.knowledgeBaseId, dataSourceId: v.dataSourceId, region: v.region || regionOf(), owned: v.owned !== false, ...(v.name ? { name: v.name } : {}) };
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

const KB_NAME_RE = /^[0-9a-zA-Z_-]{1,100}$/;
export const DEFAULT_KB_NAME = 'agent-portal-knowledge';

const sourceConfig = () => ({
  dataSourceConfiguration: { type: 'S3' as const, s3Configuration: { bucketArn: process.env.PORTAL_KB_BUCKET_ARN!, inclusionPrefixes: ['data/kb/'] } },
  vectorIngestionConfiguration: { chunkingConfiguration: { chunkingStrategy: 'FIXED_SIZE' as const, fixedSizeChunkingConfiguration: { maxTokens: 300, overlapPercentage: 20 } } },
});

/** Thrown when a name is taken, so the caller can offer to link the existing one instead. */
export class KbNameTaken extends Error {
  constructor(public readonly kbName: string, public readonly deleting: boolean) {
    super(deleting
      ? `A Knowledge Base named "${kbName}" is still being deleted (Bedrock takes a minute or two). Wait a little, pick another name, or link another existing one.`
      : `A Knowledge Base named "${kbName}" already exists. Link it instead, or pick another name.`);
  }
}

export interface KbSummary {
  knowledgeBaseId: string;
  name: string;
  status: string;
  description: string;
  dataSources: Array<{ dataSourceId: string; name: string; status: string; reads: boolean; where: string }>;
}

/** Whether a data source reads the folder the portal copies documents to (data/kb/ of its storage bucket). */
function readsPortalCopies(bucketArn: string | undefined, prefixes: string[] | undefined): boolean {
  if (!bucketArn || bucketArn !== process.env.PORTAL_KB_BUCKET_ARN) return false;
  if (!prefixes?.length) return true;
  return prefixes.some((p) => 'data/kb/'.startsWith(p) || p.startsWith('data/kb/'));
}

/** The Knowledge Bases of this account and region, with their data sources (for "use an existing one"). */
export async function listKbs(): Promise<KbSummary[]> {
  const { BedrockAgentClient, ListKnowledgeBasesCommand, ListDataSourcesCommand, GetDataSourceCommand } = await import('@aws-sdk/client-bedrock-agent');
  const client = new BedrockAgentClient({ region: regionOf() });
  const out: KbSummary[] = [];
  let token: string | undefined;
  do {
    const page = await client.send(new ListKnowledgeBasesCommand({ maxResults: 50, nextToken: token }));
    for (const k of page.knowledgeBaseSummaries ?? []) {
      if (!k.knowledgeBaseId) continue;
      const row: KbSummary = { knowledgeBaseId: k.knowledgeBaseId, name: k.name ?? k.knowledgeBaseId, status: String(k.status ?? ''), description: k.description ?? '', dataSources: [] };
      if (row.status === 'ACTIVE' && out.length < 30) {
        const list = await client.send(new ListDataSourcesCommand({ knowledgeBaseId: k.knowledgeBaseId, maxResults: 10 })).catch(() => null);
        for (const d of list?.dataSourceSummaries ?? []) {
          if (!d.dataSourceId) continue;
          const detail = await client.send(new GetDataSourceCommand({ knowledgeBaseId: k.knowledgeBaseId, dataSourceId: d.dataSourceId })).catch(() => null);
          const s3 = detail?.dataSource?.dataSourceConfiguration?.s3Configuration;
          row.dataSources.push({
            dataSourceId: d.dataSourceId,
            name: d.name ?? d.dataSourceId,
            status: String(d.status ?? ''),
            reads: readsPortalCopies(s3?.bucketArn, s3?.inclusionPrefixes),
            where: s3?.bucketArn ? `${s3.bucketArn.replace('arn:aws:s3:::', 's3://')}/${(s3.inclusionPrefixes ?? []).join(',')}` : 'not an S3 data source',
          });
        }
      }
      out.push(row);
    }
    token = page.nextToken;
  } while (token && out.length < 100);
  return out;
}

/** Create the shared Knowledge Base (with the name the admin chose) and its data source, and remember them. */
export async function createSharedKb(nameIn?: string): Promise<KbRef> {
  if (sharedKb()) throw new Error('A Knowledge Base is already in use. Remove or unlink it first.');
  if (!kbCreatable()) throw new Error('This deployment has no Knowledge Base prerequisites (vector index and role). Deploy the latest stack first.');
  const name = (nameIn ?? '').trim() || DEFAULT_KB_NAME;
  if (!KB_NAME_RE.test(name)) throw new Error('The name may use letters, digits, hyphens and underscores only (up to 100 characters).');
  const { BedrockAgentClient, CreateKnowledgeBaseCommand, GetKnowledgeBaseCommand, CreateDataSourceCommand, DeleteKnowledgeBaseCommand } = await import('@aws-sdk/client-bedrock-agent');
  const region = regionOf();
  const client = new BedrockAgentClient({ region });

  let knowledgeBaseId: string | undefined;
  try {
    const created = await client.send(new CreateKnowledgeBaseCommand({
      name,
      description: 'Project documents of the Agent Portal, kept apart by project.',
      roleArn: process.env.PORTAL_KB_ROLE_ARN!,
      knowledgeBaseConfiguration: { type: 'VECTOR', vectorKnowledgeBaseConfiguration: { embeddingModelArn: process.env.PORTAL_KB_EMBED_MODEL_ARN! } },
      storageConfiguration: { type: 'S3_VECTORS', s3VectorsConfiguration: { indexArn: process.env.PORTAL_KB_INDEX_ARN! } },
    }));
    knowledgeBaseId = created.knowledgeBase?.knowledgeBaseId;
  } catch (e) {
    if ((e as { name?: string })?.name === 'ConflictException' || /already exists/i.test(String((e as Error)?.message))) {
      const existing = (await listKbs().catch(() => [])).find((k) => k.name === name);
      throw new KbNameTaken(name, existing?.status === 'DELETING');
    }
    throw e;
  }
  if (!knowledgeBaseId) throw new Error('Bedrock did not return a Knowledge Base id.');

  try {
    // The data source can only be added once the Knowledge Base is active (usually within half a minute).
    for (let i = 0; i < 25; i++) {
      const st = (await client.send(new GetKnowledgeBaseCommand({ knowledgeBaseId }))).knowledgeBase?.status;
      if (st === 'ACTIVE') break;
      if (st === 'FAILED') throw new Error('The Knowledge Base could not be created (Bedrock reported FAILED).');
      await sleep(3000);
    }
    const ds = await client.send(new CreateDataSourceCommand({ knowledgeBaseId, name: 'project-documents', ...sourceConfig() }));
    const dataSourceId = ds.dataSource?.dataSourceId;
    if (!dataSourceId) throw new Error('Bedrock did not return a data source id.');
    const ref: KbRef = { knowledgeBaseId, dataSourceId, region, owned: true, name };
    await setSetting(getDb(), SHARED_KEY, JSON.stringify(ref));
    return ref;
  } catch (e) {
    // Do not leave a half-made Knowledge Base behind.
    await client.send(new DeleteKnowledgeBaseCommand({ knowledgeBaseId })).catch(() => {});
    throw e;
  }
}

/**
 * Use a Knowledge Base that already exists. It must be active; if it has no data source, one that reads the portal's
 * copies is added. Returns a warning when the chosen data source does not read the folder the portal copies to.
 */
export async function linkSharedKb(knowledgeBaseId: string, dataSourceIdIn?: string): Promise<{ ref: KbRef; warning?: string }> {
  if (sharedKb()) throw new Error('A Knowledge Base is already in use. Remove or unlink it first.');
  if (!/^[A-Za-z0-9]{10}$/.test(knowledgeBaseId)) throw new Error('A Knowledge Base id is 10 letters and digits.');
  const { BedrockAgentClient, GetKnowledgeBaseCommand, ListDataSourcesCommand, GetDataSourceCommand, CreateDataSourceCommand } = await import('@aws-sdk/client-bedrock-agent');
  const region = regionOf();
  const client = new BedrockAgentClient({ region });
  const kb = (await client.send(new GetKnowledgeBaseCommand({ knowledgeBaseId }))).knowledgeBase;
  if (!kb) throw new Error('That Knowledge Base was not found in this region.');
  if (kb.status !== 'ACTIVE') throw new Error(`That Knowledge Base is ${String(kb.status).toLowerCase()}, not active.`);

  let dataSourceId = dataSourceIdIn;
  if (!dataSourceId) {
    const list = await client.send(new ListDataSourcesCommand({ knowledgeBaseId, maxResults: 10 }));
    const sources = list.dataSourceSummaries ?? [];
    if (sources.length === 1) dataSourceId = sources[0].dataSourceId;
    else if (sources.length > 1) throw new Error('That Knowledge Base has several data sources; choose one.');
    else {
      if (!kbCreatable()) throw new Error('That Knowledge Base has no data source, and this deployment cannot add one.');
      const ds = await client.send(new CreateDataSourceCommand({ knowledgeBaseId, name: 'project-documents', ...sourceConfig() }));
      dataSourceId = ds.dataSource?.dataSourceId;
    }
  }
  if (!dataSourceId) throw new Error('No data source could be chosen.');
  const detail = await client.send(new GetDataSourceCommand({ knowledgeBaseId, dataSourceId }));
  const s3 = detail.dataSource?.dataSourceConfiguration?.s3Configuration;
  const warning = readsPortalCopies(s3?.bucketArn, s3?.inclusionPrefixes)
    ? undefined
    : 'This data source does not read the portal\'s copies (data/kb/ in the storage bucket), so searches will find nothing until it does.';
  const ref: KbRef = { knowledgeBaseId, dataSourceId, region, owned: false, name: kb.name };
  await setSetting(getDb(), SHARED_KEY, JSON.stringify(ref));
  return { ref, ...(warning ? { warning } : {}) };
}

/** Stop using the shared Knowledge Base. One the portal created is deleted; a linked one is only unlinked. */
export async function deleteSharedKb(): Promise<{ deleted: boolean }> {
  const kb = sharedKb();
  if (!kb) return { deleted: false };
  if (kb.owned !== false) {
    const { BedrockAgentClient, DeleteDataSourceCommand, DeleteKnowledgeBaseCommand } = await import('@aws-sdk/client-bedrock-agent');
    const client = new BedrockAgentClient({ region: kb.region });
    await client.send(new DeleteDataSourceCommand({ knowledgeBaseId: kb.knowledgeBaseId, dataSourceId: kb.dataSourceId })).catch(() => {});
    await client.send(new DeleteKnowledgeBaseCommand({ knowledgeBaseId: kb.knowledgeBaseId }));
  }
  await setSetting(getDb(), SHARED_KEY, JSON.stringify(''));
  return { deleted: kb.owned !== false };
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
