/**
 * DynamoDB implementation of PermissionsRepository.
 *
 * Uses TWO tables (matching the design doc):
 *
 * portal-config table (DYNAMODB_TABLE_PORTAL_CONFIG, default 'portal-config'):
 *   PK=PERM_GROUP          SK=G#<groupId>                → permission_rule_groups
 *   PK=PERM_RULE#<groupId> SK=R#<sortOrder8d>#<id>       → permission_rules (sorted)
 *   PK=PORTAL_PERM         SK=#SINGLETON                 → portal_permissions
 *
 * portal-projects table (DYNAMODB_TABLE_PORTAL_PROJECTS, default 'portal-projects'):
 *   PK=PROJECT#<projectId> SK=PERM#config                → project_permissions
 *   PK=PROJECT#<projectId> SK=TOOLRULE#<ruleId>          → project_tool_rules
 *
 * No GSIs needed — all reads target a known PK.
 */

import {
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  QueryCommand,
  DeleteItemCommand,
  CreateTableCommand,
  DescribeTableCommand,
  ResourceNotFoundException,
  ResourceInUseException,
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
  PermissionsRepository,
  PermissionRuleGroup,
  PermissionRule,
  ProjectToolRule,
  CreateRuleInput,
  CreateToolRuleInput,
} from './permissions.ts';

// ── Table bootstrap ───────────────────────────────────────────────────────────

export async function ensureConfigTableExists(
  client: DynamoDBClient,
  tableName: string,
): Promise<void> {
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
        ],
        BillingMode: 'PAY_PER_REQUEST',
      }),
    );
  } catch (e: unknown) {
    if (!(e instanceof ResourceInUseException)) throw e;
  }
}

export async function ensureProjectsTableExists(
  client: DynamoDBClient,
  tableName: string,
): Promise<void> {
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
        ],
        BillingMode: 'PAY_PER_REQUEST',
      }),
    );
  } catch (e: unknown) {
    if (!(e instanceof ResourceInUseException)) throw e;
  }
}

// ── Sort key helpers ──────────────────────────────────────────────────────────

/** Zero-pad sort_order to 8 digits for lexicographic SK ordering. */
function sortOrderPad(n: number): string {
  return String(Math.max(0, n)).padStart(8, '0');
}

// ── Item converters ────────────────────────────────────────────────────────────

function itemToGroup(item: Record<string, AttributeValue>): PermissionRuleGroup {
  return {
    id:          getString(item, 'id') ?? '',
    name:        getString(item, 'name') ?? '',
    description: getString(item, 'description') ?? '',
    is_builtin:  getNumber(item, 'isBuiltin'),
    created_at:  getString(item, 'createdAt') ?? '',
    updated_at:  getString(item, 'updatedAt') ?? '',
  };
}

function itemToRule(item: Record<string, AttributeValue>): PermissionRule {
  return {
    id:         getString(item, 'id') ?? '',
    group_id:   getString(item, 'groupId') ?? '',
    name:       getString(item, 'name') ?? '',
    pattern:    getString(item, 'pattern'),
    category:   getString(item, 'category'),
    action:     (getString(item, 'action') ?? 'allow') as 'allow' | 'block' | 'ask',
    scope:      (getString(item, 'scope') ?? 'always') as 'always' | 'untrusted',
    reason:     getString(item, 'reason'),
    sort_order: getNumber(item, 'sortOrder'),
    created_at: getString(item, 'createdAt') ?? '',
    updated_at: getString(item, 'updatedAt') ?? '',
  };
}

function itemToToolRule(item: Record<string, AttributeValue>): ProjectToolRule {
  return {
    id:              getString(item, 'id') ?? '',
    project_id:      getString(item, 'projectId') ?? '',
    tool_name:       getString(item, 'toolName') ?? '',
    action:          (getString(item, 'action') ?? 'allow') as 'allow' | 'block' | 'ask',
    command_pattern: getString(item, 'commandPattern'),
    scope:           (getString(item, 'scope') ?? 'always') as 'always' | 'untrusted',
    created_at:      getString(item, 'createdAt') ?? '',
    updated_at:      getString(item, 'updatedAt') ?? '',
  };
}

// ── Implementation ─────────────────────────────────────────────────────────────

export class DynamoDbPermissionsRepository implements PermissionsRepository {
  private readonly client: DynamoDBClient;
  private readonly configTable: string;
  private readonly projectsTable: string;

  constructor(opts?: { client?: DynamoDBClient; configTable?: string; projectsTable?: string }) {
    this.client = opts?.client ?? getDynamoDbClient();
    this.configTable =
      opts?.configTable ??
      process.env.DYNAMODB_TABLE_PORTAL_CONFIG ??
      'portal-config';
    this.projectsTable =
      opts?.projectsTable ??
      process.env.DYNAMODB_TABLE_PORTAL_PROJECTS ??
      'portal-projects';
  }

  async listGroups(): Promise<PermissionRuleGroup[]> {
    const items: Array<Record<string, AttributeValue>> = [];
    let lastKey: Record<string, AttributeValue> | undefined;
    do {
      const resp = await this.client.send(
        new QueryCommand({
          TableName: this.configTable,
          KeyConditionExpression: 'PK = :pk',
          ExpressionAttributeValues: marshalItem({ ':pk': 'PERM_GROUP' }),
          ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
        }),
      );
      items.push(...(resp.Items ?? []));
      lastKey = resp.LastEvaluatedKey;
    } while (lastKey);
    return items.map(itemToGroup);
  }

  async getGroupById(id: string): Promise<PermissionRuleGroup | null> {
    const resp = await this.client.send(
      new GetItemCommand({
        TableName: this.configTable,
        Key: { PK: { S: 'PERM_GROUP' }, SK: { S: `G#${id}` } },
      }),
    );
    return resp.Item ? itemToGroup(resp.Item) : null;
  }

  async getRulesForGroup(groupId: string): Promise<PermissionRule[]> {
    const items: Array<Record<string, AttributeValue>> = [];
    let lastKey: Record<string, AttributeValue> | undefined;
    do {
      const resp = await this.client.send(
        new QueryCommand({
          TableName: this.configTable,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
          ExpressionAttributeValues: marshalItem({
            ':pk':     `PERM_RULE#${groupId}`,
            ':prefix': 'R#',
          }),
          ScanIndexForward: true,
          ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
        }),
      );
      items.push(...(resp.Items ?? []));
      lastKey = resp.LastEvaluatedKey;
    } while (lastKey);
    return items.map(itemToRule);
  }

  async getAllBlockRules(): Promise<Array<{ id: string; pattern: string | null }>> {
    // Get all groups first, then load their rules and filter for block+always
    const groups = await this.listGroups();
    const allRules: PermissionRule[] = [];
    await Promise.all(
      groups.map(async (g) => {
        const rules = await this.getRulesForGroup(g.id);
        allRules.push(...rules);
      }),
    );
    return allRules
      .filter((r) => r.action === 'block' && r.scope === 'always')
      .map((r) => ({ id: r.id, pattern: r.pattern }));
  }

  async createRule(input: CreateRuleInput): Promise<PermissionRule> {
    const sk = `R#${sortOrderPad(input.sort_order)}#${input.id}`;
    const item: Record<string, JsVal> = {
      PK:         `PERM_RULE#${input.group_id}`,
      SK:         sk,
      id:         input.id,
      groupId:    input.group_id,
      name:       input.name,
      action:     input.action,
      scope:      input.scope,
      sortOrder:  input.sort_order,
      createdAt:  input.created_at,
      updatedAt:  input.updated_at,
    };
    if (input.pattern != null) item.pattern = input.pattern;
    if (input.category != null) item.category = input.category;
    if (input.reason != null) item.reason = input.reason;

    await this.client.send(
      new PutItemCommand({
        TableName: this.configTable,
        Item: marshalItem(item),
      }),
    );
    return input as PermissionRule;
  }

  async deleteRule(ruleId: string): Promise<void> {
    // We don't know groupId or sort_order from ruleId alone.
    // We need to find it by querying all groups.
    const groups = await this.listGroups();
    for (const group of groups) {
      const rules = await this.getRulesForGroup(group.id);
      const rule = rules.find((r) => r.id === ruleId);
      if (rule) {
        const sk = `R#${sortOrderPad(rule.sort_order)}#${ruleId}`;
        await this.client.send(
          new DeleteItemCommand({
            TableName: this.configTable,
            Key: {
              PK: { S: `PERM_RULE#${rule.group_id}` },
              SK: { S: sk },
            },
          }),
        );
        return;
      }
    }
  }

  async getPortalDefaultGroupId(): Promise<string | null> {
    const resp = await this.client.send(
      new GetItemCommand({
        TableName: this.configTable,
        Key: { PK: { S: 'PORTAL_PERM' }, SK: { S: '#SINGLETON' } },
      }),
    );
    return resp.Item ? getString(resp.Item, 'defaultGroupId') : null;
  }

  async setPortalDefaultGroupId(groupId: string): Promise<void> {
    const { now } = await import('../util.ts');
    await this.client.send(
      new UpdateItemCommand({
        TableName: this.configTable,
        Key: { PK: { S: 'PORTAL_PERM' }, SK: { S: '#SINGLETON' } },
        UpdateExpression: 'SET defaultGroupId = :g, updatedAt = :ts',
        ExpressionAttributeValues: marshalItem({ ':g': groupId, ':ts': now() }),
      }),
    );
  }

  async getProjectPermissions(projectId: string): Promise<{ rule_group_id: string } | null> {
    const resp = await this.client.send(
      new GetItemCommand({
        TableName: this.projectsTable,
        Key: {
          PK: { S: `PROJECT#${projectId}` },
          SK: { S: 'PERM#config' },
        },
      }),
    );
    if (!resp.Item) return null;
    const ruleGroupId = getString(resp.Item, 'ruleGroupId');
    return ruleGroupId ? { rule_group_id: ruleGroupId } : null;
  }

  async setProjectPermissions(projectId: string, ruleGroupId: string): Promise<void> {
    const { now } = await import('../util.ts');
    const item: Record<string, JsVal> = {
      PK:          `PROJECT#${projectId}`,
      SK:          'PERM#config',
      projectId,
      ruleGroupId,
      updatedAt:   now(),
    };
    await this.client.send(
      new PutItemCommand({ TableName: this.projectsTable, Item: marshalItem(item) }),
    );
  }

  async clearProjectPermissions(projectId: string): Promise<void> {
    await this.client.send(
      new DeleteItemCommand({
        TableName: this.projectsTable,
        Key: {
          PK: { S: `PROJECT#${projectId}` },
          SK: { S: 'PERM#config' },
        },
      }),
    );
  }

  async getProjectToolRules(projectId: string): Promise<ProjectToolRule[]> {
    const items: Array<Record<string, AttributeValue>> = [];
    let lastKey: Record<string, AttributeValue> | undefined;
    do {
      const resp = await this.client.send(
        new QueryCommand({
          TableName: this.projectsTable,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
          ExpressionAttributeValues: marshalItem({
            ':pk':     `PROJECT#${projectId}`,
            ':prefix': 'TOOLRULE#',
          }),
          ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
        }),
      );
      items.push(...(resp.Items ?? []));
      lastKey = resp.LastEvaluatedKey;
    } while (lastKey);
    return items.map(itemToToolRule);
  }

  async createProjectToolRule(input: CreateToolRuleInput): Promise<ProjectToolRule> {
    const item: Record<string, JsVal> = {
      PK:         `PROJECT#${input.project_id}`,
      SK:         `TOOLRULE#${input.id}`,
      id:         input.id,
      projectId:  input.project_id,
      toolName:   input.tool_name,
      action:     input.action,
      scope:      input.scope,
      createdAt:  input.created_at,
      updatedAt:  input.updated_at,
    };
    if (input.command_pattern != null) item.commandPattern = input.command_pattern;

    await this.client.send(
      new PutItemCommand({ TableName: this.projectsTable, Item: marshalItem(item) }),
    );
    return input as ProjectToolRule;
  }

  async deleteProjectToolRule(projectId: string, ruleId: string): Promise<void> {
    await this.client.send(
      new DeleteItemCommand({
        TableName: this.projectsTable,
        Key: {
          PK: { S: `PROJECT#${projectId}` },
          SK: { S: `TOOLRULE#${ruleId}` },
        },
      }),
    );
  }

  // Override createProjectToolRule to also write a lookup item
  // (done here to keep interface clean)
  async createProjectToolRuleWithLookup(input: CreateToolRuleInput): Promise<ProjectToolRule> {
    const result = await this.createProjectToolRule(input);

    // Write lookup item for deleteProjectToolRule
    await this.client.send(
      new PutItemCommand({
        TableName: this.projectsTable,
        Item: marshalItem({
          PK:        `TOOLRULE_ID#${input.id}`,
          SK:        '#LOOKUP',
          projectId: input.project_id,
          ruleId:    input.id,
        }),
      }),
    );
    return result;
  }

  /** Expose internals for test setup. */
  getClient(): DynamoDBClient { return this.client; }
  getConfigTable(): string { return this.configTable; }
  getProjectsTable(): string { return this.projectsTable; }
}
