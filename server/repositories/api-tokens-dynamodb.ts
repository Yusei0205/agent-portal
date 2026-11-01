/**
 * DynamoDB implementation of ApiTokenRepository.
 *
 * Table:   portal-users  (DYNAMODB_TABLE_PORTAL_USERS, default 'portal-users')
 * Client:  shared singleton from ./dynamo-client.ts
 * Region:  ap-southeast-1 by default (see ./backend.ts)
 *
 * ## Key schema for api_tokens items
 *   PK  = USER#<userId>
 *   SK  = TOKEN#<tokenId>
 *
 * ## GSI-TokenHash — hash lookup (every authenticated request)
 *   PK attribute:   tokenHash   (sha-256 hex string)
 *   SK attribute:   entityType  (stored as 'TOKEN#<userId>')
 *   Projection:     ALL
 *
 * ## TOKEN_INDEX partition — admin list without Scan
 *
 *   A lightweight entry is written at PK=TOKEN_INDEX, SK=<createdAt>#<tokenId>
 *   for every non-delegate token on create(), and updated on revoke().
 *   Querying PK=TOKEN_INDEX with ScanIndexForward=false gives all non-delegate
 *   tokens newest-first, satisfying listAll() with no Scan.
 *
 *   Denormalized user fields (userName, userEmail) are stored at create time.
 *   They reflect the values at the moment the token was created; changes to
 *   the user record afterwards will not be reflected.
 *
 *   last_used_at is NOT maintained in TOKEN_INDEX; the admin view shows null.
 *
 * ## TTL behaviour — retention period
 *
 *   The TTL attribute expiresAtEpoch is set to:
 *     floor(expires_at_unix + 90 * 86400)   on create
 *     floor(revoked_at_unix + 90 * 86400)   on revoke
 *
 *   This retains expired and revoked tokens for 90 days, matching SQLite
 *   behaviour (where they remain visible until the DB is vacuumed).
 *   A missing or non-parseable expires_at produces no TTL attribute, so
 *   the item is never auto-deleted (the safe fallback).
 */

import {
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  QueryCommand,
  CreateTableCommand,
  DescribeTableCommand,
  ResourceNotFoundException,
  ResourceInUseException,
  ConditionalCheckFailedException,
} from '@aws-sdk/client-dynamodb';
import type { AttributeValue, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  getDynamoDbClient,
  marshalItem,
  getString,
  getNumber,
  type JsVal,
} from './dynamo-client.ts';
import type {
  ApiTokenRepository,
  CreateTokenInput,
  TokenRecord,
  TokenWithUser,
  TokenWithUserMeta,
} from './api-tokens.ts';

// ── TTL ───────────────────────────────────────────────────────────────────────

const RETENTION_SECONDS = 90 * 24 * 3600; // 90-day retention after expiry/revocation

/**
 * Convert an ISO date string to Unix epoch + RETENTION_SECONDS.
 * Returns undefined if the input is falsy or unparseable; the caller
 * should then omit the TTL attribute from the item.
 */
function ttlEpoch(dateStr: string | null | undefined): number | undefined {
  if (!dateStr) return undefined;
  const ms = Date.parse(dateStr);
  if (!Number.isFinite(ms)) return undefined;
  return Math.floor(ms / 1000) + RETENTION_SECONDS;
}

// ── Key helpers ────────────────────────────────────────────────────────────────

function pk(userId: string): string { return `USER#${userId}`; }
function sk(tokenId: string): string { return `TOKEN#${tokenId}`; }

/** The entityType value used on TOKEN items for GSI-TokenHash SK. */
function entityTypeForToken(userId: string): string { return `TOKEN#${userId}`; }

// ── Item conversion ───────────────────────────────────────────────────────────

function itemToRecord(item: Record<string, AttributeValue>): TokenRecord {
  return {
    id: getString(item, 'id') ?? '',
    user_id: getString(item, 'userId') ?? '',
    name: getString(item, 'name') ?? '',
    token_hash: getString(item, 'tokenHash') ?? '',
    prefix: getString(item, 'prefix') ?? '',
    scope: getString(item, 'scope') ?? 'read',
    scopes: getString(item, 'scopes'),
    project_id: getString(item, 'projectId'),
    workflow_id: getString(item, 'workflowId'),
    expires_at: getString(item, 'expiresAt') ?? '',
    last_used_at: getString(item, 'lastUsedAt'),
    revoked_at: getString(item, 'revokedAt'),
    created_at: getString(item, 'createdAt') ?? '',
  };
}

function recordToItem(r: TokenRecord): Record<string, AttributeValue> {
  const item: Record<string, JsVal> = {
    PK: pk(r.user_id),
    SK: sk(r.id),
    id: r.id,
    userId: r.user_id,
    name: r.name,
    tokenHash: r.token_hash,
    entityType: entityTypeForToken(r.user_id),
    prefix: r.prefix,
    scope: r.scope,
    expiresAt: r.expires_at,
    expiresAtEpoch: ttlEpoch(r.expires_at),
    createdAt: r.created_at,
  };
  if (r.scopes != null) item.scopes = r.scopes;
  if (r.project_id != null) item.projectId = r.project_id;
  if (r.workflow_id != null) item.workflowId = r.workflow_id;
  if (r.last_used_at != null) item.lastUsedAt = r.last_used_at;
  if (r.revoked_at != null) item.revokedAt = r.revoked_at;
  return marshalItem(item);
}

/**
 * Convert a TOKEN_INDEX item to TokenWithUserMeta.
 * token_hash and last_used_at are not stored in the index; they are
 * returned as empty string and null respectively.
 */
function indexItemToTokenWithUserMeta(item: Record<string, AttributeValue>): TokenWithUserMeta {
  return {
    id: getString(item, 'id') ?? '',
    user_id: getString(item, 'userId') ?? '',
    name: getString(item, 'name') ?? '',
    token_hash: '',
    prefix: getString(item, 'prefix') ?? '',
    scope: getString(item, 'scope') ?? 'read',
    scopes: getString(item, 'scopes'),
    project_id: getString(item, 'projectId'),
    workflow_id: null,
    expires_at: getString(item, 'expiresAt') ?? '',
    last_used_at: null,
    revoked_at: getString(item, 'revokedAt'),
    created_at: getString(item, 'createdAt') ?? '',
    user_name: getString(item, 'userName') ?? '',
    user_email: getString(item, 'userEmail') ?? '',
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** True when the token's scopes include 'delegate'. */
function isDelegate(record: TokenRecord): boolean {
  if (!record.scopes) return false;
  try { return (JSON.parse(record.scopes) as string[]).includes('delegate'); }
  catch { return false; }
}

/** Load user meta fields needed for getByHash and TOKEN_INDEX denormalization. */
async function loadUser(
  client: DynamoDBClient,
  tableName: string,
  userId: string,
): Promise<{ user_email: string; user_name: string; user_is_admin: number; user_disabled: number } | null> {
  const resp = await client.send(
    new GetItemCommand({
      TableName: tableName,
      Key: { PK: { S: `USER#${userId}` }, SK: { S: '#META' } },
    }),
  );
  if (!resp.Item) return null;
  return {
    user_email: getString(resp.Item, 'email') ?? '',
    user_name: getString(resp.Item, 'name') ?? '',
    user_is_admin: getNumber(resp.Item, 'isAdmin'),
    user_disabled: getNumber(resp.Item, 'disabled'),
  };
}

// ── DynamoDB Local table bootstrap (for tests) ────────────────────────────────

/**
 * Ensure the table and GSI-TokenHash index exist.
 * Idempotent — safe to call multiple times with the same table name.
 * Intended for test setup against DynamoDB Local.
 */
export async function ensureTableExists(client: DynamoDBClient, tableName: string): Promise<void> {
  try {
    await client.send(new DescribeTableCommand({ TableName: tableName }));
    return;
  } catch (e: unknown) {
    if (!(e instanceof ResourceNotFoundException)) throw e;
  }

  try {
    await client.send(
      new CreateTableCommand({
        TableName: tableName,
        KeySchema: [
          { AttributeName: 'PK', KeyType: 'HASH' },
          { AttributeName: 'SK', KeyType: 'RANGE' },
        ],
        AttributeDefinitions: [
          { AttributeName: 'PK', AttributeType: 'S' },
          { AttributeName: 'SK', AttributeType: 'S' },
          { AttributeName: 'tokenHash', AttributeType: 'S' },
          { AttributeName: 'entityType', AttributeType: 'S' },
        ],
        GlobalSecondaryIndexes: [
          {
            IndexName: 'GSI-TokenHash',
            KeySchema: [
              { AttributeName: 'tokenHash', KeyType: 'HASH' },
              { AttributeName: 'entityType', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'ALL' },
          },
        ],
        BillingMode: 'PAY_PER_REQUEST',
      }),
    );
  } catch (e: unknown) {
    if (!(e instanceof ResourceInUseException)) throw e;
  }
}

// ── Implementation ─────────────────────────────────────────────────────────────

export class DynamoDbApiTokenRepository implements ApiTokenRepository {
  private readonly client: DynamoDBClient;
  private readonly tableName: string;

  constructor(opts?: { client?: DynamoDBClient; tableName?: string }) {
    this.client = opts?.client ?? getDynamoDbClient();
    this.tableName =
      opts?.tableName ??
      process.env.DYNAMODB_TABLE_PORTAL_USERS ??
      'portal-users';
  }

  async create(input: CreateTokenInput): Promise<TokenRecord> {
    const record: TokenRecord = {
      id: input.id,
      user_id: input.user_id,
      name: input.name,
      token_hash: input.token_hash,
      prefix: input.prefix,
      scope: input.scope,
      scopes: input.scopes,
      project_id: input.project_id,
      workflow_id: input.workflow_id ?? null,
      expires_at: input.expires_at,
      last_used_at: null,
      revoked_at: null,
      created_at: input.created_at,
    };

    await this.client.send(
      new PutItemCommand({
        TableName: this.tableName,
        Item: recordToItem(record),
        ConditionExpression: 'attribute_not_exists(PK)',
      }),
    );

    if (!isDelegate(record)) {
      await this.writeTokenIndexEntry(record);
    }

    return record;
  }

  /**
   * Write a TOKEN_INDEX entry for admin listAll().
   * Not called for delegate tokens — they are excluded from the admin list.
   */
  private async writeTokenIndexEntry(record: TokenRecord): Promise<void> {
    const user = await loadUser(this.client, this.tableName, record.user_id);
    const indexSk = `${record.created_at}#${record.id}`;

    const itemData: Record<string, JsVal> = {
      PK: 'TOKEN_INDEX',
      SK: indexSk,
      id: record.id,
      userId: record.user_id,
      userName: user?.user_name ?? '',
      userEmail: user?.user_email ?? '',
      name: record.name,
      prefix: record.prefix,
      scope: record.scope,
      createdAt: record.created_at,
      expiresAt: record.expires_at,
      expiresAtEpoch: ttlEpoch(record.expires_at),
    };
    if (record.scopes != null) itemData.scopes = record.scopes;
    if (record.project_id != null) itemData.projectId = record.project_id;

    await this.client.send(
      new PutItemCommand({
        TableName: this.tableName,
        Item: marshalItem(itemData),
      }),
    );
  }

  async getByIdAndUser(id: string, userId: string): Promise<TokenRecord | null> {
    const resp = await this.client.send(
      new GetItemCommand({
        TableName: this.tableName,
        Key: {
          PK: { S: pk(userId) },
          SK: { S: sk(id) },
        },
      }),
    );
    if (!resp.Item) return null;
    return itemToRecord(resp.Item);
  }

  async getByHash(hash: string): Promise<TokenWithUser | null> {
    const resp = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: 'GSI-TokenHash',
        KeyConditionExpression: 'tokenHash = :h AND begins_with(entityType, :prefix)',
        ExpressionAttributeValues: marshalItem({
          ':h': hash,
          ':prefix': 'TOKEN#',
        }),
        Limit: 1,
      }),
    );

    const items = resp.Items ?? [];
    if (items.length === 0) return null;

    const record = itemToRecord(items[0]);
    const userFields = await loadUser(this.client, this.tableName, record.user_id);
    if (!userFields) return null;

    return { ...record, ...userFields };
  }

  async listByUser(userId: string): Promise<TokenRecord[]> {
    const items: TokenRecord[] = [];
    let lastKey: Record<string, AttributeValue> | undefined;

    do {
      const resp = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
          ExpressionAttributeValues: marshalItem({
            ':pk': pk(userId),
            ':prefix': 'TOKEN#',
          }),
          ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
        }),
      );
      for (const item of resp.Items ?? []) {
        items.push(itemToRecord(item));
      }
      lastKey = resp.LastEvaluatedKey;
    } while (lastKey);

    return items
      .filter((t) => !isDelegate(t))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, 50);
  }

  async listAll(): Promise<TokenWithUserMeta[]> {
    const result: TokenWithUserMeta[] = [];
    let lastKey: Record<string, AttributeValue> | undefined;

    do {
      const resp = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: 'PK = :pk',
          ExpressionAttributeValues: marshalItem({ ':pk': 'TOKEN_INDEX' }),
          ScanIndexForward: false,
          Limit: 200,
          ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
        }),
      );
      for (const item of resp.Items ?? []) {
        if (result.length >= 200) break;
        result.push(indexItemToTokenWithUserMeta(item));
      }
      lastKey = result.length >= 200 ? undefined : resp.LastEvaluatedKey;
    } while (lastKey);

    return result;
  }

  async countActive(userId: string): Promise<number> {
    const now = new Date().toISOString();
    let count = 0;
    let lastKey: Record<string, AttributeValue> | undefined;

    do {
      const resp = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
          FilterExpression: 'attribute_not_exists(revokedAt) AND expiresAt >= :now',
          ExpressionAttributeValues: marshalItem({
            ':pk': pk(userId),
            ':prefix': 'TOKEN#',
            ':now': now,
          }),
          Select: 'COUNT',
          ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
        }),
      );
      count += resp.Count ?? 0;
      lastKey = resp.LastEvaluatedKey;
    } while (lastKey);

    return count;
  }

  async updateLastUsed(id: string, userId: string, ts: string): Promise<void> {
    await this.client.send(
      new UpdateItemCommand({
        TableName: this.tableName,
        Key: {
          PK: { S: pk(userId) },
          SK: { S: sk(id) },
        },
        UpdateExpression: 'SET lastUsedAt = :ts',
        ExpressionAttributeValues: marshalItem({ ':ts': ts }),
      }),
    );
  }

  async revoke(id: string, userId: string, ts: string): Promise<void> {
    const ttl = ttlEpoch(ts);

    const exprVals: Record<string, JsVal> = { ':ts': ts };
    let updateExpr = 'SET revokedAt = :ts';
    if (ttl !== undefined) {
      exprVals[':ttl'] = ttl;
      updateExpr += ', expiresAtEpoch = :ttl';
    }

    await this.client.send(
      new UpdateItemCommand({
        TableName: this.tableName,
        Key: {
          PK: { S: pk(userId) },
          SK: { S: sk(id) },
        },
        UpdateExpression: updateExpr,
        ExpressionAttributeValues: marshalItem(exprVals),
      }),
    );

    const token = await this.getByIdAndUser(id, userId);
    if (token && !isDelegate(token)) {
      const indexSk = `${token.created_at}#${id}`;
      try {
        await this.client.send(
          new UpdateItemCommand({
            TableName: this.tableName,
            Key: {
              PK: { S: 'TOKEN_INDEX' },
              SK: { S: indexSk },
            },
            ConditionExpression: 'attribute_exists(PK)',
            UpdateExpression: updateExpr,
            ExpressionAttributeValues: marshalItem(exprVals),
          }),
        );
      } catch (e: unknown) {
        if (!(e instanceof ConditionalCheckFailedException)) throw e;
        // TOKEN_INDEX entry doesn't exist — safe to ignore (pre-existing token
        // or item created before this implementation).
      }
    }
  }

  /** Expose internals for test setup (ensureTableExists, seeding). */
  getClient(): DynamoDBClient { return this.client; }
  getTableName(): string { return this.tableName; }
}
