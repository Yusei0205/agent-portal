// Dumps every DynamoDB table the repositories create (name, keys, GSIs, TTL) to infra/tables.json,
// so the CDK stack provisions exactly what the code expects. Run: node --import tsx scripts/dump-dynamo-tables.ts
import { readdirSync, writeFileSync } from 'node:fs';
import { DynamoDBClient, ResourceNotFoundException } from '@aws-sdk/client-dynamodb';

for (const n of ['USERS','PROJECTS','CONFIG','RUNS','EVENTS','CODE','CONTENT','SEARCH','CREATE','LEARN','TESTING']) {
  process.env[`DYNAMODB_TABLE_PORTAL_${n}`] = `portal-${n.toLowerCase()}`;
}

const tables = new Map<string, Record<string, unknown>>();
const ttl = new Map<string, string>();
const created = new Set<string>();

(DynamoDBClient.prototype as any).send = async function (cmd: any) {
  const name = cmd.constructor.name;
  const input = cmd.input ?? {};
  if (name === 'DescribeTableCommand') {
    if (!created.has(input.TableName)) {
      throw new ResourceNotFoundException({ message: 'nf', $metadata: {} });
    }
    return { Table: { TableStatus: 'ACTIVE', TableName: input.TableName } };
  }
  if (name === 'CreateTableCommand') {
    created.add(input.TableName);
    const cur: any = tables.get(input.TableName);
    const inp = JSON.parse(JSON.stringify(input));
    if (!cur) { tables.set(input.TableName, inp); return {}; }
    // Several repositories share one table: merge their attributes and indexes.
    for (const a of inp.AttributeDefinitions ?? []) {
      if (!cur.AttributeDefinitions.some((x: any) => x.AttributeName === a.AttributeName)) cur.AttributeDefinitions.push(a);
    }
    for (const g of inp.GlobalSecondaryIndexes ?? []) {
      cur.GlobalSecondaryIndexes ??= [];
      if (!cur.GlobalSecondaryIndexes.some((x: any) => x.IndexName === g.IndexName)) cur.GlobalSecondaryIndexes.push(g);
    }
    return {};
  }
  if (name === 'UpdateTimeToLiveCommand') {
    ttl.set(input.TableName, input.TimeToLiveSpecification.AttributeName);
    return {};
  }
  return {};
};

// Which table each repository's ensure function should create (matches the table it uses at runtime).
function tableFor(file: string): string {
  if (/^(ai-attachments|diagrams-data|doc-templates-data|generated-docs-data|presentations-data)/.test(file)) return 'portal-create';
  if (file.startsWith('learn-')) return 'portal-learn';
  if (file.startsWith('testing-data-')) return 'portal-testing';
  if (file.startsWith('permissions-') || file.startsWith('settings-') || file.startsWith('delegation-settings-')) return 'portal-config';
  return 'portal-users';
}

const dir = new URL('../server/repositories/', import.meta.url);
const client = new DynamoDBClient({ region: 'ap-southeast-1', credentials: { accessKeyId: 'x', secretAccessKey: 'x' } });
for (const f of readdirSync(dir).filter((x) => x.endsWith('-dynamodb.ts'))) {
  const mod: any = await import(new URL(f, dir).href);
  for (const [k, v] of Object.entries(mod)) {
    try {
      created.clear();
      if (/^ensure.*Exist/.test(k) && typeof v === 'function') {
        const fn = v as Function;
        await (fn.length >= 2 ? fn(client, tableFor(f)) : fn(client));
      } else if (/^DynamoDb.*Repository$/.test(k) && typeof v === 'function') {
        const inst: any = new (v as any)();
        if (typeof inst.ensureTables === 'function') await inst.ensureTables();
      }
    } catch (e) { console.error(`WARN ${f} ${k}:`, (e as Error).message); }
  }
}
const out = [...tables.values()].map((t: any) => ({ ...t, Ttl: ttl.get(t.TableName) ?? null }));
console.error(`${out.length} tables`);
writeFileSync(new URL('../infra/tables.json', import.meta.url), JSON.stringify(out, null, 2));
