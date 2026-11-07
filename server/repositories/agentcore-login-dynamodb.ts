/**
 * DynamoDB implementation of AgentcoreLoginRepository.
 *
 * Table: portal-runs  (DYNAMODB_TABLE_PORTAL_RUNS, default 'portal-runs')
 * Key design:
 *   PK=ACLOGIN#<credentialId>   SK=#STATE
 *   TTL: 30 minutes from createdAt
 */

import {
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  DeleteItemCommand,
} from '@aws-sdk/client-dynamodb';
import type { AttributeValue, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { getDynamoDbClient, marshalItem, getString, getNumber, av } from './dynamo-client.ts';
import type {
  AgentcoreLoginRepository,
  AgentcoreLoginEntry,
} from './agentcore-login.ts';

const LOGIN_TTL_SECONDS = 30 * 60; // 30 minutes

function table(): string {
  return process.env.DYNAMODB_TABLE_PORTAL_RUNS ?? 'portal-runs';
}

function key(credentialId: string) {
  return { PK: av(`ACLOGIN#${credentialId}`), SK: av('#STATE') };
}

function ttlEpoch(createdAt: string): number {
  const ms = Date.parse(createdAt);
  if (!Number.isFinite(ms)) return Math.floor(Date.now() / 1000) + LOGIN_TTL_SECONDS;
  return Math.floor(ms / 1000) + LOGIN_TTL_SECONDS;
}

function itemToEntry(item: Record<string, AttributeValue>): AgentcoreLoginEntry {
  const stateStr = getString(item, 'state');
  const tpJson = getString(item, 'tokenPayload');
  return {
    credentialId: getString(item, 'credentialId') ?? '',
    settled: getNumber(item, 'settled') === 1,
    state: stateStr === 'complete' || stateStr === 'failed' ? stateStr : null,
    tokenPayload: tpJson ? (JSON.parse(tpJson) as AgentcoreLoginEntry['tokenPayload']) : undefined,
    errorMessage: getString(item, 'errorMessage'),
    createdAt: getString(item, 'createdAt') ?? '',
  };
}

export async function ensureAgentcoreLoginTableExists(client: DynamoDBClient): Promise<void> {
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

export class DynamoDbAgentcoreLoginRepository implements AgentcoreLoginRepository {
  private readonly client: DynamoDBClient;
  constructor() { this.client = getDynamoDbClient(); }

  async ensureTables(): Promise<void> {
    await ensureAgentcoreLoginTableExists(this.client);
  }

  async create(credentialId: string, createdAt: string): Promise<void> {
    await this.client.send(new PutItemCommand({
      TableName: table(),
      Item: {
        ...key(credentialId),
        ...marshalItem({
          credentialId,
          settled: 0,
          state: null,
          errorMessage: null,
          createdAt,
        }),
        expiresAtEpoch: { N: String(ttlEpoch(createdAt)) },
      },
    }));
  }

  async get(credentialId: string): Promise<AgentcoreLoginEntry | null> {
    const res = await this.client.send(new GetItemCommand({
      TableName: table(),
      Key: key(credentialId),
    }));
    return res.Item ? itemToEntry(res.Item) : null;
  }

  async complete(
    credentialId: string,
    tokenPayload: AgentcoreLoginEntry['tokenPayload'],
  ): Promise<void> {
    await this.client.send(new UpdateItemCommand({
      TableName: table(),
      Key: key(credentialId),
      UpdateExpression: 'SET settled = :one, #st = :st, tokenPayload = :tp',
      ExpressionAttributeNames: { '#st': 'state' },
      ExpressionAttributeValues: {
        ':one': { N: '1' },
        ':st': av('complete'),
        ':tp': av(JSON.stringify(tokenPayload ?? {})),
      },
    }));
  }

  async fail(credentialId: string, errorMessage: string): Promise<void> {
    await this.client.send(new UpdateItemCommand({
      TableName: table(),
      Key: key(credentialId),
      UpdateExpression: 'SET settled = :one, #st = :st, errorMessage = :em',
      ExpressionAttributeNames: { '#st': 'state' },
      ExpressionAttributeValues: {
        ':one': { N: '1' },
        ':st': av('failed'),
        ':em': av(errorMessage),
      },
    }));
  }

  async delete(credentialId: string): Promise<void> {
    await this.client.send(new DeleteItemCommand({
      TableName: table(),
      Key: key(credentialId),
    }));
  }
}
