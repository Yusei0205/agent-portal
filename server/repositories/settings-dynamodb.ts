/**
 * DynamoDB implementation of SettingsRepository.
 *
 * Table: portal-config  (env DYNAMODB_TABLE_PORTAL_CONFIG, default 'portal-config')
 *
 * Key schema:
 *   Settings:   PK=SETTINGS  SK=K#<key>    item: { value: S }
 *   Version:    PK=SETTINGS  SK=_VERSION   item: { version: N }
 *   Secrets:    PK=SECRET    SK=K#<name>   item: { value: S, hint: S, updatedAt: S }
 *
 * Every mutating settings operation (setKey, setKeys, deleteKey, deleteKeys) is
 * wrapped in a TransactWriteItems call that also increments version by 1 via
 * ADD so other Lambda instances can detect a stale snapshot cheaply via getVersion().
 *
 * Secrets operations are independent PutItem / GetItem / DeleteItem calls and
 * do NOT bump the settings version counter (secrets are not part of the snapshot).
 *
 * TransactWriteItems limit: 100 items.  The portal has far fewer settings keys
 * than that, so one transaction per setKeys call is safe.
 *
 * ConsistentRead=true is used for getVersion() and loadSnapshot() to ensure
 * Lambda instances see the latest writes immediately.
 */

import {
  GetItemCommand,
  PutItemCommand,
  DeleteItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
  CreateTableCommand,
  DescribeTableCommand,
  ResourceNotFoundException,
  ResourceInUseException,
} from '@aws-sdk/client-dynamodb';
import type { DynamoDBClient, AttributeValue } from '@aws-sdk/client-dynamodb';
import { getDynamoDbClient, marshalItem, getString, getNumber } from './dynamo-client.ts';
import type { SettingsRepository, SecretRecord } from './settings.ts';

// ── Table bootstrap (shared with other portal-config users) ──────────────────

export { ensureConfigTableExists } from './permissions-dynamodb.ts';

// ── Implementation ─────────────────────────────────────────────────────────────

export class DynamoDbSettingsRepository implements SettingsRepository {
  private readonly client: DynamoDBClient;
  private readonly tableName: string;

  constructor(opts?: { client?: DynamoDBClient; tableName?: string }) {
    this.client = opts?.client ?? getDynamoDbClient();
    this.tableName =
      opts?.tableName ??
      process.env.DYNAMODB_TABLE_PORTAL_CONFIG ??
      'portal-config';
  }

  // ── Settings ────────────────────────────────────────────────────────────────

  async getKey(key: string): Promise<string | null> {
    const resp = await this.client.send(
      new GetItemCommand({
        TableName: this.tableName,
        Key: marshalItem({ PK: 'SETTINGS', SK: `K#${key}` }),
        ConsistentRead: true,
      }),
    );
    if (!resp.Item) return null;
    return getString(resp.Item, 'value');
  }

  async setKey(key: string, value: string): Promise<void> {
    await this.client.send(
      new TransactWriteItemsCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.tableName,
              Item: marshalItem({ PK: 'SETTINGS', SK: `K#${key}`, value }),
            },
          },
          {
            Update: {
              TableName: this.tableName,
              Key: marshalItem({ PK: 'SETTINGS', SK: '_VERSION' }),
              UpdateExpression: 'ADD #v :inc',
              ExpressionAttributeNames: { '#v': 'version' },
              ExpressionAttributeValues: { ':inc': { N: '1' } },
            },
          },
        ],
      }),
    );
  }

  async setKeys(pairs: Array<[string, string]>): Promise<void> {
    if (pairs.length === 0) return;
    await this.client.send(
      new TransactWriteItemsCommand({
        TransactItems: [
          ...pairs.map(([key, value]) => ({
            Put: {
              TableName: this.tableName,
              Item: marshalItem({ PK: 'SETTINGS', SK: `K#${key}`, value }),
            },
          })),
          {
            Update: {
              TableName: this.tableName,
              Key: marshalItem({ PK: 'SETTINGS', SK: '_VERSION' }),
              UpdateExpression: 'ADD #v :inc',
              ExpressionAttributeNames: { '#v': 'version' },
              ExpressionAttributeValues: { ':inc': { N: '1' } },
            },
          },
        ],
      }),
    );
  }

  async deleteKey(key: string): Promise<void> {
    await this.client.send(
      new TransactWriteItemsCommand({
        TransactItems: [
          {
            Delete: {
              TableName: this.tableName,
              Key: marshalItem({ PK: 'SETTINGS', SK: `K#${key}` }),
            },
          },
          {
            Update: {
              TableName: this.tableName,
              Key: marshalItem({ PK: 'SETTINGS', SK: '_VERSION' }),
              UpdateExpression: 'ADD #v :inc',
              ExpressionAttributeNames: { '#v': 'version' },
              ExpressionAttributeValues: { ':inc': { N: '1' } },
            },
          },
        ],
      }),
    );
  }

  async deleteKeys(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    await this.client.send(
      new TransactWriteItemsCommand({
        TransactItems: [
          ...keys.map((key) => ({
            Delete: {
              TableName: this.tableName,
              Key: marshalItem({ PK: 'SETTINGS', SK: `K#${key}` }),
            },
          })),
          {
            Update: {
              TableName: this.tableName,
              Key: marshalItem({ PK: 'SETTINGS', SK: '_VERSION' }),
              UpdateExpression: 'ADD #v :inc',
              ExpressionAttributeNames: { '#v': 'version' },
              ExpressionAttributeValues: { ':inc': { N: '1' } },
            },
          },
        ],
      }),
    );
  }

  async loadSnapshot(): Promise<{ version: number; keys: Map<string, string> }> {
    const allItems: Array<Record<string, AttributeValue>> = [];
    let lastKey: Record<string, AttributeValue> | undefined;
    do {
      const resp = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: 'PK = :pk',
          ExpressionAttributeValues: marshalItem({ ':pk': 'SETTINGS' }),
          ConsistentRead: true,
          ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
        }),
      );
      allItems.push(...(resp.Items ?? []));
      lastKey = resp.LastEvaluatedKey;
    } while (lastKey);

    const keys = new Map<string, string>();
    let version = 0;
    for (const item of allItems) {
      const sk = getString(item, 'SK') ?? '';
      if (sk === '_VERSION') {
        version = getNumber(item, 'version');
      } else if (sk.startsWith('K#')) {
        const key = sk.slice(2);
        const val = getString(item, 'value');
        if (val !== null) keys.set(key, val);
      }
    }
    return { version, keys };
  }

  async getVersion(): Promise<number> {
    const resp = await this.client.send(
      new GetItemCommand({
        TableName: this.tableName,
        Key: marshalItem({ PK: 'SETTINGS', SK: '_VERSION' }),
        ConsistentRead: true,
      }),
    );
    if (!resp.Item) return 0;
    return getNumber(resp.Item, 'version');
  }

  // ── Secrets ─────────────────────────────────────────────────────────────────

  async setSecret(
    name: string,
    encryptedValue: string,
    hint: string | null,
    updatedAt: string,
  ): Promise<void> {
    await this.client.send(
      new PutItemCommand({
        TableName: this.tableName,
        Item: marshalItem({
          PK: 'SECRET',
          SK: `K#${name}`,
          value: encryptedValue,
          hint: hint ?? undefined,
          updatedAt,
        }),
      }),
    );
  }

  async getSecret(name: string): Promise<SecretRecord | null> {
    const resp = await this.client.send(
      new GetItemCommand({
        TableName: this.tableName,
        Key: marshalItem({ PK: 'SECRET', SK: `K#${name}` }),
        ConsistentRead: true,
      }),
    );
    if (!resp.Item) return null;
    return {
      name,
      value: getString(resp.Item, 'value') ?? '',
      hint: getString(resp.Item, 'hint'),
      updatedAt: getString(resp.Item, 'updatedAt') ?? '',
    };
  }

  async deleteSecret(name: string): Promise<void> {
    await this.client.send(
      new DeleteItemCommand({
        TableName: this.tableName,
        Key: marshalItem({ PK: 'SECRET', SK: `K#${name}` }),
      }),
    );
  }

  // ── Test helpers ──────────────────────────────────────────────────────────

  getClient(): DynamoDBClient { return this.client; }
  getTableName(): string { return this.tableName; }
}
