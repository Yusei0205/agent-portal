import { GetItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { getDynamoDbClient, marshalItem, getString } from './dynamo-client.ts';
import { ChecklistConflict } from './project-checklists.ts';
import type { Checklist } from '../project-checklist-analysis.ts';

const table = () => process.env.DYNAMODB_TABLE_PORTAL_CONFIG ?? 'portal-config';
const key = (id: string) => ({ PK: `PROJECT_CHECKLIST#${id}`, SK: 'DOCUMENT' });
export async function read(id: string): Promise<Checklist | null> {
  const r = await getDynamoDbClient().send(new GetItemCommand({ TableName: table(), Key: marshalItem(key(id)), ConsistentRead: true }));
  if (!r.Item) return null;
  const value = getString(r.Item, 'value');
  if (!value) throw new Error('Checklist document is missing its value.');
  return JSON.parse(value);
}
export async function write(id: string, previous: Checklist | null, next: Checklist): Promise<void> {
  try {
    await getDynamoDbClient().send(new PutItemCommand({
      TableName: table(), Item: marshalItem({ ...key(id), value: JSON.stringify(next), revision: next.revision }),
      ConditionExpression: previous ? '#revision = :previous' : 'attribute_not_exists(PK)',
      ...(previous ? { ExpressionAttributeNames: { '#revision': 'revision' }, ExpressionAttributeValues: { ':previous': { N: String(previous.revision) } } } : {}),
    }));
  } catch (e) {
    if ((e as Error).name === 'ConditionalCheckFailedException') throw new ChecklistConflict('Checklist changed. Reload before saving.');
    throw e;
  }
}
