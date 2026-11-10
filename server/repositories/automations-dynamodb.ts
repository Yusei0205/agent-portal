import { GetItemCommand, PutItemCommand, QueryCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { getDynamoDbClient, av } from './dynamo-client.ts';
import type { AutomationRecord, AutomationsRepository } from './automations.ts';
const table = (): string => process.env.DYNAMODB_TABLE_PORTAL_CODE ?? 'portal-code-test';
export class DynamoAutomationsRepository implements AutomationsRepository {
  private client = getDynamoDbClient();
  async get<T extends AutomationRecord>(project: string, key: string): Promise<T | null> {
    const r = await this.client.send(new GetItemCommand({ TableName: table(), Key: { PK: av(`AUTOMATION#${project}`), SK: av(key) }, ConsistentRead: true }));
    return r.Item?.data?.S ? JSON.parse(r.Item.data.S) as T : null;
  }
  async list<T extends AutomationRecord>(project: string, prefix: string): Promise<T[]> {
    const out: T[] = []; let cursor: Record<string, AttributeValue> | undefined;
    do {
      const r = await this.client.send(new QueryCommand({ TableName: table(), KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)', ExpressionAttributeValues: { ':pk': av(`AUTOMATION#${project}`), ':prefix': av(prefix) }, ConsistentRead: true, ExclusiveStartKey: cursor }));
      for (const item of r.Items ?? []) if (item.data?.S) out.push(JSON.parse(item.data.S) as T);
      cursor = r.LastEvaluatedKey;
    } while (cursor);
    return out;
  }
  async put(project: string, key: string, value: AutomationRecord, expected: number | null): Promise<boolean> {
    const json = JSON.stringify(value);
    if (Buffer.byteLength(json) > 300_000) throw new Error('Workflow record exceeds 300 KB');
    try {
      await this.client.send(new PutItemCommand({ TableName: table(), Item: { PK: av(`AUTOMATION#${project}`), SK: av(key), revision: { N: String(value.revision) }, data: av(json) },
        ConditionExpression: expected === null ? 'attribute_not_exists(PK)' : '#rev = :expected',
        ...(expected === null ? {} : { ExpressionAttributeNames: { '#rev': 'revision' }, ExpressionAttributeValues: { ':expected': { N: String(expected) } } }),
      }));
      return true;
    } catch (e) { if ((e as Error).name === 'ConditionalCheckFailedException') return false; throw e; }
  }
}
