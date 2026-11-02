/**
 * DynamoDB implementation of UserConfigRepository.
 *
 * user_config_state  → portal-users  PK=UCONF#<userId>  SK=FOLDER#<folder>
 * team_config_versions → portal-config PK=TEAMCFG#<folder> SK=VER#<publishedAt>#<id>
 *
 * Team config versions are kept in portal-config so admins can write them
 * without touching the per-user portal-users table.
 */

import {
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  QueryCommand,
} from '@aws-sdk/client-dynamodb';
import type { AttributeValue, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { getDynamoDbClient, marshalItem, getString, getNumber, av } from './dynamo-client.ts';
import type {
  UserConfigRepository,
  UserConfigStateRecord,
  TeamConfigVersionRecord,
  CreateTeamConfigVersionInput,
} from './user-config.ts';

function usersTable(): string {
  return process.env.DYNAMODB_TABLE_PORTAL_USERS ?? 'portal-users';
}

function configTable(): string {
  return process.env.DYNAMODB_TABLE_PORTAL_CONFIG ?? 'portal-config';
}

function stateKey(userId: string, folder: string) {
  return { PK: av(`UCONF#${userId}`), SK: av(`FOLDER#${folder}`) };
}

function versionKey(folder: string, publishedAt: string, id: string) {
  return { PK: av(`TEAMCFG#${folder}`), SK: av(`VER#${publishedAt}#${id}`) };
}

function itemToState(item: Record<string, AttributeValue>): UserConfigStateRecord {
  return {
    user_id: getString(item, 'user_id') ?? '',
    folder: getString(item, 'folder') ?? '',
    following: getNumber(item, 'following'),
    customised_at: getString(item, 'customised_at'),
    team_version_id: getString(item, 'team_version_id'),
  };
}

function itemToVersion(item: Record<string, AttributeValue>): TeamConfigVersionRecord {
  return {
    id: getString(item, 'id') ?? '',
    folder: getString(item, 'folder') ?? '',
    files_json: getString(item, 'files_json') ?? '[]',
    published_by: getString(item, 'published_by'),
    published_at: getString(item, 'published_at') ?? '',
  };
}

export async function ensureUserConfigTablesExist(client: DynamoDBClient): Promise<void> {
  const { CreateTableCommand, DescribeTableCommand } = await import('@aws-sdk/client-dynamodb');
  for (const tableName of [usersTable(), configTable()]) {
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
}

export class DynamoDbUserConfigRepository implements UserConfigRepository {
  private readonly client: DynamoDBClient;
  constructor() { this.client = getDynamoDbClient(); }

  async ensureTables(): Promise<void> {
    await ensureUserConfigTablesExist(this.client);
  }

  async getState(userId: string, folder: string): Promise<UserConfigStateRecord | null> {
    const res = await this.client.send(new GetItemCommand({
      TableName: usersTable(),
      Key: stateKey(userId, folder),
    }));
    return res.Item ? itemToState(res.Item) : null;
  }

  async setState(
    userId: string,
    folder: string,
    state: Pick<UserConfigStateRecord, 'following' | 'customised_at' | 'team_version_id'>,
  ): Promise<void> {
    const existing = await this.getState(userId, folder);
    if (existing) {
      await this.client.send(new UpdateItemCommand({
        TableName: usersTable(),
        Key: stateKey(userId, folder),
        UpdateExpression: 'SET following = :f, customised_at = :ca, team_version_id = :tv',
        ExpressionAttributeValues: {
          ':f': { N: String(state.following) },
          ':ca': av(state.customised_at),
          ':tv': av(state.team_version_id),
        },
      }));
    } else {
      await this.client.send(new PutItemCommand({
        TableName: usersTable(),
        Item: {
          ...stateKey(userId, folder),
          ...marshalItem({
            user_id: userId,
            folder,
            following: state.following,
            customised_at: state.customised_at,
            team_version_id: state.team_version_id,
          }),
        },
      }));
    }
  }

  async getLatestTeamVersion(folder: string): Promise<TeamConfigVersionRecord | null> {
    const res = await this.client.send(new QueryCommand({
      TableName: configTable(),
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: {
        ':pk': av(`TEAMCFG#${folder}`),
        ':prefix': av('VER#'),
      },
      ScanIndexForward: false,
      Limit: 1,
    }));
    const item = res.Items?.[0];
    return item ? itemToVersion(item) : null;
  }

  async listTeamVersions(folder: string): Promise<TeamConfigVersionRecord[]> {
    const res = await this.client.send(new QueryCommand({
      TableName: configTable(),
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: {
        ':pk': av(`TEAMCFG#${folder}`),
        ':prefix': av('VER#'),
      },
      ScanIndexForward: false,
    }));
    return (res.Items ?? []).map(itemToVersion);
  }

  async publishTeamVersion(input: CreateTeamConfigVersionInput): Promise<TeamConfigVersionRecord> {
    const item: Record<string, AttributeValue> = {
      ...versionKey(input.folder, input.published_at, input.id),
      ...marshalItem({
        id: input.id,
        folder: input.folder,
        files_json: input.files_json,
        published_by: input.published_by,
        published_at: input.published_at,
      }),
    };
    await this.client.send(new PutItemCommand({ TableName: configTable(), Item: item }));
    return itemToVersion(item);
  }
}
