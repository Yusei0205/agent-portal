/**
 * DynamoDB implementation of KnowledgeRepository.
 *
 * Tables used:
 *   portal-content  — knowledge_docs, knowledge_decisions
 *   portal-search   — inverted keyword index for search
 *
 * Key design (portal-content):
 *   Knowledge docs:      PK=PROJECT#<projectId>  SK=KDOC#<docId>
 *   Knowledge decisions: PK=PROJECT#<projectId>  SK=KDEC#<decisionId>
 *   GSI-ContentEntityId: PK=id, SK=entityType   → get doc by UUID
 *
 * Key design (portal-search):
 *   Term postings:  PK=TERM#<projectId>#<token>  SK=DOC#<docId>
 *     Attributes: docId, projectId, matchCount, excerpt (first 500 chars), docVersion
 *   Doc term sets:  PK=DOCTERMS#<docId>           SK=#TERMS
 *     Attributes: terms (StringSet of all indexed tokens), projectId, docVersion
 *   GSI-DocId:      PK=postingDocId  SK=postingTerm
 *     Allows finding all postings for a docId on update/delete without storing term list.
 *
 * Search ranking:
 *   Primary  — count of distinct matched query terms (higher = better match)
 *   Secondary — sum of matchCount across matched postings (TF proxy)
 *
 * Concurrent update safety:
 *   docVersion on the knowledge_docs item is atomically incremented by indexDoc().
 *   Each posting stores the docVersion when it was written.
 *   During search, postings whose docVersion differs from the current doc docVersion are
 *   skipped and queued for lazy deletion (repairDocPostings path).
 *   The DOCTERMS helper item allows O(1) deletion of all postings on delete/update
 *   without needing a full table scan.
 */

import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  DeleteItemCommand,
  QueryCommand,
  BatchWriteItemCommand,
  BatchGetItemCommand,
} from '@aws-sdk/client-dynamodb';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { getDynamoDbClient, marshalItem, getString, getNumber, av } from './dynamo-client.ts';
import {
  MAX_INDEX_BYTES,
  MAX_INDEX_TERMS,
  MAX_QUERY_TERMS,
  MAX_POSTINGS_PER_TERM,
} from './knowledge.ts';
import type {
  KnowledgeRepository,
  KnowledgeDocRecord,
  KnowledgeDecisionRecord,
  SearchResult,
  CreateKnowledgeDocInput,
  UpdateDocPatch,
  CreateDecisionInput,
} from './knowledge.ts';

// ── Table names ───────────────────────────────────────────────────────────────

function contentTable(): string {
  return process.env.DYNAMODB_TABLE_PORTAL_CONTENT ?? 'portal-content-test';
}

function searchTable(): string {
  return process.env.DYNAMODB_TABLE_PORTAL_SEARCH ?? 'portal-search-test';
}

// ── Text processing ───────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with',
  'by', 'from', 'is', 'it', 'as', 'be', 'was', 'are', 'were', 'been', 'has', 'have',
  'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might',
  'this', 'that', 'these', 'those', 'not', 'no', 'so', 'if', 'then', 'than', 'can',
]);

/**
 * Tokenize and normalize text for the inverted index.
 * Returns a Map<token, matchCount> capped at MAX_INDEX_TERMS tokens.
 */
function tokenize(text: string): Map<string, number> {
  const capped = text.slice(0, MAX_INDEX_BYTES);
  const tokens = capped
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2 && t.length <= 60 && !STOPWORDS.has(t));

  const counts = new Map<string, number>();
  for (const t of tokens) {
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }

  if (counts.size > MAX_INDEX_TERMS) {
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_INDEX_TERMS);
    return new Map(sorted);
  }
  return counts;
}

/** Get first 500 chars of text as an excerpt for a search result snippet. */
function excerpt(text: string): string {
  return text.slice(0, 500).trim();
}

// ── Row converters ────────────────────────────────────────────────────────────

function itemToDoc(item: Record<string, AttributeValue>): KnowledgeDocRecord {
  return {
    id: getString(item, 'id') ?? '',
    project_id: getString(item, 'project_id') ?? '',
    name: getString(item, 'name') ?? '',
    original_name: getString(item, 'original_name') ?? getString(item, 'name') ?? '',
    mime_type: getString(item, 'mime_type'),
    size_bytes: getNumber(item, 'size_bytes') || null,
    markdown_path: getString(item, 'markdown_path'),
    status: (getString(item, 'status') ?? 'processing') as KnowledgeDocRecord['status'],
    error: getString(item, 'error'),
    uploaded_by: getString(item, 'uploaded_by'),
    created_at: getString(item, 'created_at') ?? '',
    docVersion: getNumber(item, 'docVersion'),
  };
}

function itemToDecision(item: Record<string, AttributeValue>): KnowledgeDecisionRecord {
  return {
    id: getString(item, 'id') ?? '',
    project_id: getString(item, 'project_id') ?? '',
    question: getString(item, 'question') ?? '',
    answer: getString(item, 'answer') ?? '',
    asked_by: getString(item, 'asked_by'),
    answered_by: getString(item, 'answered_by'),
    created_at: getString(item, 'created_at') ?? '',
  };
}

// ── Pagination helper ─────────────────────────────────────────────────────────

async function paginateAll(
  client: DynamoDBClient,
  params: ConstructorParameters<typeof QueryCommand>[0],
): Promise<Array<Record<string, AttributeValue>>> {
  const items: Array<Record<string, AttributeValue>> = [];
  let lastKey: Record<string, AttributeValue> | undefined;
  do {
    const res = await client.send(new QueryCommand({ ...params, ExclusiveStartKey: lastKey }));
    if (res.Items) items.push(...res.Items);
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

// ── Batch delete helper ───────────────────────────────────────────────────────

async function batchDeleteItems(
  client: DynamoDBClient,
  tableName: string,
  keys: Array<{ PK: string; SK: string }>,
): Promise<void> {
  if (keys.length === 0) return;
  const CHUNK = 25;
  for (let i = 0; i < keys.length; i += CHUNK) {
    const chunk = keys.slice(i, i + CHUNK);
    await client.send(new BatchWriteItemCommand({
      RequestItems: {
        [tableName]: chunk.map((k) => ({
          DeleteRequest: { Key: { PK: av(k.PK), SK: av(k.SK) } },
        })),
      },
    }));
  }
}

// ── Implementation ────────────────────────────────────────────────────────────

export class DynamoDbKnowledgeRepository implements KnowledgeRepository {
  private readonly client: DynamoDBClient;

  constructor() {
    this.client = getDynamoDbClient();
  }

  // ── Table setup (tests) ──────────────────────────────────────────────────────

  async ensureTables(): Promise<void> {
    const { CreateTableCommand, DescribeTableCommand } = await import('@aws-sdk/client-dynamodb');

    const ensureTable = async (tableName: string, createCfg: object) => {
      try {
        await this.client.send(new DescribeTableCommand({ TableName: tableName }));
      } catch (e: unknown) {
        if ((e as { name?: string }).name !== 'ResourceNotFoundException') throw e;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await this.client.send(new CreateTableCommand(createCfg as any));
        let active = false;
        for (let i = 0; i < 60; i++) {
          await new Promise((r) => setTimeout(r, 500));
          const desc = await this.client.send(new DescribeTableCommand({ TableName: tableName }));
          if (desc.Table?.TableStatus === 'ACTIVE') { active = true; break; }
        }
        if (!active) throw new Error(`Table ${tableName} did not become ACTIVE in time`);
      }
    };

    await ensureTable(contentTable(), {
      TableName: contentTable(),
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' },
        { AttributeName: 'SK', AttributeType: 'S' },
        { AttributeName: 'id', AttributeType: 'S' },
        { AttributeName: 'entityType', AttributeType: 'S' },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'GSI-ContentEntityId',
          KeySchema: [
            { AttributeName: 'id', KeyType: 'HASH' },
            { AttributeName: 'entityType', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
    });

    await ensureTable(searchTable(), {
      TableName: searchTable(),
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' },
        { AttributeName: 'SK', AttributeType: 'S' },
        { AttributeName: 'postingDocId', AttributeType: 'S' },
        { AttributeName: 'postingTerm', AttributeType: 'S' },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'GSI-DocId',
          KeySchema: [
            { AttributeName: 'postingDocId', KeyType: 'HASH' },
            { AttributeName: 'postingTerm', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'KEYS_ONLY' },
        },
      ],
    });
  }

  // ── Docs ─────────────────────────────────────────────────────────────────────

  async listDocs(projectId: string): Promise<KnowledgeDocRecord[]> {
    const items = await paginateAll(this.client, {
      TableName: contentTable(),
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skp)',
      ExpressionAttributeValues: {
        ':pk': av(`PROJECT#${projectId}`),
        ':skp': av('KDOC#'),
      },
    });
    const docs = items.map(itemToDoc);
    docs.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return docs;
  }

  async getDocById(id: string): Promise<KnowledgeDocRecord | null> {
    const res = await this.client.send(new QueryCommand({
      TableName: contentTable(),
      IndexName: 'GSI-ContentEntityId',
      KeyConditionExpression: '#id = :id AND entityType = :et',
      ExpressionAttributeNames: { '#id': 'id' },
      ExpressionAttributeValues: { ':id': av(id), ':et': av('kdoc') },
      Limit: 1,
    }));
    const item = res.Items?.[0];
    return item ? itemToDoc(item) : null;
  }

  async createDoc(input: CreateKnowledgeDocInput): Promise<KnowledgeDocRecord> {
    const item: Record<string, AttributeValue> = {
      PK: av(`PROJECT#${input.project_id}`),
      SK: av(`KDOC#${input.id}`),
      id: av(input.id),
      entityType: av('kdoc'),
      project_id: av(input.project_id),
      name: av(input.name),
      original_name: av(input.original_name),
      status: av(input.status),
      uploaded_by: av(input.uploaded_by),
      created_at: av(input.created_at),
      docVersion: { N: '0' },
      ...marshalItem({
        mime_type: input.mime_type,
        size_bytes: input.size_bytes,
      }),
    };
    await this.client.send(new PutItemCommand({
      TableName: contentTable(),
      Item: item,
      ConditionExpression: 'attribute_not_exists(PK)',
    }));
    return itemToDoc(item);
  }

  async updateDoc(id: string, patch: UpdateDocPatch): Promise<void> {
    const doc = await this.getDocById(id);
    if (!doc) return;

    const sets: string[] = [];
    const names: Record<string, string> = {};
    const vals: Record<string, AttributeValue> = {};
    let removes: string[] = [];

    if (patch.status !== undefined) {
      sets.push('#status = :status');
      names['#status'] = 'status';
      vals[':status'] = av(patch.status);
    }
    if (patch.name !== undefined) {
      sets.push('#nm = :nm');
      names['#nm'] = 'name';
      vals[':nm'] = av(patch.name);
    }
    if (patch.markdown_path !== undefined) {
      if (patch.markdown_path === null) {
        removes.push('markdown_path');
      } else {
        sets.push('markdown_path = :mp');
        vals[':mp'] = av(patch.markdown_path);
      }
    }
    if (patch.error !== undefined) {
      if (patch.error === null) {
        removes.push('#err');
        names['#err'] = 'error';
      } else {
        sets.push('#err = :err');
        names['#err'] = 'error';
        vals[':err'] = av(patch.error);
      }
    }

    let expr = '';
    if (sets.length > 0) expr += `SET ${sets.join(', ')}`;
    if (removes.length > 0) expr += ` REMOVE ${removes.join(', ')}`;
    if (!expr.trim()) return;

    await this.client.send(new UpdateItemCommand({
      TableName: contentTable(),
      Key: {
        PK: av(`PROJECT#${doc.project_id}`),
        SK: av(`KDOC#${id}`),
      },
      UpdateExpression: expr,
      ExpressionAttributeNames: Object.keys(names).length > 0 ? names : undefined,
      ExpressionAttributeValues: Object.keys(vals).length > 0 ? vals : undefined,
      ConditionExpression: 'attribute_exists(PK)',
    }));
  }

  async deleteDoc(id: string): Promise<void> {
    const doc = await this.getDocById(id);
    if (!doc) return;
    await this.removeDocIndex(id);
    await this.client.send(new DeleteItemCommand({
      TableName: contentTable(),
      Key: {
        PK: av(`PROJECT#${doc.project_id}`),
        SK: av(`KDOC#${id}`),
      },
    }));
  }

  // ── Search index ──────────────────────────────────────────────────────────────

  async indexDoc(docId: string, projectId: string, text: string): Promise<void> {
    const tokenCounts = tokenize(text);
    if (tokenCounts.size === 0) return;

    // 1. Atomically increment docVersion on the doc item and get new version
    const updateRes = await this.client.send(new UpdateItemCommand({
      TableName: contentTable(),
      Key: {
        PK: av(`PROJECT#${projectId}`),
        SK: av(`KDOC#${docId}`),
      },
      UpdateExpression: 'ADD docVersion :one',
      ExpressionAttributeValues: { ':one': { N: '1' } },
      ReturnValues: 'UPDATED_NEW',
    }));
    const newVersion = Number(updateRes.Attributes?.['docVersion']?.N ?? 1);

    // 2. Delete old postings using the DOCTERMS helper item
    await this._deleteOldPostings(docId);

    // 3. Write new postings (batch)
    const firstChunk = text.slice(0, 500);
    const postingKeys: Array<{ PK: string; SK: string }> = [];
    const CHUNK = 25;
    const tokenEntries = [...tokenCounts.entries()];

    for (let i = 0; i < tokenEntries.length; i += CHUNK) {
      const batch = tokenEntries.slice(i, i + CHUNK);
      await this.client.send(new BatchWriteItemCommand({
        RequestItems: {
          [searchTable()]: batch.map(([token, matchCount]) => ({
            PutRequest: {
              Item: {
                PK: av(`TERM#${projectId}#${token}`),
                SK: av(`DOC#${docId}`),
                postingDocId: av(docId),
                postingTerm: av(token),
                docId: av(docId),
                projectId: av(projectId),
                matchCount: { N: String(matchCount) },
                excerpt: av(excerpt(firstChunk)),
                docVersion: { N: String(newVersion) },
              },
            },
          })),
        },
      }));
      for (const [token] of batch) postingKeys.push({ PK: `TERM#${projectId}#${token}`, SK: `DOC#${docId}` });
    }

    // 4. Update DOCTERMS helper item with current token set + projectId + docVersion
    const terms = [...tokenCounts.keys()];
    await this.client.send(new PutItemCommand({
      TableName: searchTable(),
      Item: {
        PK: av(`DOCTERMS#${docId}`),
        SK: av('#TERMS'),
        docId: av(docId),
        projectId: av(projectId),
        docVersion: { N: String(newVersion) },
        terms: { SS: terms },
      },
    }));
  }

  async removeDocIndex(docId: string): Promise<void> {
    await this._deleteOldPostings(docId);
  }

  private async _deleteOldPostings(docId: string): Promise<void> {
    const tbl = searchTable();

    // Get old token set from DOCTERMS item
    const res = await this.client.send(new GetItemCommand({
      TableName: tbl,
      Key: { PK: av(`DOCTERMS#${docId}`), SK: av('#TERMS') },
    }));
    const item = res.Item;
    if (!item) return;

    const projectId = getString(item, 'projectId') ?? '';
    const oldTerms = item['terms']?.SS ?? [];

    // Delete old posting items
    const keysToDelete = oldTerms.map((t) => ({ PK: `TERM#${projectId}#${t}`, SK: `DOC#${docId}` }));
    await batchDeleteItems(this.client, tbl, keysToDelete);

    // Delete DOCTERMS item
    await this.client.send(new DeleteItemCommand({
      TableName: tbl,
      Key: { PK: av(`DOCTERMS#${docId}`), SK: av('#TERMS') },
    }));
  }

  async searchDocs(projectId: string, query: string, limit: number): Promise<SearchResult[]> {
    const tokenCounts = tokenize(query);
    if (tokenCounts.size === 0) return [];

    const queryTokens = [...tokenCounts.keys()].slice(0, MAX_QUERY_TERMS);
    const tbl = searchTable();

    // Collect postings per term
    const postingsByDoc = new Map<string, { matchedTerms: number; totalScore: number; excerpt: string; docVersion: number }>();

    for (const token of queryTokens) {
      const res = await this.client.send(new QueryCommand({
        TableName: tbl,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': av(`TERM#${projectId}#${token}`) },
        Limit: MAX_POSTINGS_PER_TERM,
      }));
      for (const item of res.Items ?? []) {
        const docId = getString(item, 'docId') ?? '';
        const matchCount = getNumber(item, 'matchCount');
        const docVer = getNumber(item, 'docVersion');
        const exc = getString(item, 'excerpt') ?? '';
        const existing = postingsByDoc.get(docId);
        if (existing) {
          existing.matchedTerms += 1;
          existing.totalScore += matchCount;
        } else {
          postingsByDoc.set(docId, { matchedTerms: 1, totalScore: matchCount, excerpt: exc, docVersion: docVer });
        }
      }
    }

    if (postingsByDoc.size === 0) return [];

    // Fetch current doc metadata to verify project scope and filter stale postings
    const docIds = [...postingsByDoc.keys()];
    const BGET_CHUNK = 100;
    const docMeta = new Map<string, { name: string; project_id: string; docVersion: number }>();

    for (let i = 0; i < docIds.length; i += BGET_CHUNK) {
      const chunk = docIds.slice(i, i + BGET_CHUNK);
      const keys = chunk.map((id) => ({
        PK: av(`PROJECT#${projectId}`),
        SK: av(`KDOC#${id}`),
      }));
      const bRes = await this.client.send(new BatchGetItemCommand({
        RequestItems: {
          [contentTable()]: { Keys: keys },
        },
      }));
      for (const item of bRes.Responses?.[contentTable()] ?? []) {
        const pid = getString(item, 'project_id') ?? '';
        if (pid !== projectId) continue;
        const name = getString(item, 'name') ?? '';
        const ver = getNumber(item, 'docVersion');
        docMeta.set(getString(item, 'id') ?? '', { name, project_id: pid, docVersion: ver });
      }
    }

    // Build results, filter stale postings
    const results: SearchResult[] = [];
    const stalePostings: string[] = [];

    const sorted = [...postingsByDoc.entries()].sort((a, b) => {
      const md = b[1].matchedTerms - a[1].matchedTerms;
      return md !== 0 ? md : b[1].totalScore - a[1].totalScore;
    });

    for (const [docId, posting] of sorted) {
      if (results.length >= limit) break;
      const meta = docMeta.get(docId);
      if (!meta) {
        stalePostings.push(docId);
        continue;
      }
      if (posting.docVersion !== meta.docVersion) {
        stalePostings.push(docId);
        continue;
      }
      results.push({ docId, name: meta.name, snippet: posting.excerpt });
    }

    // Async lazy cleanup of stale postings (fire-and-forget)
    if (stalePostings.length > 0) {
      Promise.all(stalePostings.map((id) => this.removeDocIndex(id))).catch(() => {});
    }

    return results;
  }

  // ── Decisions ─────────────────────────────────────────────────────────────────

  async listDecisions(projectId: string): Promise<KnowledgeDecisionRecord[]> {
    const items = await paginateAll(this.client, {
      TableName: contentTable(),
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skp)',
      ExpressionAttributeValues: {
        ':pk': av(`PROJECT#${projectId}`),
        ':skp': av('KDEC#'),
      },
    });
    const decisions = items.map(itemToDecision);
    decisions.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return decisions;
  }

  async createDecision(input: CreateDecisionInput): Promise<KnowledgeDecisionRecord> {
    const item: Record<string, AttributeValue> = {
      PK: av(`PROJECT#${input.project_id}`),
      SK: av(`KDEC#${input.id}`),
      id: av(input.id),
      entityType: av('kdec'),
      project_id: av(input.project_id),
      question: av(input.question),
      answer: av(input.answer),
      asked_by: av(input.asked_by),
      answered_by: av(input.answered_by),
      created_at: av(input.created_at),
    };
    await this.client.send(new PutItemCommand({
      TableName: contentTable(),
      Item: item,
      ConditionExpression: 'attribute_not_exists(PK)',
    }));
    return itemToDecision(item);
  }
}
