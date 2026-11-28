import { getDb } from '../db.ts';
import { usesDynamoDb } from './backend.ts';

export interface CodexConnection { ciphertext: string; version: number }
export interface CodexAttempt { ciphertext: string; expiresAt: number }
export interface CodexStore {
  get(userId: string): Promise<CodexConnection | null>;
  put(userId: string, ciphertext: string, expectedVersion: number): Promise<boolean>;
  remove(userId: string, version: number): Promise<boolean>;
  lock(userId: string, owner: string, now: number, until: number): Promise<boolean>;
  unlock(userId: string, owner: string): Promise<void>;
  createAttempt(userId: string, stateHash: string, value: CodexAttempt): Promise<void>;
  consumeAttempt(userId: string, stateHash: string, now: number): Promise<CodexAttempt | null>;
}

/** All OAuth state and token writes are atomic across Lambda instances, not process-local maps. */
export class SqliteCodexStore implements CodexStore {
  async get(userId: string): Promise<CodexConnection | null> {
    return getDb().prepare('SELECT ciphertext, version FROM codex_connections WHERE user_id = ?').get(userId) as unknown as CodexConnection ?? null;
  }
  async put(userId: string, ciphertext: string, expected: number): Promise<boolean> {
    if (!expected) return Number(getDb().prepare('INSERT OR IGNORE INTO codex_connections (user_id, ciphertext, version) VALUES (?, ?, 1)').run(userId, ciphertext).changes) === 1;
    return Number(getDb().prepare('UPDATE codex_connections SET ciphertext = ?, version = version + 1 WHERE user_id = ? AND version = ?').run(ciphertext, userId, expected).changes) === 1;
  }
  async remove(userId: string, version: number): Promise<boolean> {
    // Retain a credential-free generation so an earlier callback cannot overwrite a later reconnect.
    return Number(getDb().prepare("UPDATE codex_connections SET ciphertext = '', version = version + 1, lease_owner = NULL, lease_until = 0 WHERE user_id = ? AND version = ?").run(userId, version).changes) === 1;
  }
  async lock(userId: string, owner: string, now: number, until: number): Promise<boolean> {
    return Number(getDb().prepare("UPDATE codex_connections SET lease_owner = ?, lease_until = ? WHERE user_id = ? AND ciphertext <> '' AND lease_until < ?").run(owner, until, userId, now).changes) === 1;
  }
  async unlock(userId: string, owner: string): Promise<void> {
    getDb().prepare('UPDATE codex_connections SET lease_owner = NULL, lease_until = 0 WHERE user_id = ? AND lease_owner = ?').run(userId, owner);
  }
  async createAttempt(userId: string, hash: string, value: CodexAttempt): Promise<void> {
    getDb().prepare('DELETE FROM codex_oauth_attempts WHERE expires_at < ?').run(Date.now());
    getDb().prepare('INSERT INTO codex_oauth_attempts (user_id, state_hash, ciphertext, expires_at) VALUES (?, ?, ?, ?)').run(userId, hash, value.ciphertext, value.expiresAt);
  }
  async consumeAttempt(userId: string, hash: string, now: number): Promise<CodexAttempt | null> {
    const row = getDb().prepare('DELETE FROM codex_oauth_attempts WHERE user_id = ? AND state_hash = ? RETURNING ciphertext, expires_at AS expiresAt').get(userId, hash) as unknown as CodexAttempt | undefined;
    return row && row.expiresAt > now ? row : null;
  }
}

export class DynamoCodexStore implements CodexStore {
  constructor(private client: { send(command: any): Promise<any> }, private table: string) {}
  private key(userId: string, sk = 'CODEX#ACCOUNT') { return { PK: { S: 'USER#' + userId }, SK: { S: sk } }; }
  private async conditional(command: any): Promise<boolean> {
    try { await this.client.send(command); return true; }
    catch (e) { if ((e as Error).name === 'ConditionalCheckFailedException') return false; throw e; }
  }
  async get(userId: string): Promise<CodexConnection | null> {
    const { GetItemCommand } = await import('@aws-sdk/client-dynamodb');
    const result = await this.client.send(new GetItemCommand({ TableName: this.table, Key: this.key(userId), ConsistentRead: true }));
    return result.Item ? { ciphertext: result.Item.ciphertext.S, version: Number(result.Item.version.N) } : null;
  }
  async put(userId: string, ciphertext: string, expected: number): Promise<boolean> {
    const { UpdateItemCommand } = await import('@aws-sdk/client-dynamodb');
    return this.conditional(new UpdateItemCommand({ TableName: this.table, Key: this.key(userId),
      UpdateExpression: 'SET ciphertext = :ciphertext, #version = :next',
      ConditionExpression: expected ? '#version = :expected' : 'attribute_not_exists(#version)',
      ExpressionAttributeNames: { '#version': 'version' },
      ExpressionAttributeValues: { ':ciphertext': { S: ciphertext }, ':next': { N: String(expected + 1) }, ...(expected ? { ':expected': { N: String(expected) } } : {}) },
    }));
  }
  async remove(userId: string, version: number): Promise<boolean> {
    const { UpdateItemCommand } = await import('@aws-sdk/client-dynamodb');
    return this.conditional(new UpdateItemCommand({ TableName: this.table, Key: this.key(userId), ConditionExpression: '#version = :v',
      UpdateExpression: 'SET ciphertext = :empty, #version = :next REMOVE leaseOwner, leaseUntil',
      ExpressionAttributeNames: { '#version': 'version' }, ExpressionAttributeValues: { ':v': { N: String(version) }, ':next': { N: String(version + 1) }, ':empty': { S: '' } } }));
  }
  async lock(userId: string, owner: string, now: number, until: number): Promise<boolean> {
    const { UpdateItemCommand } = await import('@aws-sdk/client-dynamodb');
    return this.conditional(new UpdateItemCommand({ TableName: this.table, Key: this.key(userId),
      UpdateExpression: 'SET leaseOwner = :owner, leaseUntil = :until',
      ConditionExpression: 'attribute_exists(ciphertext) AND ciphertext <> :empty AND (attribute_not_exists(leaseUntil) OR leaseUntil < :now)',
      ExpressionAttributeValues: { ':owner': { S: owner }, ':until': { N: String(until) }, ':now': { N: String(now) }, ':empty': { S: '' } },
    }));
  }
  async unlock(userId: string, owner: string): Promise<void> {
    const { UpdateItemCommand } = await import('@aws-sdk/client-dynamodb');
    await this.conditional(new UpdateItemCommand({ TableName: this.table, Key: this.key(userId),
      UpdateExpression: 'REMOVE leaseOwner, leaseUntil', ConditionExpression: 'leaseOwner = :owner',
      ExpressionAttributeValues: { ':owner': { S: owner } },
    }));
  }
  async createAttempt(userId: string, hash: string, value: CodexAttempt): Promise<void> {
    const { PutItemCommand } = await import('@aws-sdk/client-dynamodb');
    await this.client.send(new PutItemCommand({ TableName: this.table, Item: { ...this.key(userId, 'CODEX#OAUTH#' + hash),
      ciphertext: { S: value.ciphertext }, expiresAtEpoch: { N: String(Math.floor(value.expiresAt / 1000)) } }, ConditionExpression: 'attribute_not_exists(PK)' }));
  }
  async consumeAttempt(userId: string, hash: string, now: number): Promise<CodexAttempt | null> {
    const { DeleteItemCommand } = await import('@aws-sdk/client-dynamodb');
    try {
      const result = await this.client.send(new DeleteItemCommand({ TableName: this.table, Key: this.key(userId, 'CODEX#OAUTH#' + hash),
        ConditionExpression: 'expiresAtEpoch > :now', ExpressionAttributeValues: { ':now': { N: String(Math.floor(now / 1000)) } }, ReturnValues: 'ALL_OLD' }));
      return result.Attributes ? { ciphertext: result.Attributes.ciphertext.S, expiresAt: Number(result.Attributes.expiresAtEpoch.N) * 1000 } : null;
    } catch (e) { if ((e as Error).name === 'ConditionalCheckFailedException') return null; throw e; }
  }
}

let override: CodexStore | null = null;
export function setCodexStoreForTests(store: CodexStore | null): void { override = store; }
export async function getCodexStore(): Promise<CodexStore> {
  if (override) return override;
  if (!usesDynamoDb()) return new SqliteCodexStore();
  const { getDynamoDbClient } = await import('./dynamo-client.ts');
  return new DynamoCodexStore(getDynamoDbClient(), process.env.DYNAMODB_TABLE_PORTAL_USERS || 'portal-users');
}
