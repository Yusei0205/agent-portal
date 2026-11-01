/**
 * DynamoDB implementation of ProjectRepository.
 *
 * Table: portal-projects  (env DYNAMODB_TABLE_PORTAL_PROJECTS, default 'portal-projects')
 *
 * ## Key schema
 *   PK=PROJECT#<projectId>  SK=#META              → project meta item
 *   PK=PROJECT#<projectId>  SK=MEMBER#<userId>    → project_members item
 *   PK=TEAM#<teamId>        SK=#META              → team meta item
 *   PK=TEAM#<teamId>        SK=MEMBER#<userId>    → team_members item
 *   PK=SLUG#<slug>          SK=#SINGLETON         → slug uniqueness reservation
 *   PK=PROJECT_INDEX        SK=<createdAt>#<id>   → project index for admin listProjects
 *
 * ## GSIs
 *   GSI-ProjectSlug:  PK=slug,   SK=projectId   → getProjectBySlug (E4)
 *   GSI-UserProjects: PK=userId, SK=projectId   → listMyProjects (E2)
 *
 * ## Slug uniqueness
 *   createProject atomically writes a SLUG# reservation item with
 *   ConditionExpression='attribute_not_exists(PK)'. If two concurrent creates
 *   try the same slug, one gets SlugAlreadyTakenError.
 *
 * ## Project delete cascade
 *   archiveProject sets archived=1 on the META item and removes the item
 *   from PROJECT_INDEX. On a full delete, MEMBER items and SLUG reservation
 *   must also be cleaned up (not needed for simple archiving).
 *
 * ## Denormalization note
 *   MEMBER items store userId and projectId as top-level attributes so they
 *   are projected onto GSI-UserProjects. The GSI only gives us projectId; we
 *   then BatchGet the META items.
 *
 * ## DynamoDB transaction limits
 *   A single TransactWriteItems can touch at most 100 items and cannot touch
 *   the same item twice. createProject uses 3 items (slug, meta, index).
 */

import {
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  DeleteItemCommand,
  QueryCommand,
  BatchGetItemCommand,
  TransactWriteItemsCommand,
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
  ProjectRepository,
  ProjectRecord,
  ProjectMemberRecord,
  TeamRecord,
  TeamMemberRecord,
  CreateProjectInput,
  CreateTeamInput,
} from './projects.ts';
import { SlugAlreadyTakenError } from './projects.ts';

// ── Table bootstrap ────────────────────────────────────────────────────────────

/**
 * Ensure the portal-projects table exists with all required GSIs.
 * Idempotent. Used by both projects and permissions contract tests.
 *
 * GSIs required by projects:
 *   GSI-ProjectSlug  (PK=slug, SK=projectId)
 *   GSI-UserProjects (PK=userId, SK=projectId)
 *
 * The permissions module also uses this table but needs no GSIs, so it is
 * safe to run this before the permissions test suite.
 */
export async function ensurePortalProjectsTableExists(
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
          { AttributeName: 'PK',        AttributeType: 'S' },
          { AttributeName: 'SK',        AttributeType: 'S' },
          { AttributeName: 'slug',      AttributeType: 'S' },
          { AttributeName: 'projectId', AttributeType: 'S' },
          { AttributeName: 'userId',    AttributeType: 'S' },
        ],
        GlobalSecondaryIndexes: [
          {
            IndexName: 'GSI-ProjectSlug',
            KeySchema: [
              { AttributeName: 'slug',      KeyType: 'HASH' },
              { AttributeName: 'projectId', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'ALL' },
          },
          {
            IndexName: 'GSI-UserProjects',
            KeySchema: [
              { AttributeName: 'userId',    KeyType: 'HASH' },
              { AttributeName: 'projectId', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'ALL' },
          },
        ],
        BillingMode: 'PAY_PER_REQUEST',
      }),
    );
  } catch (e: unknown) {
    if (!(e instanceof ResourceInUseException)) throw e;
  }
}

// ── BatchGet with UnprocessedKeys retry ───────────────────────────────────────

async function batchGetWithRetry(
  client: DynamoDBClient,
  tableName: string,
  keys: Array<Record<string, AttributeValue>>,
): Promise<Array<Record<string, AttributeValue>>> {
  const BATCH = 100;
  const results: Array<Record<string, AttributeValue>> = [];

  for (let i = 0; i < keys.length; i += BATCH) {
    let remaining = keys.slice(i, i + BATCH);
    let attempt = 0;

    while (remaining.length > 0) {
      const resp = await client.send(
        new BatchGetItemCommand({
          RequestItems: { [tableName]: { Keys: remaining } },
        }),
      );
      results.push(...(resp.Responses?.[tableName] ?? []));

      const unprocessed = resp.UnprocessedKeys?.[tableName]?.Keys;
      if (!unprocessed || unprocessed.length === 0) break;

      remaining = unprocessed;
      attempt++;
      await new Promise<void>((r) => setTimeout(r, Math.min(50 * 2 ** attempt, 2000)));
    }
  }

  return results;
}

// ── Item converters ────────────────────────────────────────────────────────────

function itemToProject(item: Record<string, AttributeValue>): ProjectRecord {
  return {
    id:                getString(item, 'id') ?? '',
    slug:              getString(item, 'slug') ?? '',
    name:              getString(item, 'name') ?? '',
    description:       getString(item, 'description') ?? '',
    notes:             getString(item, 'notes') ?? '',
    created_by:        getString(item, 'createdBy'),
    created_at:        getString(item, 'createdAt') ?? '',
    archived:          getNumber(item, 'archived'),
    default_lead_agent: getString(item, 'defaultLeadAgent') ?? '',
    default_model:     getString(item, 'defaultModel') ?? '',
    monthly_budget_usd: item.monthlyBudgetUsd?.N != null
      ? Number(item.monthlyBudgetUsd.N) : null,
    team_id:           getString(item, 'teamId'),
    vault_generated:   item.vaultGenerated != null ? getNumber(item, 'vaultGenerated') : 1,
  };
}

function itemToMember(item: Record<string, AttributeValue>): ProjectMemberRecord {
  return {
    project_id: getString(item, 'projectId') ?? '',
    user_id:    getString(item, 'userId') ?? '',
    access:     getString(item, 'access') ?? '',
    role:       getString(item, 'role') ?? '',
  };
}

function itemToTeam(item: Record<string, AttributeValue>): TeamRecord {
  return {
    id:                getString(item, 'id') ?? '',
    name:              getString(item, 'name') ?? '',
    description:       getString(item, 'description') ?? '',
    monthly_budget_usd: item.monthlyBudgetUsd?.N != null
      ? Number(item.monthlyBudgetUsd.N) : null,
    created_by:        getString(item, 'createdBy'),
    created_at:        getString(item, 'createdAt') ?? '',
    updated_at:        getString(item, 'updatedAt') ?? '',
  };
}

function itemToTeamMember(item: Record<string, AttributeValue>): TeamMemberRecord {
  return {
    team_id: getString(item, 'teamId') ?? '',
    user_id: getString(item, 'userId') ?? '',
    role:    getString(item, 'role') ?? 'member',
  };
}

// ── Implementation ─────────────────────────────────────────────────────────────

export class DynamoDbProjectRepository implements ProjectRepository {
  private readonly client: DynamoDBClient;
  private readonly tableName: string;

  constructor(opts?: { client?: DynamoDBClient; tableName?: string }) {
    this.client = opts?.client ?? getDynamoDbClient();
    this.tableName =
      opts?.tableName ??
      process.env.DYNAMODB_TABLE_PORTAL_PROJECTS ??
      'portal-projects';
  }

  // ── Projects ───────────────────────────────────────────────────────────────

  async listProjects(): Promise<ProjectRecord[]> {
    const items: Array<Record<string, AttributeValue>> = [];
    let lastKey: Record<string, AttributeValue> | undefined;
    do {
      const resp = await this.client.send(
        new QueryCommand({
          TableName:               this.tableName,
          KeyConditionExpression:  'PK = :pk',
          ExpressionAttributeValues: marshalItem({ ':pk': 'PROJECT_INDEX' }),
          ScanIndexForward:        false,
          ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
        }),
      );
      items.push(...(resp.Items ?? []));
      lastKey = resp.LastEvaluatedKey;
    } while (lastKey);

    const nonArchived = items.filter((item) => getNumber(item, 'archived') === 0);

    if (nonArchived.length === 0) return [];

    const keys = nonArchived.map((item) => ({
      PK: { S: `PROJECT#${getString(item, 'id')}` },
      SK: { S: '#META' },
    }));
    const metaItems = await batchGetWithRetry(this.client, this.tableName, keys);

    metaItems.sort((a, b) =>
      (getString(b, 'createdAt') ?? '').localeCompare(getString(a, 'createdAt') ?? ''),
    );

    return metaItems
      .filter((item) => getNumber(item, 'archived') === 0)
      .map(itemToProject);
  }

  async getAllSlugs(): Promise<string[]> {
    const items: Array<Record<string, AttributeValue>> = [];
    let lastKey: Record<string, AttributeValue> | undefined;
    do {
      const resp = await this.client.send(
        new QueryCommand({
          TableName:               this.tableName,
          KeyConditionExpression:  'PK = :pk',
          ExpressionAttributeValues: marshalItem({ ':pk': 'PROJECT_INDEX' }),
          ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
        }),
      );
      items.push(...(resp.Items ?? []));
      lastKey = resp.LastEvaluatedKey;
    } while (lastKey);

    return items
      .map((item) => getString(item, 'slug'))
      .filter((s): s is string => s != null && s !== '');
  }

  async getProjectById(id: string): Promise<ProjectRecord | null> {
    const resp = await this.client.send(
      new GetItemCommand({
        TableName: this.tableName,
        Key: { PK: { S: `PROJECT#${id}` }, SK: { S: '#META' } },
      }),
    );
    return resp.Item ? itemToProject(resp.Item) : null;
  }

  async getProjectBySlug(slug: string): Promise<ProjectRecord | null> {
    // Step 1: look up the SLUG# reservation to get projectId (cheap single GetItem)
    const slugResp = await this.client.send(
      new GetItemCommand({
        TableName: this.tableName,
        Key: { PK: { S: `SLUG#${slug}` }, SK: { S: '#SINGLETON' } },
      }),
    );
    if (!slugResp.Item) return null;
    const projectId = getString(slugResp.Item, 'projectId');
    if (!projectId) return null;
    return this.getProjectById(projectId);
  }

  async createProject(input: CreateProjectInput): Promise<ProjectRecord> {    const projectItem: Record<string, JsVal> = {
      PK:               `PROJECT#${input.id}`,
      SK:               '#META',
      id:               input.id,
      slug:             input.slug,
      projectId:        input.id,
      name:             input.name,
      description:      input.description,
      notes:            input.notes,
      createdBy:        input.created_by,
      createdAt:        input.created_at,
      archived:         input.archived,
      defaultLeadAgent: input.default_lead_agent,
      defaultModel:     input.default_model,
      vaultGenerated:   input.vault_generated,
      monthlyBudgetUsd: input.monthly_budget_usd ?? undefined,
      teamId:           input.team_id ?? undefined,
    };

    const slugItem: Record<string, JsVal> = {
      PK:        `SLUG#${input.slug}`,
      SK:        '#SINGLETON',
      slug:      input.slug,
      projectId: input.id,
    };

    const idxItem: Record<string, JsVal> = {
      PK:        'PROJECT_INDEX',
      SK:        `${input.created_at}#${input.id}`,
      id:        input.id,
      slug:      input.slug,
      name:      input.name,
      archived:  input.archived,
      createdAt: input.created_at,
    };

    try {
      await this.client.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            // 1. Slug reservation — fails if slug already taken
            {
              Put: {
                TableName:           this.tableName,
                Item:                marshalItem(slugItem),
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
            // 2. Project META — fails if ID already exists
            {
              Put: {
                TableName:           this.tableName,
                Item:                marshalItem(projectItem),
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
            // 3. PROJECT_INDEX entry (upsert — no condition needed)
            {
              Put: {
                TableName: this.tableName,
                Item:      marshalItem(idxItem),
              },
            },
          ],
        }),
      );
    } catch (e: unknown) {
      if (
        e instanceof Error &&
        e.name === 'TransactionCanceledException' &&
        e.message.includes('ConditionalCheckFailed')
      ) {
        throw new SlugAlreadyTakenError();
      }
      throw e;
    }

    return {
      id:                input.id,
      slug:              input.slug,
      name:              input.name,
      description:       input.description,
      notes:             input.notes,
      created_by:        input.created_by,
      created_at:        input.created_at,
      archived:          input.archived,
      default_lead_agent: input.default_lead_agent,
      default_model:     input.default_model,
      monthly_budget_usd: input.monthly_budget_usd ?? null,
      team_id:           input.team_id ?? null,
      vault_generated:   input.vault_generated,
    };
  }

  async createProjectWithOwner(input: CreateProjectInput, ownerId: string): Promise<ProjectRecord> {
    const projectItem: Record<string, JsVal> = {
      PK:               `PROJECT#${input.id}`,
      SK:               '#META',
      id:               input.id,
      slug:             input.slug,
      projectId:        input.id,
      name:             input.name,
      description:      input.description,
      notes:            input.notes,
      createdBy:        input.created_by,
      createdAt:        input.created_at,
      archived:         input.archived,
      defaultLeadAgent: input.default_lead_agent,
      defaultModel:     input.default_model,
      vaultGenerated:   input.vault_generated,
      monthlyBudgetUsd: input.monthly_budget_usd ?? undefined,
      teamId:           input.team_id ?? undefined,
    };

    const slugItem: Record<string, JsVal> = {
      PK:        `SLUG#${input.slug}`,
      SK:        '#SINGLETON',
      slug:      input.slug,
      projectId: input.id,
    };

    const idxItem: Record<string, JsVal> = {
      PK:        'PROJECT_INDEX',
      SK:        `${input.created_at}#${input.id}`,
      id:        input.id,
      slug:      input.slug,
      name:      input.name,
      archived:  input.archived,
      createdAt: input.created_at,
    };

    const memberItem: Record<string, JsVal> = {
      PK:        `PROJECT#${input.id}`,
      SK:        `MEMBER#${ownerId}`,
      projectId: input.id,
      userId:    ownerId,
      access:    'owner',
      role:      'owner',
    };

    try {
      await this.client.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            // 1. Slug reservation — fails if slug already taken
            {
              Put: {
                TableName:           this.tableName,
                Item:                marshalItem(slugItem),
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
            // 2. Project META — fails if ID already exists
            {
              Put: {
                TableName:           this.tableName,
                Item:                marshalItem(projectItem),
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
            // 3. PROJECT_INDEX entry (upsert — no condition needed)
            {
              Put: {
                TableName: this.tableName,
                Item:      marshalItem(idxItem),
              },
            },
            // 4. Owner member item — atomically adds creator as owner
            {
              Put: {
                TableName: this.tableName,
                Item:      marshalItem(memberItem),
              },
            },
          ],
        }),
      );
    } catch (e: unknown) {
      if (
        e instanceof Error &&
        e.name === 'TransactionCanceledException' &&
        e.message.includes('ConditionalCheckFailed')
      ) {
        throw new SlugAlreadyTakenError();
      }
      throw e;
    }

    return {
      id:                input.id,
      slug:              input.slug,
      name:              input.name,
      description:       input.description,
      notes:             input.notes,
      created_by:        input.created_by,
      created_at:        input.created_at,
      archived:          input.archived,
      default_lead_agent: input.default_lead_agent,
      default_model:     input.default_model,
      monthly_budget_usd: input.monthly_budget_usd ?? null,
      team_id:           input.team_id ?? null,
      vault_generated:   input.vault_generated,
    };
  }

  async updateProject(
    id: string,
    patch: Record<string, string | number | null>,
  ): Promise<ProjectRecord | null> {
    if (Object.keys(patch).length === 0) return this.getProjectById(id);

    const colToAttr: Record<string, string> = {
      name:        'name',
      description: 'description',
      notes:       'notes',
      archived:    'archived',
      default_lead_agent: 'defaultLeadAgent',
      default_model: 'defaultModel',
      monthly_budget_usd: 'monthlyBudgetUsd',
      team_id:     'teamId',
      vault_generated: 'vaultGenerated',
    };

    const setExprParts: string[] = [];
    const exprAttrNames: Record<string, string> = {};
    const exprAttrVals: Record<string, JsVal> = {};
    let idx = 0;

    for (const [col, val] of Object.entries(patch)) {
      const attr = colToAttr[col] ?? col;
      const nameKey = `#a${idx}`;
      const valKey = `:v${idx}`;
      setExprParts.push(`${nameKey} = ${valKey}`);
      exprAttrNames[nameKey] = attr;
      exprAttrVals[valKey] = val;
      idx++;
    }

    await this.client.send(
      new UpdateItemCommand({
        TableName:                 this.tableName,
        Key:                       { PK: { S: `PROJECT#${id}` }, SK: { S: '#META' } },
        UpdateExpression:          `SET ${setExprParts.join(', ')}`,
        ExpressionAttributeNames:  exprAttrNames,
        ExpressionAttributeValues: marshalItem(exprAttrVals),
        ConditionExpression:       'attribute_exists(PK)',
      }),
    ).catch((e: unknown) => {
      if (e instanceof Error && e.name === 'ConditionalCheckFailedException') return;
      throw e;
    });

    // Keep PROJECT_INDEX name in sync if name changed
    if (patch.name !== undefined) {
      const project = await this.getProjectById(id);
      if (project) {
        await this.client.send(
          new UpdateItemCommand({
            TableName:                 this.tableName,
            Key:                       {
              PK: { S: 'PROJECT_INDEX' },
              SK: { S: `${project.created_at}#${id}` },
            },
            UpdateExpression:          'SET #n = :n',
            ExpressionAttributeNames:  { '#n': 'name' },
            ExpressionAttributeValues: marshalItem({ ':n': String(patch.name) }),
          }),
        ).catch(() => { /* best-effort index sync */ });
      }
    }

    return this.getProjectById(id);
  }

  async archiveProject(id: string): Promise<void> {
    const project = await this.getProjectById(id);
    if (!project) return;

    await this.client.send(
      new UpdateItemCommand({
        TableName:                 this.tableName,
        Key:                       { PK: { S: `PROJECT#${id}` }, SK: { S: '#META' } },
        UpdateExpression:          'SET archived = :one',
        ExpressionAttributeValues: marshalItem({ ':one': 1 }),
      }),
    );

    // Remove from PROJECT_INDEX so admin list reflects archived state
    await this.client.send(
      new UpdateItemCommand({
        TableName:                 this.tableName,
        Key:                       {
          PK: { S: 'PROJECT_INDEX' },
          SK: { S: `${project.created_at}#${id}` },
        },
        UpdateExpression:          'SET archived = :one',
        ExpressionAttributeValues: marshalItem({ ':one': 1 }),
      }),
    ).catch(() => { /* best-effort */ });
  }

  // ── Members ────────────────────────────────────────────────────────────────

  async getMember(projectId: string, userId: string): Promise<ProjectMemberRecord | null> {
    const resp = await this.client.send(
      new GetItemCommand({
        TableName: this.tableName,
        Key: {
          PK: { S: `PROJECT#${projectId}` },
          SK: { S: `MEMBER#${userId}` },
        },
      }),
    );
    return resp.Item ? itemToMember(resp.Item) : null;
  }

  async addMember(projectId: string, userId: string, role: string): Promise<void> {
    const memberItem: Record<string, JsVal> = {
      PK:        `PROJECT#${projectId}`,
      SK:        `MEMBER#${userId}`,
      projectId,
      userId,
      access:    role,
      role,
    };
    await this.client.send(
      new PutItemCommand({
        TableName:           this.tableName,
        Item:                marshalItem(memberItem),
        ConditionExpression: 'attribute_not_exists(PK)',
      }),
    ).catch((e: unknown) => {
      if (e instanceof Error && e.name === 'ConditionalCheckFailedException') return;
      throw e;
    });
  }

  async updateMember(projectId: string, userId: string, role: string): Promise<void> {
    await this.client.send(
      new UpdateItemCommand({
        TableName:                 this.tableName,
        Key:                       {
          PK: { S: `PROJECT#${projectId}` },
          SK: { S: `MEMBER#${userId}` },
        },
        UpdateExpression:          'SET #r = :r, access = :r',
        ExpressionAttributeNames:  { '#r': 'role' },
        ExpressionAttributeValues: marshalItem({ ':r': role }),
        ConditionExpression:       'attribute_exists(PK)',
      }),
    ).catch((e: unknown) => {
      if (e instanceof Error && e.name === 'ConditionalCheckFailedException') return;
      throw e;
    });
  }

  async removeMember(projectId: string, userId: string): Promise<boolean> {
    try {
      await this.client.send(
        new DeleteItemCommand({
          TableName:           this.tableName,
          Key:                 {
            PK: { S: `PROJECT#${projectId}` },
            SK: { S: `MEMBER#${userId}` },
          },
          ConditionExpression: 'attribute_exists(PK)',
        }),
      );
      return true;
    } catch (e: unknown) {
      if (e instanceof Error && e.name === 'ConditionalCheckFailedException') return false;
      throw e;
    }
  }

  async listMembers(projectId: string): Promise<ProjectMemberRecord[]> {
    const items: Array<Record<string, AttributeValue>> = [];
    let lastKey: Record<string, AttributeValue> | undefined;
    do {
      const resp = await this.client.send(
        new QueryCommand({
          TableName:                this.tableName,
          KeyConditionExpression:   'PK = :pk AND begins_with(SK, :prefix)',
          ExpressionAttributeValues: marshalItem({
            ':pk':     `PROJECT#${projectId}`,
            ':prefix': 'MEMBER#',
          }),
          ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
        }),
      );
      items.push(...(resp.Items ?? []));
      lastKey = resp.LastEvaluatedKey;
    } while (lastKey);

    return items.map(itemToMember);
  }

  async countMembers(projectId: string): Promise<number> {
    let count = 0;
    let lastKey: Record<string, AttributeValue> | undefined;
    do {
      const resp = await this.client.send(
        new QueryCommand({
          TableName:                this.tableName,
          KeyConditionExpression:   'PK = :pk AND begins_with(SK, :prefix)',
          ExpressionAttributeValues: marshalItem({
            ':pk':     `PROJECT#${projectId}`,
            ':prefix': 'MEMBER#',
          }),
          Select:                   'COUNT',
          ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
        }),
      );
      count += resp.Count ?? 0;
      lastKey = resp.LastEvaluatedKey;
    } while (lastKey);
    return count;
  }

  async countOwners(projectId: string): Promise<number> {
    const members = await this.listMembers(projectId);
    return members.filter((m) => m.role === 'owner').length;
  }

  // ── Fast membership API ────────────────────────────────────────────────────

  async isMember(projectId: string, userId: string): Promise<boolean> {
    const member = await this.getMember(projectId, userId);
    return member != null;
  }

  async roleOf(projectId: string, userId: string): Promise<string | null> {
    const member = await this.getMember(projectId, userId);
    return member ? member.role : null;
  }

  async listMyProjects(userId: string): Promise<ProjectRecord[]> {
    // Step 1: query GSI-UserProjects to get projectIds for this user
    const memberItems: Array<Record<string, AttributeValue>> = [];
    let lastKey: Record<string, AttributeValue> | undefined;
    do {
      const resp = await this.client.send(
        new QueryCommand({
          TableName:                this.tableName,
          IndexName:                'GSI-UserProjects',
          KeyConditionExpression:   'userId = :uid',
          ExpressionAttributeValues: marshalItem({ ':uid': userId }),
          ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
        }),
      );
      memberItems.push(...(resp.Items ?? []));
      lastKey = resp.LastEvaluatedKey;
    } while (lastKey);

    if (memberItems.length === 0) return [];

    // Step 2: BatchGet project META items
    const keys = memberItems.map((item) => ({
      PK: { S: `PROJECT#${getString(item, 'projectId')}` },
      SK: { S: '#META' },
    }));
    const metaItems = await batchGetWithRetry(this.client, this.tableName, keys);

    // Filter out archived, sort by createdAt DESC
    const active = metaItems.filter((item) => getNumber(item, 'archived') === 0);
    active.sort((a, b) =>
      (getString(b, 'createdAt') ?? '').localeCompare(getString(a, 'createdAt') ?? ''),
    );

    return active.map(itemToProject);
  }

  // ── Teams ──────────────────────────────────────────────────────────────────

  async listTeams(): Promise<TeamRecord[]> {
    // TEAM_INDEX partition: PK=TEAM_INDEX, SK=<createdAt>#<teamId>
    // Query directly by table primary key — no GSI needed.
    const items: Array<Record<string, AttributeValue>> = [];
    let lastKey: Record<string, AttributeValue> | undefined;
    do {
      const resp = await this.client.send(
        new QueryCommand({
          TableName:                this.tableName,
          KeyConditionExpression:   'PK = :pk',
          ExpressionAttributeValues: marshalItem({ ':pk': 'TEAM_INDEX' }),
          ScanIndexForward:         true,
          ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
        }),
      );
      items.push(...(resp.Items ?? []));
      lastKey = resp.LastEvaluatedKey;
    } while (lastKey);

    if (items.length === 0) return [];

    // BatchGet team META items for full details
    const keys = items.map((item) => ({
      PK: { S: `TEAM#${getString(item, 'teamId')}` },
      SK: { S: '#META' },
    }));
    const metaItems = await batchGetWithRetry(this.client, this.tableName, keys);

    metaItems.sort((a, b) =>
      (getString(a, 'createdAt') ?? '').localeCompare(getString(b, 'createdAt') ?? ''),
    );

    return metaItems.map(itemToTeam);
  }

  async getTeamById(id: string): Promise<TeamRecord | null> {
    const resp = await this.client.send(
      new GetItemCommand({
        TableName: this.tableName,
        Key: { PK: { S: `TEAM#${id}` }, SK: { S: '#META' } },
      }),
    );
    return resp.Item ? itemToTeam(resp.Item) : null;
  }

  async createTeam(input: CreateTeamInput): Promise<TeamRecord> {
    const teamItem: Record<string, JsVal> = {
      PK:               `TEAM#${input.id}`,
      SK:               '#META',
      id:               input.id,
      name:             input.name,
      description:      input.description,
      createdBy:        input.created_by,
      createdAt:        input.created_at,
      updatedAt:        input.updated_at,
      monthlyBudgetUsd: input.monthly_budget_usd ?? undefined,
    };

    // TEAM_INDEX entry: PK=TEAM_INDEX, SK=<createdAt>#<teamId>
    const idxItem: Record<string, JsVal> = {
      PK:        'TEAM_INDEX',
      SK:        `${input.created_at}#${input.id}`,
      teamId:    input.id,
      name:      input.name,
      createdAt: input.created_at,
    };

    await this.client.send(
      new TransactWriteItemsCommand({
        TransactItems: [
          { Put: { TableName: this.tableName, Item: marshalItem(teamItem) } },
          { Put: { TableName: this.tableName, Item: marshalItem(idxItem) } },
        ],
      }),
    );

    return {
      id:                input.id,
      name:              input.name,
      description:       input.description,
      monthly_budget_usd: input.monthly_budget_usd,
      created_by:        input.created_by,
      created_at:        input.created_at,
      updated_at:        input.updated_at,
    };
  }

  async updateTeam(id: string, patch: Record<string, string | number | null>): Promise<void> {
    if (Object.keys(patch).length === 0) return;

    const colToAttr: Record<string, string> = {
      name:        'name',
      description: 'description',
      monthly_budget_usd: 'monthlyBudgetUsd',
      updated_at:  'updatedAt',
    };

    const setExprParts: string[] = [];
    const exprAttrNames: Record<string, string> = {};
    const exprAttrVals: Record<string, JsVal> = {};
    let idx = 0;

    for (const [col, val] of Object.entries(patch)) {
      const attr = colToAttr[col] ?? col;
      const nameKey = `#a${idx}`;
      const valKey = `:v${idx}`;
      setExprParts.push(`${nameKey} = ${valKey}`);
      exprAttrNames[nameKey] = attr;
      exprAttrVals[valKey] = val;
      idx++;
    }

    await this.client.send(
      new UpdateItemCommand({
        TableName:                 this.tableName,
        Key:                       { PK: { S: `TEAM#${id}` }, SK: { S: '#META' } },
        UpdateExpression:          `SET ${setExprParts.join(', ')}`,
        ExpressionAttributeNames:  exprAttrNames,
        ExpressionAttributeValues: marshalItem(exprAttrVals),
        ConditionExpression:       'attribute_exists(PK)',
      }),
    ).catch((e: unknown) => {
      if (e instanceof Error && e.name === 'ConditionalCheckFailedException') return;
      throw e;
    });
  }

  async deleteTeam(id: string): Promise<void> {
    const team = await this.getTeamById(id);
    if (!team) return;

    // Delete all team member items
    const members = await this.listTeamMembers(id);
    for (const m of members) {
      await this.client.send(
        new DeleteItemCommand({
          TableName: this.tableName,
          Key: {
            PK: { S: `TEAM#${id}` },
            SK: { S: `MEMBER#${m.user_id}` },
          },
        }),
      ).catch(() => { /* best-effort */ });
    }

    // Delete META item
    await this.client.send(
      new DeleteItemCommand({
        TableName: this.tableName,
        Key: { PK: { S: `TEAM#${id}` }, SK: { S: '#META' } },
      }),
    );

    // Delete TEAM_INDEX entry
    await this.client.send(
      new DeleteItemCommand({
        TableName: this.tableName,
        Key: {
          PK: { S: 'TEAM_INDEX' },
          SK: { S: `${team.created_at}#${id}` },
        },
      }),
    ).catch(() => { /* best-effort */ });
  }

  // ── Team members ───────────────────────────────────────────────────────────

  async addTeamMember(teamId: string, userId: string, role: string): Promise<void> {
    const memberItem: Record<string, JsVal> = {
      PK:     `TEAM#${teamId}`,
      SK:     `MEMBER#${userId}`,
      teamId,
      userId,
      role,
    };
    await this.client.send(
      new PutItemCommand({
        TableName:           this.tableName,
        Item:                marshalItem(memberItem),
        ConditionExpression: 'attribute_not_exists(PK)',
      }),
    ).catch((e: unknown) => {
      if (e instanceof Error && e.name === 'ConditionalCheckFailedException') return;
      throw e;
    });
  }

  async updateTeamMember(teamId: string, userId: string, role: string): Promise<void> {
    await this.client.send(
      new UpdateItemCommand({
        TableName:                 this.tableName,
        Key:                       {
          PK: { S: `TEAM#${teamId}` },
          SK: { S: `MEMBER#${userId}` },
        },
        UpdateExpression:          'SET #r = :r',
        ExpressionAttributeNames:  { '#r': 'role' },
        ExpressionAttributeValues: marshalItem({ ':r': role }),
        ConditionExpression:       'attribute_exists(PK)',
      }),
    ).catch((e: unknown) => {
      if (e instanceof Error && e.name === 'ConditionalCheckFailedException') return;
      throw e;
    });
  }

  async removeTeamMember(teamId: string, userId: string): Promise<void> {
    await this.client.send(
      new DeleteItemCommand({
        TableName: this.tableName,
        Key: {
          PK: { S: `TEAM#${teamId}` },
          SK: { S: `MEMBER#${userId}` },
        },
      }),
    );
  }

  async listTeamMembers(teamId: string): Promise<TeamMemberRecord[]> {
    const items: Array<Record<string, AttributeValue>> = [];
    let lastKey: Record<string, AttributeValue> | undefined;
    do {
      const resp = await this.client.send(
        new QueryCommand({
          TableName:                this.tableName,
          KeyConditionExpression:   'PK = :pk AND begins_with(SK, :prefix)',
          ExpressionAttributeValues: marshalItem({
            ':pk':     `TEAM#${teamId}`,
            ':prefix': 'MEMBER#',
          }),
          ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
        }),
      );
      items.push(...(resp.Items ?? []));
      lastKey = resp.LastEvaluatedKey;
    } while (lastKey);

    return items.map(itemToTeamMember);
  }
}
