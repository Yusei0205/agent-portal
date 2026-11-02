/**
 * DynamoDB implementation of LearnRepository.
 *
 * Table: portal-learn (DYNAMODB_TABLE_PORTAL_LEARN, default 'portal-learn')
 *
 * Key design:
 *   PK=LDOC#<id>   SK=#META   → learn_docs
 *   PK=QUIZ#<id>   SK=#META   → quizzes
 *   PK=QATT#<quizId>  SK=<userId>#<id>  → quiz_attempts
 *   PK=PATH#<id>   SK=#META   → paths
 *   PK=DREAD#<docId>  SK=<userId>   → doc_reads
 * GSI-LearnByProject:
 *   PK=learnProjectId  SK=<type>#<createdAt>#<id>
 */

import {
  PutItemCommand,
  GetItemCommand,
  QueryCommand,
  UpdateItemCommand,
  DeleteItemCommand,
  CreateTableCommand,
  DescribeTableCommand,
  ResourceNotFoundException,
  ResourceInUseException,
} from '@aws-sdk/client-dynamodb';
import type { AttributeValue, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { getDynamoDbClient, marshalItem, getString, getNumber, type JsVal } from './dynamo-client.ts';
import type {
  LearnRepository,
  LearnDocRecord,
  QuizRecord,
  QuizAttemptRecord,
  PathRecord,
} from './learn.ts';

// ── Table bootstrap ───────────────────────────────────────────────────────────

export async function ensureLearnTableExists(
  client: DynamoDBClient,
  tableName: string,
): Promise<void> {
  try {
    await client.send(new DescribeTableCommand({ TableName: tableName }));
    return;
  } catch (e: unknown) {
    if (!(e instanceof ResourceNotFoundException)) throw e;
  }
  try {
    await client.send(new CreateTableCommand({
      TableName: tableName,
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
      AttributeDefinitions: [
        { AttributeName: 'PK',              AttributeType: 'S' },
        { AttributeName: 'SK',              AttributeType: 'S' },
        { AttributeName: 'learnProjectId',  AttributeType: 'S' },
        { AttributeName: 'learnListSK',     AttributeType: 'S' },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'GSI-LearnByProject',
          KeySchema: [
            { AttributeName: 'learnProjectId', KeyType: 'HASH' },
            { AttributeName: 'learnListSK',    KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    }));
  } catch (e: unknown) {
    if (!(e instanceof ResourceInUseException)) throw e;
  }
}

// ── Item converters ───────────────────────────────────────────────────────────

const S = (v: string | null | undefined): string => v ?? '';

function itemToDoc(item: Record<string, AttributeValue>): LearnDocRecord {
  return {
    id:           S(getString(item, 'id')),
    project_id:   S(getString(item, 'project_id')),
    title:        S(getString(item, 'title')),
    slug:         S(getString(item, 'slug')),
    kind:         S(getString(item, 'kind')) || 'overview',
    focus:        S(getString(item, 'focus')),
    doc_ids:      S(getString(item, 'doc_ids')) || '[]',
    source_refs:  S(getString(item, 'source_refs')) || '[]',
    source_hash:  getString(item, 'source_hash'),
    business_md:  S(getString(item, 'business_md')),
    technical_md: S(getString(item, 'technical_md')),
    glossary:     S(getString(item, 'glossary')) || '[]',
    status:       S(getString(item, 'status')) || 'draft',
    stale:        getNumber(item, 'stale'),
    error:        getString(item, 'error'),
    run_id:       getString(item, 'run_id'),
    created_by:   getString(item, 'created_by'),
    created_at:   S(getString(item, 'created_at')),
    updated_at:   S(getString(item, 'updated_at')),
    approved_by:  getString(item, 'approved_by'),
    published_at: getString(item, 'published_at'),
    audience:     getString(item, 'audience'),
  };
}

function itemToQuiz(item: Record<string, AttributeValue>): QuizRecord {
  return {
    id:           S(getString(item, 'id')),
    project_id:   S(getString(item, 'project_id')),
    title:        S(getString(item, 'title')),
    audience:     S(getString(item, 'audience')) || 'everyone',
    difficulty:   S(getString(item, 'difficulty')) || 'medium',
    learn_doc_id: getString(item, 'learn_doc_id'),
    doc_ids:      S(getString(item, 'doc_ids')) || '[]',
    source_refs:  S(getString(item, 'source_refs')) || '[]',
    source_hash:  getString(item, 'source_hash'),
    questions:    S(getString(item, 'questions')) || '[]',
    dropped:      getNumber(item, 'dropped'),
    status:       S(getString(item, 'status')) || 'draft',
    stale:        getNumber(item, 'stale'),
    error:        getString(item, 'error'),
    run_id:       getString(item, 'run_id'),
    created_by:   getString(item, 'created_by'),
    created_at:   S(getString(item, 'created_at')),
    updated_at:   S(getString(item, 'updated_at')),
    approved_by:  getString(item, 'approved_by'),
    published_at: getString(item, 'published_at'),
  };
}

function itemToAttempt(item: Record<string, AttributeValue>): QuizAttemptRecord {
  return {
    id:         S(getString(item, 'id')),
    quiz_id:    S(getString(item, 'quiz_id')),
    user_id:    S(getString(item, 'user_id')),
    answers:    S(getString(item, 'answers')) || '[]',
    results:    S(getString(item, 'results')) || '[]',
    score:      getNumber(item, 'score'),
    total:      getNumber(item, 'total'),
    created_at: S(getString(item, 'created_at')),
  };
}

function itemToPath(item: Record<string, AttributeValue>): PathRecord {
  return {
    id:          S(getString(item, 'id')),
    project_id:  S(getString(item, 'project_id')),
    title:       S(getString(item, 'title')),
    audience:    S(getString(item, 'audience')) || 'everyone',
    description: S(getString(item, 'description')),
    steps:       S(getString(item, 'steps')) || '[]',
    status:      S(getString(item, 'status')) || 'draft',
    created_by:  getString(item, 'created_by'),
    created_at:  S(getString(item, 'created_at')),
    updated_at:  S(getString(item, 'updated_at')),
  };
}

// ── Implementation ─────────────────────────────────────────────────────────────

export class DynamoDbLearnRepository implements LearnRepository {
  private readonly client: DynamoDBClient;
  private readonly tableName: string;

  constructor(opts?: { client?: DynamoDBClient; tableName?: string }) {
    this.client    = opts?.client    ?? getDynamoDbClient();
    this.tableName = opts?.tableName ?? process.env.DYNAMODB_TABLE_PORTAL_LEARN ?? 'portal-learn';
  }

  getClient(): DynamoDBClient { return this.client; }
  getTableName(): string { return this.tableName; }

  // learn_docs
  async createDoc(doc: LearnDocRecord): Promise<LearnDocRecord> {
    const item: Record<string, JsVal> = {
      PK: `LDOC#${doc.id}`, SK: '#META',
      id: doc.id, project_id: doc.project_id, title: doc.title, slug: doc.slug,
      kind: doc.kind, focus: doc.focus, doc_ids: doc.doc_ids, source_refs: doc.source_refs,
      source_hash: doc.source_hash, business_md: doc.business_md, technical_md: doc.technical_md,
      glossary: doc.glossary, status: doc.status, stale: doc.stale, error: doc.error,
      run_id: doc.run_id, created_by: doc.created_by, created_at: doc.created_at,
      updated_at: doc.updated_at, approved_by: doc.approved_by, published_at: doc.published_at,
      audience: doc.audience,
      learnProjectId: doc.project_id, learnListSK: `LDOC#${doc.created_at}#${doc.id}`,
    };
    await this.client.send(new PutItemCommand({ TableName: this.tableName, Item: marshalItem(item) }));
    return doc;
  }

  async getDocById(id: string): Promise<LearnDocRecord | null> {
    const resp = await this.client.send(new GetItemCommand({
      TableName: this.tableName, Key: marshalItem({ PK: `LDOC#${id}`, SK: '#META' }),
    }));
    return resp.Item ? itemToDoc(resp.Item) : null;
  }

  async listDocsByProject(projectId: string, publishedOnly = false): Promise<LearnDocRecord[]> {
    const resp = await this.client.send(new QueryCommand({
      TableName: this.tableName, IndexName: 'GSI-LearnByProject',
      KeyConditionExpression: 'learnProjectId = :pid AND begins_with(learnListSK, :prefix)',
      ExpressionAttributeValues: marshalItem({ ':pid': projectId, ':prefix': 'LDOC#' }),
      ScanIndexForward: false,
    }));
    const docs = (resp.Items ?? []).map(itemToDoc);
    return publishedOnly ? docs.filter((d) => d.status === 'published') : docs;
  }

  async updateDoc(id: string, fields: Partial<LearnDocRecord>): Promise<void> {
    const sets: string[] = [];
    const vals: Record<string, JsVal> = {};
    const names: Record<string, string> = {};
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue;
      names[`#${k}`] = k;
      vals[`:${k}`] = v as JsVal;
      sets.push(`#${k} = :${k}`);
    }
    if (!sets.length) return;
    await this.client.send(new UpdateItemCommand({
      TableName: this.tableName, Key: marshalItem({ PK: `LDOC#${id}`, SK: '#META' }),
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: names, ExpressionAttributeValues: marshalItem(vals),
    }));
  }

  async deleteDoc(id: string): Promise<void> {
    await this.client.send(new DeleteItemCommand({
      TableName: this.tableName, Key: marshalItem({ PK: `LDOC#${id}`, SK: '#META' }),
    }));
  }

  // quizzes
  async createQuiz(quiz: QuizRecord): Promise<QuizRecord> {
    const item: Record<string, JsVal> = {
      PK: `QUIZ#${quiz.id}`, SK: '#META',
      id: quiz.id, project_id: quiz.project_id, title: quiz.title, audience: quiz.audience,
      difficulty: quiz.difficulty, learn_doc_id: quiz.learn_doc_id, doc_ids: quiz.doc_ids,
      source_refs: quiz.source_refs, source_hash: quiz.source_hash, questions: quiz.questions,
      dropped: quiz.dropped, status: quiz.status, stale: quiz.stale, error: quiz.error,
      run_id: quiz.run_id, created_by: quiz.created_by, created_at: quiz.created_at,
      updated_at: quiz.updated_at, approved_by: quiz.approved_by, published_at: quiz.published_at,
      learnProjectId: quiz.project_id, learnListSK: `QUIZ#${quiz.created_at}#${quiz.id}`,
    };
    await this.client.send(new PutItemCommand({ TableName: this.tableName, Item: marshalItem(item) }));
    return quiz;
  }

  async getQuizById(id: string): Promise<QuizRecord | null> {
    const resp = await this.client.send(new GetItemCommand({
      TableName: this.tableName, Key: marshalItem({ PK: `QUIZ#${id}`, SK: '#META' }),
    }));
    return resp.Item ? itemToQuiz(resp.Item) : null;
  }

  async listQuizzesByProject(projectId: string, publishedOnly = false): Promise<QuizRecord[]> {
    const resp = await this.client.send(new QueryCommand({
      TableName: this.tableName, IndexName: 'GSI-LearnByProject',
      KeyConditionExpression: 'learnProjectId = :pid AND begins_with(learnListSK, :prefix)',
      ExpressionAttributeValues: marshalItem({ ':pid': projectId, ':prefix': 'QUIZ#' }),
      ScanIndexForward: false,
    }));
    const quizzes = (resp.Items ?? []).map(itemToQuiz);
    return publishedOnly ? quizzes.filter((q) => q.status === 'published') : quizzes;
  }

  async listQuizzesByDoc(docId: string): Promise<QuizRecord[]> {
    // Backlog: add GSI for quiz→doc linkage. For now, not efficiently queryable.
    return [];
  }

  async updateQuiz(id: string, fields: Partial<QuizRecord>): Promise<void> {
    const sets: string[] = [];
    const vals: Record<string, JsVal> = {};
    const names: Record<string, string> = {};
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue;
      names[`#${k}`] = k;
      vals[`:${k}`] = v as JsVal;
      sets.push(`#${k} = :${k}`);
    }
    if (!sets.length) return;
    await this.client.send(new UpdateItemCommand({
      TableName: this.tableName, Key: marshalItem({ PK: `QUIZ#${id}`, SK: '#META' }),
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: names, ExpressionAttributeValues: marshalItem(vals),
    }));
  }

  async deleteQuiz(id: string): Promise<void> {
    await this.client.send(new DeleteItemCommand({
      TableName: this.tableName, Key: marshalItem({ PK: `QUIZ#${id}`, SK: '#META' }),
    }));
  }

  // quiz_attempts
  async createAttempt(attempt: QuizAttemptRecord): Promise<QuizAttemptRecord> {
    const item: Record<string, JsVal> = {
      PK: `QATT#${attempt.quiz_id}`, SK: `${attempt.user_id}#${attempt.id}`,
      id: attempt.id, quiz_id: attempt.quiz_id, user_id: attempt.user_id,
      answers: attempt.answers, results: attempt.results,
      score: attempt.score, total: attempt.total, created_at: attempt.created_at,
    };
    await this.client.send(new PutItemCommand({ TableName: this.tableName, Item: marshalItem(item) }));
    return attempt;
  }

  async listAttemptsByQuiz(quizId: string, userId?: string): Promise<QuizAttemptRecord[]> {
    const params: Parameters<typeof QueryCommand>[0] = {
      TableName: this.tableName,
      KeyConditionExpression: userId
        ? 'PK = :pk AND begins_with(SK, :uid)'
        : 'PK = :pk',
      ExpressionAttributeValues: userId
        ? marshalItem({ ':pk': `QATT#${quizId}`, ':uid': `${userId}#` })
        : marshalItem({ ':pk': `QATT#${quizId}` }),
      ScanIndexForward: false,
    };
    const resp = await this.client.send(new QueryCommand(params));
    return (resp.Items ?? []).map(itemToAttempt);
  }

  async getBestAttemptScore(quizId: string, userId: string): Promise<{ score: number; total: number } | null> {
    const attempts = await this.listAttemptsByQuiz(quizId, userId);
    if (!attempts.length) return null;
    const best = attempts.reduce((a, b) => (a.total > 0 && a.score / a.total > b.score / b.total ? a : b));
    return { score: best.score, total: best.total };
  }

  // paths
  async createPath(path: PathRecord): Promise<PathRecord> {
    const item: Record<string, JsVal> = {
      PK: `PATH#${path.id}`, SK: '#META',
      id: path.id, project_id: path.project_id, title: path.title, audience: path.audience,
      description: path.description, steps: path.steps, status: path.status,
      created_by: path.created_by, created_at: path.created_at, updated_at: path.updated_at,
      learnProjectId: path.project_id, learnListSK: `PATH#${path.created_at}#${path.id}`,
    };
    await this.client.send(new PutItemCommand({ TableName: this.tableName, Item: marshalItem(item) }));
    return path;
  }

  async getPathById(id: string): Promise<PathRecord | null> {
    const resp = await this.client.send(new GetItemCommand({
      TableName: this.tableName, Key: marshalItem({ PK: `PATH#${id}`, SK: '#META' }),
    }));
    return resp.Item ? itemToPath(resp.Item) : null;
  }

  async listPathsByProject(projectId: string): Promise<PathRecord[]> {
    const resp = await this.client.send(new QueryCommand({
      TableName: this.tableName, IndexName: 'GSI-LearnByProject',
      KeyConditionExpression: 'learnProjectId = :pid AND begins_with(learnListSK, :prefix)',
      ExpressionAttributeValues: marshalItem({ ':pid': projectId, ':prefix': 'PATH#' }),
      ScanIndexForward: false,
    }));
    return (resp.Items ?? []).map(itemToPath);
  }

  async updatePath(id: string, fields: Partial<PathRecord>): Promise<void> {
    const sets: string[] = [];
    const vals: Record<string, JsVal> = {};
    const names: Record<string, string> = {};
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue;
      names[`#${k}`] = k;
      vals[`:${k}`] = v as JsVal;
      sets.push(`#${k} = :${k}`);
    }
    if (!sets.length) return;
    await this.client.send(new UpdateItemCommand({
      TableName: this.tableName, Key: marshalItem({ PK: `PATH#${id}`, SK: '#META' }),
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: names, ExpressionAttributeValues: marshalItem(vals),
    }));
  }

  async deletePath(id: string): Promise<void> {
    await this.client.send(new DeleteItemCommand({
      TableName: this.tableName, Key: marshalItem({ PK: `PATH#${id}`, SK: '#META' }),
    }));
  }

  // doc_reads
  async markRead(docId: string, userId: string, readAt: string): Promise<void> {
    const item: Record<string, JsVal> = {
      PK: `DREAD#${docId}`, SK: userId,
      learn_doc_id: docId, user_id: userId, read_at: readAt,
    };
    await this.client.send(new PutItemCommand({ TableName: this.tableName, Item: marshalItem(item) }));
  }

  async isRead(docId: string, userId: string): Promise<boolean> {
    const resp = await this.client.send(new GetItemCommand({
      TableName: this.tableName, Key: marshalItem({ PK: `DREAD#${docId}`, SK: userId }),
    }));
    return !!resp.Item;
  }
}
