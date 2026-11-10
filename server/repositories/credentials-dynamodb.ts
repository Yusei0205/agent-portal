/**
 * DynamoDB implementation of CredentialsRepository.
 *
 * Table: portal-users  (DYNAMODB_TABLE_PORTAL_USERS, default 'portal-users')
 *
 * Key design:
 *   PK=USER#<userId>   SK=CRED#<credId>   → main credential item
 *   PK=CRED#<credId>   SK=#LOOKUP         → userId pointer for C1 (getById)
 *
 * No GSI needed: lookup by credId uses the CRED# pointer item (2 GetItems).
 * Writes are done in parallel (not transactional) — last write wins on
 * concurrent updates, which matches the SQLite single-process behaviour.
 *
 * updated_by_name: not stored in DynamoDB (no join support). Always null.
 */

import {
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  DeleteItemCommand,
  QueryCommand,
} from '@aws-sdk/client-dynamodb';
import type { AttributeValue, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { getDynamoDbClient, marshalItem, getString, getNumber, av } from './dynamo-client.ts';
import type {
  CredentialsRepository,
  CredentialRecord,
  CreateCredentialInput,
  UpdateCredentialFields,
} from './credentials.ts';

// ── Table name ────────────────────────────────────────────────────────────────

function table(): string {
  return process.env.DYNAMODB_TABLE_PORTAL_USERS ?? 'portal-users';
}

// ── Key builders ──────────────────────────────────────────────────────────────

function mainKey(userId: string, credId: string) {
  return { PK: av(`USER#${userId}`), SK: av(`CRED#${credId}`) };
}

function lookupKey(credId: string) {
  return { PK: av(`CRED#${credId}`), SK: av('#LOOKUP') };
}

// ── Row converter ─────────────────────────────────────────────────────────────

function itemToRecord(item: Record<string, AttributeValue>): CredentialRecord {
  return {
    id: getString(item, 'id') ?? '',
    user_id: getString(item, 'user_id') ?? '',
    engine: getString(item, 'engine') ?? '',
    name: getString(item, 'name') ?? '',
    mode: getString(item, 'mode') ?? '',
    secret_enc: getString(item, 'secret_enc'),
    extra_config: getString(item, 'extra_config') ?? '{}',
    is_default: getNumber(item, 'is_default'),
    last4: getString(item, 'last4') ?? '',
    created_at: getString(item, 'created_at') ?? '',
    updated_at: getString(item, 'updated_at') ?? '',
    updated_by: getString(item, 'updated_by'),
    updated_by_name: null, // no join in DynamoDB
  };
}

// ── Table setup (for tests) ───────────────────────────────────────────────────

export async function ensureCredentialsTableExists(client: DynamoDBClient): Promise<void> {
  const { CreateTableCommand, DescribeTableCommand } = await import('@aws-sdk/client-dynamodb');
  const tableName = table();
  try {
    await client.send(new DescribeTableCommand({ TableName: tableName }));
  } catch (e: unknown) {
    if ((e as { name?: string }).name !== 'ResourceNotFoundException') throw e;
    await client.send(new CreateTableCommand({
      TableName: tableName,
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' },
        { AttributeName: 'SK', AttributeType: 'S' },
      ],
    }));
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 300));
      const desc = await client.send(new DescribeTableCommand({ TableName: tableName }));
      if (desc.Table?.TableStatus === 'ACTIVE') break;
    }
  }
}

// ── Implementation ────────────────────────────────────────────────────────────

export class DynamoDbCredentialsRepository implements CredentialsRepository {
  private readonly client: DynamoDBClient;
  constructor() { this.client = getDynamoDbClient(); }

  // Test helper
  async ensureTables(): Promise<void> {
    await ensureCredentialsTableExists(this.client);
  }

  async getById(id: string): Promise<CredentialRecord | null> {
    // Step 1: get the lookup pointer to find userId
    const lookup = await this.client.send(new GetItemCommand({
      TableName: table(),
      Key: lookupKey(id),
    }));
    if (!lookup.Item) return null;
    const userId = getString(lookup.Item, 'user_id') ?? '';
    if (!userId) return null;
    // Step 2: get the full item
    return this.getByIdAndUser(id, userId);
  }

  async getByIdAndUser(id: string, userId: string): Promise<CredentialRecord | null> {
    const res = await this.client.send(new GetItemCommand({
      TableName: table(),
      Key: mainKey(userId, id),
    }));
    return res.Item ? itemToRecord(res.Item) : null;
  }

  async getDefaultByUserAndEngine(userId: string, engine: string): Promise<CredentialRecord | null> {
    const res = await this.client.send(new QueryCommand({
      TableName: table(),
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      FilterExpression: '#eng = :eng AND is_default = :one',
      ExpressionAttributeNames: { '#eng': 'engine' },
      ExpressionAttributeValues: {
        ':pk': av(`USER#${userId}`),
        ':prefix': av('CRED#'),
        ':eng': av(engine),
        ':one': { N: '1' },
      },
    }));
    const item = res.Items?.[0];
    return item ? itemToRecord(item) : null;
  }

  async listByUser(userId: string): Promise<CredentialRecord[]> {
    const res = await this.client.send(new QueryCommand({
      TableName: table(),
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: {
        ':pk': av(`USER#${userId}`),
        ':prefix': av('CRED#'),
      },
    }));
    const records = (res.Items ?? []).map(itemToRecord);
    // Sort: engine asc, is_default desc, created_at asc
    records.sort((a, b) => {
      if (a.engine !== b.engine) return a.engine.localeCompare(b.engine);
      if (a.is_default !== b.is_default) return b.is_default - a.is_default;
      return a.created_at.localeCompare(b.created_at);
    });
    return records;
  }

  async create(input: CreateCredentialInput): Promise<CredentialRecord> {
    const item: Record<string, AttributeValue> = {
      ...mainKey(input.user_id, input.id),
      ...marshalItem({
        id: input.id,
        user_id: input.user_id,
        engine: input.engine,
        name: input.name,
        mode: input.mode,
        secret_enc: input.secret_enc,
        extra_config: input.extra_config,
        is_default: input.is_default,
        last4: input.last4,
        created_at: input.created_at,
        updated_at: input.updated_at,
        updated_by: input.updated_by,
      }),
    };
    // Write main item + lookup pointer in parallel
    await Promise.all([
      this.client.send(new PutItemCommand({ TableName: table(), Item: item })),
      this.client.send(new PutItemCommand({
        TableName: table(),
        Item: {
          ...lookupKey(input.id),
          ...marshalItem({ user_id: input.user_id, id: input.id }),
        },
      })),
    ]);
    return itemToRecord(item);
  }

  async update(id: string, fields: UpdateCredentialFields): Promise<CredentialRecord | null> {
    const cred = await this.getById(id);
    if (!cred) return null;
    const expr: string[] = [];
    const names: Record<string, string> = {};
    const vals: Record<string, AttributeValue> = {};
    if (fields.name !== undefined) { expr.push('#nm = :nm'); names['#nm'] = 'name'; vals[':nm'] = av(fields.name); }
    if (fields.secret_enc !== undefined) { expr.push('secret_enc = :se'); vals[':se'] = av(fields.secret_enc); }
    if (fields.extra_config !== undefined) { expr.push('extra_config = :ec'); vals[':ec'] = av(fields.extra_config); }
    if (fields.is_default !== undefined) { expr.push('is_default = :isd'); vals[':isd'] = { N: String(fields.is_default) }; }
    if (fields.last4 !== undefined) { expr.push('last4 = :l4'); vals[':l4'] = av(fields.last4); }
    if (fields.updated_at !== undefined) { expr.push('updated_at = :ua'); vals[':ua'] = av(fields.updated_at); }
    if (fields.updated_by !== undefined) { expr.push('updated_by = :ub'); vals[':ub'] = av(fields.updated_by); }
    if (expr.length === 0) return cred;
    await this.client.send(new UpdateItemCommand({
      TableName: table(),
      Key: mainKey(cred.user_id, id),
      UpdateExpression: `SET ${expr.join(', ')}`,
      ExpressionAttributeNames: Object.keys(names).length > 0 ? names : undefined,
      ExpressionAttributeValues: vals,
    }));
    return this.getByIdAndUser(id, cred.user_id);
  }

  async updateToken(
    id: string,
    secretEnc: string,
    extraConfig: string,
    last4: string,
    updatedAt: string,
  ): Promise<void> {
    const cred = await this.getById(id);
    if (!cred) return;
    await this.client.send(new UpdateItemCommand({
      TableName: table(),
      Key: mainKey(cred.user_id, id),
      UpdateExpression: 'SET secret_enc = :se, extra_config = :ec, last4 = :l4, updated_at = :ua',
      ExpressionAttributeValues: {
        ':se': av(secretEnc),
        ':ec': av(extraConfig),
        ':l4': av(last4),
        ':ua': av(updatedAt),
      },
    }));
  }

  async updateTokenConditional(
    id: string,
    secretEnc: string,
    extraConfig: string,
    last4: string,
    updatedAt: string,
    expectedCiphertext: string,
  ): Promise<boolean> {
    const cred = await this.getById(id);
    if (!cred) return false;
    try {
      await this.client.send(new UpdateItemCommand({
        TableName: table(),
        Key: mainKey(cred.user_id, id),
        UpdateExpression: 'SET secret_enc = :se, extra_config = :ec, last4 = :l4, updated_at = :ua',
        ConditionExpression: 'secret_enc = :expected',
        ExpressionAttributeValues: {
          ':se': av(secretEnc),
          ':ec': av(extraConfig),
          ':l4': av(last4),
          ':ua': av(updatedAt),
          ':expected': av(expectedCiphertext),
        },
      }));
      return true;
    } catch (e: unknown) {
      if ((e as { name?: string }).name === 'ConditionalCheckFailedException') return false;
      throw e;
    }
  }

  async updateExtraConfig(id: string, extraConfig: string, updatedAt: string): Promise<void> {
    const cred = await this.getById(id);
    if (!cred) return;
    await this.client.send(new UpdateItemCommand({
      TableName: table(),
      Key: mainKey(cred.user_id, id),
      UpdateExpression: 'SET extra_config = :ec, updated_at = :ua',
      ExpressionAttributeValues: { ':ec': av(extraConfig), ':ua': av(updatedAt) },
    }));
  }

  async clearDefaults(userId: string, engine: string): Promise<void> {
    const creds = await this.listByUser(userId);
    const toUpdate = creds.filter((c) => c.engine === engine && c.is_default === 1);
    await Promise.all(toUpdate.map((c) =>
      this.client.send(new UpdateItemCommand({
        TableName: table(),
        Key: mainKey(userId, c.id),
        UpdateExpression: 'SET is_default = :zero',
        ExpressionAttributeValues: { ':zero': { N: '0' } },
      })),
    ));
  }

  async setDefault(id: string, updatedAt: string): Promise<void> {
    const cred = await this.getById(id);
    if (!cred) return;
    await this.client.send(new UpdateItemCommand({
      TableName: table(),
      Key: mainKey(cred.user_id, id),
      UpdateExpression: 'SET is_default = :one, updated_at = :ua',
      ExpressionAttributeValues: { ':one': { N: '1' }, ':ua': av(updatedAt) },
    }));
  }

  async delete(id: string): Promise<void> {
    const cred = await this.getById(id);
    if (!cred) return;
    await Promise.all([
      this.client.send(new DeleteItemCommand({
        TableName: table(),
        Key: mainKey(cred.user_id, id),
      })),
      this.client.send(new DeleteItemCommand({
        TableName: table(),
        Key: lookupKey(id),
      })),
    ]);
  }
}
