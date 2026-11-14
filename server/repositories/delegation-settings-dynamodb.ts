/**
 * DynamoDB implementation of DelegationSettingsRepository.
 *
 * Table: portal-config (DYNAMODB_TABLE_PORTAL_CONFIG, default 'portal-config')
 * Key schema:
 *   PK = SETTINGS   SK = K#delegation.<key>
 *
 * One DynamoDB item per delegation setting key. On get(), fetch all delegation
 * keys in a single Query then apply defaults for missing keys.
 */

import {
  PutItemCommand,
  QueryCommand,
  CreateTableCommand,
  DescribeTableCommand,
  ResourceNotFoundException,
  ResourceInUseException,
} from '@aws-sdk/client-dynamodb';
import type { DynamoDBClient, AttributeValue } from '@aws-sdk/client-dynamodb';
import {
  getDynamoDbClient,
  marshalItem,
  getString,
} from './dynamo-client.ts';
import type { DelegationSettingsRepository, DelegationSettings } from './delegation-settings.ts';
import { DELEGATION_DEFAULTS } from './delegation-settings.ts';
import { ensureConfigTableExists } from './permissions-dynamodb.ts';

export { ensureConfigTableExists };

// ── Implementation ─────────────────────────────────────────────────────────────

export class DynamoDbDelegationSettingsRepository implements DelegationSettingsRepository {
  private readonly client: DynamoDBClient;
  private readonly tableName: string;

  constructor(opts?: { client?: DynamoDBClient; tableName?: string }) {
    this.client = opts?.client ?? getDynamoDbClient();
    this.tableName =
      opts?.tableName ??
      process.env.DYNAMODB_TABLE_PORTAL_CONFIG ??
      'portal-config';
  }

  async get(): Promise<DelegationSettings> {
    const items: Array<Record<string, AttributeValue>> = [];
    let lastKey: Record<string, AttributeValue> | undefined;
    do {
      const resp = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
          ExpressionAttributeValues: marshalItem({
            ':pk':     'SETTINGS',
            ':prefix': 'K#delegation.',
          }),
          ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
        }),
      );
      items.push(...(resp.Items ?? []));
      lastKey = resp.LastEvaluatedKey;
    } while (lastKey);

    const kvMap = new Map<string, string>();
    for (const item of items) {
      const sk = getString(item, 'SK') ?? '';
      const key = sk.replace('K#', '');  // e.g. 'delegation.enabled'
      const val = getString(item, 'value') ?? '';
      kvMap.set(key, val);
    }

    const out = { ...DELEGATION_DEFAULTS };

    const enabled = kvMap.get('delegation.enabled');
    if (enabled !== undefined) out.enabled = enabled === 'true';

    const maxParent = kvMap.get('delegation.maxRunningPerParent');
    if (maxParent !== undefined) {
      const v = parseInt(maxParent, 10);
      if (Number.isFinite(v)) out.maxRunningPerParent = Math.max(0, Math.min(10, v));
    }

    const maxUser = kvMap.get('delegation.maxRunningPerUser');
    if (maxUser !== undefined) {
      const v = parseInt(maxUser, 10);
      if (Number.isFinite(v)) out.maxRunningPerUser = Math.max(0, Math.min(20, v));
    }

    const idleStop = kvMap.get('delegation.idleStopMinutes');
    if (idleStop !== undefined) {
      const v = parseInt(idleStop, 10);
      if (Number.isFinite(v)) out.idleStopMinutes = Math.max(1, Math.min(240, v));
    }

    const allowNested = kvMap.get('delegation.allowNested');
    if (allowNested !== undefined) out.allowNested = allowNested === 'true';

    const nudge = kvMap.get('delegation.nudgeThreshold');
    if (nudge !== undefined) {
      const v = parseInt(nudge, 10);
      if (Number.isFinite(v)) out.nudgeThreshold = Math.max(0, Math.min(20, v));
    }

    return out;
  }

  async patch(settings: Partial<DelegationSettings>): Promise<void> {
    const entries: [string, string][] = [];
    if (settings.enabled !== undefined) entries.push(['delegation.enabled', String(settings.enabled)]);
    if (settings.maxRunningPerParent !== undefined) entries.push(['delegation.maxRunningPerParent', String(settings.maxRunningPerParent)]);
    if (settings.maxRunningPerUser !== undefined) entries.push(['delegation.maxRunningPerUser', String(settings.maxRunningPerUser)]);
    if (settings.idleStopMinutes !== undefined) entries.push(['delegation.idleStopMinutes', String(settings.idleStopMinutes)]);
    if (settings.allowNested !== undefined) entries.push(['delegation.allowNested', String(settings.allowNested)]);
    if (settings.nudgeThreshold !== undefined) entries.push(['delegation.nudgeThreshold', String(settings.nudgeThreshold)]);

    await Promise.all(
      entries.map(([key, value]) =>
        this.client.send(
          new PutItemCommand({
            TableName: this.tableName,
            Item: marshalItem({
              PK:    'SETTINGS',
              SK:    `K#${key}`,
              value,
            }),
          }),
        ),
      ),
    );
  }

  /** Expose internals for test setup. */
  getClient(): DynamoDBClient { return this.client; }
  getTableName(): string { return this.tableName; }
}
