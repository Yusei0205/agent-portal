/**
 * DynamoDB implementation of AuthRepository.
 *
 * Table:  portal-users  (DYNAMODB_TABLE_PORTAL_USERS, default 'portal-users')
 * Same table as api-tokens — all user-centric data lives together.
 *
 * ## Key schema
 *   PK=USER#<userId>            SK=#META               → user item
 *   PK=USER#<userId>            SK=SESSION#<tokenHash> → session item
 *   PK=USER#<userId>            SK=INVITE#<tokenHash>  → invitation item (per-creator copy)
 *   PK=EMAIL#<normalized-email> SK=#SINGLETON          → email reservation (uniqueness guard)
 *   PK=USER_COUNT               SK=#TOTAL              → counter for countUsers()
 *   PK=USER_INDEX               SK=<createdAt>#<id>    → lightweight user index for listUsers()
 *   PK=INVITE_INDEX             SK=<createdAt>#<hash>  → invitation index for listPending()
 *   PK=INVITE_LOOKUP#<hash>     SK=#SINGLETON          → direct key lookup for getInvitationByHash()
 *   PK=SETUP_CLAIM              SK=#SINGLETON          → first-setup atomic claim
 *
 * ## GSIs
 *   GSI-UserEmail   PK=email,     SK=userId        → getUserByEmail (A1)
 *   GSI-TokenHash   PK=tokenHash, SK=entityType    → getSessionWithUser (A3, shared with api-tokens)
 *
 * ## TTL
 *   expiresAtEpoch on session items. DynamoDB TTL deletes automatically.
 *   Invitation items also carry expiresAtEpoch = floor(expires_at_unix).
 *
 * ## Atomicity
 *   createUser uses TransactWriteItems to write the user meta, email reservation,
 *   user index, and counter increment together. If another concurrent request already
 *   reserved the email, the transaction fails and EmailAlreadyTakenError is thrown.
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
  AuthRepository,
  UserRecord,
  UserWithLastActive,
  SessionWithUser,
  CreateUserInput,
  CreateSessionInput,
  InvitationRecord,
  CreateInvitationInput,
} from './auth.ts';
import { EmailAlreadyTakenError, AdminAlreadyExistsError } from './auth.ts';

// ── TTL helper ─────────────────────────────────────────────────────────────────

function ttlEpoch(dateStr: string | null | undefined): number | undefined {
  if (!dateStr) return undefined;
  const ms = Date.parse(dateStr);
  if (!Number.isFinite(ms)) return undefined;
  return Math.floor(ms / 1000);
}

// ── Item converters ────────────────────────────────────────────────────────────

function itemToUser(item: Record<string, AttributeValue>): UserRecord {
  return {
    id:            getString(item, 'id') ?? '',
    email:         getString(item, 'email') ?? '',
    name:          getString(item, 'name') ?? '',
    password_hash: getString(item, 'passwordHash') ?? '',
    is_admin:      getNumber(item, 'isAdmin'),
    disabled:      getNumber(item, 'disabled'),
    google_sub:    getString(item, 'googleSub'),
    created_at:    getString(item, 'createdAt') ?? '',
  };
}

function itemToSessionWithUser(
  sessionItem: Record<string, AttributeValue>,
  userItem: Record<string, AttributeValue>,
): SessionWithUser {
  return {
    user_id:    getString(sessionItem, 'userId') ?? '',
    email:      getString(userItem, 'email') ?? '',
    name:       getString(userItem, 'name') ?? '',
    is_admin:   getNumber(userItem, 'isAdmin'),
    disabled:   getNumber(userItem, 'disabled'),
    expires_at: getString(sessionItem, 'expiresAt') ?? '',
  };
}

function itemToInvitation(item: Record<string, AttributeValue>): InvitationRecord {
  return {
    token_hash:     getString(item, 'tokenHash') ?? '',
    email:          getString(item, 'email'),
    is_admin:       getNumber(item, 'isAdmin'),
    portal_role:    getString(item, 'portalRole') ?? 'member',
    project_id:     getString(item, 'projectId'),
    project_access: getString(item, 'projectAccess'),
    team_id:        getString(item, 'teamId'),
    expires_at:     getString(item, 'expiresAt') ?? '',
    created_by:     getString(item, 'createdBy') ?? '',
    created_at:     getString(item, 'createdAt') ?? '',
    used_at:        getString(item, 'usedAt'),
    used_by:        getString(item, 'usedBy'),
  };
}

// ── Table bootstrap (for DynamoDB Local tests) ────────────────────────────────

/**
 * Ensure the portal-users table exists with all required GSIs.
 * Idempotent. Called by both auth and api-tokens test setup.
 */
export async function ensurePortalUsersTableExists(
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
          { AttributeName: 'tokenHash', AttributeType: 'S' },
          { AttributeName: 'entityType', AttributeType: 'S' },
          { AttributeName: 'email',     AttributeType: 'S' },
          { AttributeName: 'userId',    AttributeType: 'S' },
        ],
        GlobalSecondaryIndexes: [
          {
            IndexName: 'GSI-TokenHash',
            KeySchema: [
              { AttributeName: 'tokenHash',  KeyType: 'HASH' },
              { AttributeName: 'entityType', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'ALL' },
          },
          {
            IndexName: 'GSI-UserEmail',
            KeySchema: [
              { AttributeName: 'email',  KeyType: 'HASH' },
              { AttributeName: 'userId', KeyType: 'RANGE' },
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

/**
 * BatchGetItem with automatic retry of UnprocessedKeys using exponential backoff.
 * Returns all successfully retrieved items.
 */
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
      // Exponential backoff: 50ms, 100ms, 200ms, …
      await new Promise<void>((r) => setTimeout(r, Math.min(50 * 2 ** attempt, 2000)));
    }
  }

  return results;
}

// ── Implementation ─────────────────────────────────────────────────────────────

export class DynamoDbAuthRepository implements AuthRepository {
  private readonly client: DynamoDBClient;
  private readonly tableName: string;

  constructor(opts?: { client?: DynamoDBClient; tableName?: string }) {
    this.client = opts?.client ?? getDynamoDbClient();
    this.tableName =
      opts?.tableName ??
      process.env.DYNAMODB_TABLE_PORTAL_USERS ??
      'portal-users';
  }

  // ── Users ──────────────────────────────────────────────────────────────────

  async countUsers(): Promise<number> {
    const resp = await this.client.send(
      new GetItemCommand({
        TableName: this.tableName,
        Key: { PK: { S: 'USER_COUNT' }, SK: { S: '#TOTAL' } },
      }),
    );
    return resp.Item ? getNumber(resp.Item, 'count') : 0;
  }

  async getUserById(id: string): Promise<UserRecord | null> {
    const resp = await this.client.send(
      new GetItemCommand({
        TableName: this.tableName,
        Key: { PK: { S: `USER#${id}` }, SK: { S: '#META' } },
      }),
    );
    return resp.Item ? itemToUser(resp.Item) : null;
  }

  async getUsersByIds(ids: string[]): Promise<UserRecord[]> {
    if (ids.length === 0) return [];
    const keys = ids.map((id) => ({
      PK: { S: `USER#${id}` },
      SK: { S: '#META' },
    }));
    const items = await batchGetWithRetry(this.client, this.tableName, keys);
    return items.map(itemToUser);
  }

  async getUserByEmail(email: string): Promise<UserRecord | null> {
    // Use the direct EMAIL# reservation item for an exact key lookup.
    // This is cheaper than the GSI query and doesn't require the email to be on the user item's GSI.
    const resp = await this.client.send(
      new GetItemCommand({
        TableName: this.tableName,
        Key: { PK: { S: `EMAIL#${email}` }, SK: { S: '#SINGLETON' } },
      }),
    );
    if (!resp.Item) return null;

    const userId = getString(resp.Item, 'userId');
    if (!userId) return null;

    return this.getUserById(userId);
  }

  async createUser(input: CreateUserInput): Promise<UserRecord> {
    const normalizedEmail = input.email.toLowerCase();

    // Transactionally write:
    //   1. Email reservation  (fails if email already taken)
    //   2. User meta item     (fails if userId PK already exists)
    //   3. USER_INDEX entry   (lightweight; used by listUsers)
    //   4. USER_COUNT ADD 1
    const userItem: Record<string, JsVal> = {
      PK:           `USER#${input.id}`,
      SK:           '#META',
      id:           input.id,
      email:        normalizedEmail,
      userId:       input.id,
      name:         input.name,
      passwordHash: input.password_hash,
      isAdmin:      input.is_admin,
      disabled:     input.disabled,
      createdAt:    input.created_at,
    };

    const emailItem: Record<string, JsVal> = {
      PK:     `EMAIL#${normalizedEmail}`,
      SK:     '#SINGLETON',
      userId: input.id,
      email:  normalizedEmail,
    };

    const idxSk = `${input.created_at}#${input.id}`;
    const idxItem: Record<string, JsVal> = {
      PK:       'USER_INDEX',
      SK:       idxSk,
      id:       input.id,
      email:    normalizedEmail,
      name:     input.name,
      isAdmin:  input.is_admin,
      disabled: input.disabled,
      createdAt: input.created_at,
    };

    try {
      await this.client.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            // 1. Email reservation — fails if email already taken
            {
              Put: {
                TableName: this.tableName,
                Item: marshalItem(emailItem),
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
            // 2. User meta — fails if ID already exists
            {
              Put: {
                TableName: this.tableName,
                Item: marshalItem(userItem),
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
            // 3. USER_INDEX entry (no condition — upsert is fine)
            {
              Put: {
                TableName: this.tableName,
                Item: marshalItem(idxItem),
              },
            },
            // 4. Counter increment
            {
              Update: {
                TableName: this.tableName,
                Key: { PK: { S: 'USER_COUNT' }, SK: { S: '#TOTAL' } },
                UpdateExpression: 'ADD #c :one',
                ExpressionAttributeNames: { '#c': 'count' },
                ExpressionAttributeValues: marshalItem({ ':one': 1 }),
              },
            },
          ],
        }),
      );
    } catch (e: unknown) {
      // TransactionCanceledException with ConditionalCheckFailed on the email item
      if (
        e instanceof Error &&
        e.name === 'TransactionCanceledException' &&
        e.message.includes('ConditionalCheckFailed')
      ) {
        throw new EmailAlreadyTakenError();
      }
      throw e;
    }

    return {
      id:           input.id,
      email:        normalizedEmail,
      name:         input.name,
      password_hash: input.password_hash,
      is_admin:     input.is_admin,
      disabled:     input.disabled,
      google_sub:   null,
      created_at:   input.created_at,
    };
  }

  async updateUserFields(id: string, patch: Record<string, string | number>): Promise<void> {
    // Map snake_case column names to camelCase attribute names
    const colToAttr: Record<string, string> = {
      disabled:      'disabled',
      is_admin:      'isAdmin',
      password_hash: 'passwordHash',
      name:          'name',
      email:         'email',
      google_sub:    'googleSub',
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

    if (setExprParts.length === 0) return;

    // If email is being changed, we must atomically:
    // 1. Delete the old email reservation
    // 2. Add a new email reservation
    // 3. Update the user item
    const newEmail = typeof patch.email === 'string' ? patch.email.toLowerCase() : null;

    if (newEmail) {
      // Fetch the current user to get the old email
      const current = await this.getUserById(id);
      const oldEmail = current?.email;

      if (oldEmail && oldEmail !== newEmail) {
        // Atomic email swap: delete old reservation, add new reservation, update user
        try {
          await this.client.send(
            new TransactWriteItemsCommand({
              TransactItems: [
                {
                  Delete: {
                    TableName: this.tableName,
                    Key: { PK: { S: `EMAIL#${oldEmail}` }, SK: { S: '#SINGLETON' } },
                  },
                },
                {
                  Put: {
                    TableName: this.tableName,
                    Item: marshalItem({
                      PK: `EMAIL#${newEmail}`,
                      SK: '#SINGLETON',
                      userId: id,
                      email: newEmail,
                    }),
                    ConditionExpression: 'attribute_not_exists(PK)',
                  },
                },
                {
                  Update: {
                    TableName: this.tableName,
                    Key: { PK: { S: `USER#${id}` }, SK: { S: '#META' } },
                    UpdateExpression: `SET ${setExprParts.join(', ')}`,
                    ExpressionAttributeNames: exprAttrNames,
                    ExpressionAttributeValues: marshalItem(exprAttrVals),
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
            throw new EmailAlreadyTakenError();
          }
          throw e;
        }
        return;
      }
    }

    // Normal field update (no email change, or email unchanged)
    await this.client.send(
      new UpdateItemCommand({
        TableName: this.tableName,
        Key: { PK: { S: `USER#${id}` }, SK: { S: '#META' } },
        UpdateExpression: `SET ${setExprParts.join(', ')}`,
        ExpressionAttributeNames: exprAttrNames,
        ExpressionAttributeValues: marshalItem(exprAttrVals),
        // Condition: user must already exist — prevents upsert of partial item
        ConditionExpression: 'attribute_exists(PK)',
      }),
    ).catch((e: unknown) => {
      // Silently ignore "user not found" to match SQLite's UPDATE 0-rows behaviour
      if (e instanceof Error && e.name === 'ConditionalCheckFailedException') return;
      throw e;
    });
  }

  async listUsersWithLastActive(): Promise<UserWithLastActive[]> {
    // Query USER_INDEX partition for all users in createdAt order
    const indexItems: Array<Record<string, AttributeValue>> = [];
    let lastKey: Record<string, AttributeValue> | undefined;
    do {
      const resp = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: 'PK = :pk',
          ExpressionAttributeValues: marshalItem({ ':pk': 'USER_INDEX' }),
          ScanIndexForward: true,
          ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
        }),
      );
      indexItems.push(...(resp.Items ?? []));
      lastKey = resp.LastEvaluatedKey;
    } while (lastKey);

    if (indexItems.length === 0) return [];

    // BatchGet full user items (carry lastActiveAt and passwordHash); retry UnprocessedKeys
    const keys = indexItems.map((item) => ({
      PK: { S: `USER#${getString(item, 'id')}` },
      SK: { S: '#META' },
    }));

    const userItems = await batchGetWithRetry(this.client, this.tableName, keys);

    // Sort by createdAt ASC (BatchGet does not preserve order)
    userItems.sort((a, b) =>
      (getString(a, 'createdAt') ?? '').localeCompare(getString(b, 'createdAt') ?? ''),
    );

    return userItems.map((item) => ({
      ...itemToUser(item),
      last_active_at: getString(item, 'lastActiveAt'),
    }));
  }

  // ── Sessions ───────────────────────────────────────────────────────────────

  async createSession(input: CreateSessionInput): Promise<void> {
    const sessionItem: Record<string, JsVal> = {
      PK:           `USER#${input.user_id}`,
      SK:           `SESSION#${input.token_hash}`,
      userId:       input.user_id,
      tokenHash:    input.token_hash,
      entityType:   `SESSION#${input.user_id}`,
      expiresAt:    input.expires_at,
      createdAt:    input.created_at,
      expiresAtEpoch: ttlEpoch(input.expires_at),
    };

    await this.client.send(
      new PutItemCommand({
        TableName: this.tableName,
        Item: marshalItem(sessionItem),
      }),
    );

    // Update user's lastActiveAt (denormalization for listUsersWithLastActive)
    await this.client.send(
      new UpdateItemCommand({
        TableName: this.tableName,
        Key: { PK: { S: `USER#${input.user_id}` }, SK: { S: '#META' } },
        UpdateExpression: 'SET lastActiveAt = :ts',
        ExpressionAttributeValues: marshalItem({ ':ts': input.created_at }),
      }),
    );
  }

  async getSessionWithUser(tokenHash: string): Promise<SessionWithUser | null> {
    // Step 1: look up session via GSI-TokenHash
    const sessionResp = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: 'GSI-TokenHash',
        KeyConditionExpression: 'tokenHash = :h AND begins_with(entityType, :prefix)',
        ExpressionAttributeValues: marshalItem({
          ':h':      tokenHash,
          ':prefix': 'SESSION#',
        }),
        Limit: 1,
      }),
    );
    const sessionItems = sessionResp.Items ?? [];
    if (sessionItems.length === 0) return null;
    const sessionItem = sessionItems[0];
    const userId = getString(sessionItem, 'userId') ?? '';

    // Step 2: get user
    const userResp = await this.client.send(
      new GetItemCommand({
        TableName: this.tableName,
        Key: { PK: { S: `USER#${userId}` }, SK: { S: '#META' } },
      }),
    );
    if (!userResp.Item) return null;

    return itemToSessionWithUser(sessionItem, userResp.Item);
  }

  async deleteSession(tokenHash: string): Promise<void> {
    // Need userId to build the PK. Query GSI-TokenHash first.
    const resp = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: 'GSI-TokenHash',
        KeyConditionExpression: 'tokenHash = :h AND begins_with(entityType, :prefix)',
        ExpressionAttributeValues: marshalItem({
          ':h':      tokenHash,
          ':prefix': 'SESSION#',
        }),
        Limit: 1,
      }),
    );
    const item = resp.Items?.[0];
    if (!item) return;
    const userId = getString(item, 'userId') ?? '';
    await this.client.send(
      new DeleteItemCommand({
        TableName: this.tableName,
        Key: {
          PK: { S: `USER#${userId}` },
          SK: { S: `SESSION#${tokenHash}` },
        },
      }),
    );
  }

  async deleteExpiredSessions(): Promise<void> {
    // TTL handles automatic expiry in DynamoDB. No-op.
  }

  // ── Invitations ────────────────────────────────────────────────────────────

  async createInvitation(input: CreateInvitationInput): Promise<void> {
    const baseFields: Record<string, JsVal> = {
      tokenHash:      input.token_hash,
      isAdmin:        input.is_admin,
      portalRole:     input.portal_role,
      expiresAt:      input.expires_at,
      expiresAtEpoch: ttlEpoch(input.expires_at),
      createdBy:      input.created_by,
      createdAt:      input.created_at,
    };
    if (input.email != null) baseFields.email = input.email;
    if (input.project_id != null) baseFields.projectId = input.project_id;
    if (input.project_access != null) baseFields.projectAccess = input.project_access;
    if (input.team_id != null) baseFields.teamId = input.team_id;

    // Direct lookup item (PK=INVITE_LOOKUP#<hash>, SK=#SINGLETON) — authoritative
    const lookupItem: Record<string, JsVal> = {
      PK: `INVITE_LOOKUP#${input.token_hash}`,
      SK: '#SINGLETON',
      ...baseFields,
    };

    // INVITE_INDEX entry (PK=INVITE_INDEX, SK=<createdAt>#<hash>)
    const idxItem: Record<string, JsVal> = {
      PK: 'INVITE_INDEX',
      SK: `${input.created_at}#${input.token_hash}`,
      ...baseFields,
    };

    // Write atomically: lookup + index together
    await this.client.send(
      new TransactWriteItemsCommand({
        TransactItems: [
          { Put: { TableName: this.tableName, Item: marshalItem(lookupItem) } },
          { Put: { TableName: this.tableName, Item: marshalItem(idxItem) } },
        ],
      }),
    );
  }

  async getInvitationByHash(tokenHash: string): Promise<InvitationRecord | null> {
    // Direct single-item lookup via INVITE_LOOKUP — O(1), no scan in disguise
    const resp = await this.client.send(
      new GetItemCommand({
        TableName: this.tableName,
        Key: { PK: { S: `INVITE_LOOKUP#${tokenHash}` }, SK: { S: '#SINGLETON' } },
      }),
    );
    if (!resp.Item) return null;
    return itemToInvitation(resp.Item);
  }

  async listPendingInvitations(now: string): Promise<InvitationRecord[]> {
    // Query INVITE_INDEX for all pending (not used, not expired) invitations
    const results: InvitationRecord[] = [];
    let lastKey: Record<string, AttributeValue> | undefined;
    do {
      const resp = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: 'PK = :pk',
          FilterExpression:
            'attribute_not_exists(usedAt) AND expiresAt > :now',
          ExpressionAttributeValues: marshalItem({
            ':pk': 'INVITE_INDEX',
            ':now': now,
          }),
          ScanIndexForward: false,
          ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
        }),
      );
      for (const item of resp.Items ?? []) {
        if (!getString(item, 'usedAt') && (getString(item, 'expiresAt') ?? '') > now) {
          results.push(itemToInvitation(item));
        }
      }
      lastKey = resp.LastEvaluatedKey;
    } while (lastKey);

    return results;
  }

  async markInvitationUsed(tokenHash: string, userId: string, usedAt: string): Promise<boolean> {
    // Step 1: GetItem INVITE_LOOKUP to get createdAt (needed to build INVITE_INDEX key)
    const getResp = await this.client.send(
      new GetItemCommand({
        TableName: this.tableName,
        Key: { PK: { S: `INVITE_LOOKUP#${tokenHash}` }, SK: { S: '#SINGLETON' } },
      }),
    );
    if (!getResp.Item) return false;
    const createdAt = getString(getResp.Item, 'createdAt');
    if (!createdAt) return false;

    // Step 2: Conditional update on INVITE_LOOKUP — atomic claim
    try {
      await this.client.send(
        new UpdateItemCommand({
          TableName: this.tableName,
          Key: { PK: { S: `INVITE_LOOKUP#${tokenHash}` }, SK: { S: '#SINGLETON' } },
          UpdateExpression: 'SET usedAt = :ua, usedBy = :ub',
          ConditionExpression: 'attribute_not_exists(usedAt)',
          ExpressionAttributeValues: marshalItem({ ':ua': usedAt, ':ub': userId }),
        }),
      );
    } catch (e: unknown) {
      if (e instanceof Error && e.name === 'ConditionalCheckFailedException') {
        return false;
      }
      throw e;
    }

    // Step 3: Update INVITE_INDEX by direct key (best-effort; lookup is authoritative)
    const indexSk = `${createdAt}#${tokenHash}`;
    await this.client.send(
      new UpdateItemCommand({
        TableName: this.tableName,
        Key: { PK: { S: 'INVITE_INDEX' }, SK: { S: indexSk } },
        UpdateExpression: 'SET usedAt = :ua, usedBy = :ub',
        ExpressionAttributeValues: marshalItem({ ':ua': usedAt, ':ub': userId }),
      }),
    ).catch(() => { /* best-effort sync of the index */ });

    return true;
  }

  async releaseInvitationClaim(tokenHash: string): Promise<void> {
    // Step 1: get createdAt so we can build the INVITE_INDEX direct key
    const getResp = await this.client.send(
      new GetItemCommand({
        TableName: this.tableName,
        Key: { PK: { S: `INVITE_LOOKUP#${tokenHash}` }, SK: { S: '#SINGLETON' } },
      }),
    );
    const createdAt = getResp.Item ? getString(getResp.Item, 'createdAt') : null;

    // Step 2: remove usedAt / usedBy from INVITE_LOOKUP
    await this.client.send(
      new UpdateItemCommand({
        TableName: this.tableName,
        Key: { PK: { S: `INVITE_LOOKUP#${tokenHash}` }, SK: { S: '#SINGLETON' } },
        UpdateExpression: 'REMOVE usedAt, usedBy',
      }),
    ).catch(() => { /* best-effort */ });

    // Step 3: remove from INVITE_INDEX if we have the key
    if (createdAt) {
      const indexSk = `${createdAt}#${tokenHash}`;
      await this.client.send(
        new UpdateItemCommand({
          TableName: this.tableName,
          Key: { PK: { S: 'INVITE_INDEX' }, SK: { S: indexSk } },
          UpdateExpression: 'REMOVE usedAt, usedBy',
        }),
      ).catch(() => { /* best-effort */ });
    }
  }

  async createFirstAdmin(input: CreateUserInput): Promise<UserRecord> {
    const normalizedEmail = input.email.toLowerCase();

    // Transaction items for the new user (same as createUser but with extra guard)
    const userItem: Record<string, JsVal> = {
      PK:           `USER#${input.id}`,
      SK:           '#META',
      id:           input.id,
      email:        normalizedEmail,
      userId:       input.id,
      name:         input.name,
      passwordHash: input.password_hash,
      isAdmin:      input.is_admin,
      disabled:     input.disabled,
      createdAt:    input.created_at,
    };

    const emailItem: Record<string, JsVal> = {
      PK:     `EMAIL#${normalizedEmail}`,
      SK:     '#SINGLETON',
      userId: input.id,
      email:  normalizedEmail,
    };

    const idxSk = `${input.created_at}#${input.id}`;
    const idxItem: Record<string, JsVal> = {
      PK:       'USER_INDEX',
      SK:       idxSk,
      id:       input.id,
      email:    normalizedEmail,
      name:     input.name,
      isAdmin:  input.is_admin,
      disabled: input.disabled,
      createdAt: input.created_at,
    };

    try {
      await this.client.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            // 0. Email reservation — fails if email already taken
            {
              Put: {
                TableName: this.tableName,
                Item: marshalItem(emailItem),
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
            // 1. User meta — fails if ID already exists
            {
              Put: {
                TableName: this.tableName,
                Item: marshalItem(userItem),
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
            // 2. USER_INDEX entry
            { Put: { TableName: this.tableName, Item: marshalItem(idxItem) } },
            // 3. Counter increment — guarded: only succeeds when count is 0 or not yet set.
            //    Merging the "no-users" guard and the increment into one Update avoids the
            //    DynamoDB ValidationException that fires when a ConditionCheck and an Update
            //    reference the same item in the same TransactWriteItems call.
            {
              Update: {
                TableName: this.tableName,
                Key: { PK: { S: 'USER_COUNT' }, SK: { S: '#TOTAL' } },
                UpdateExpression: 'ADD #c :one',
                ConditionExpression: 'attribute_not_exists(#c) OR #c = :zero',
                ExpressionAttributeNames: { '#c': 'count' },
                ExpressionAttributeValues: marshalItem({ ':one': 1, ':zero': 0 }),
              },
            },
          ],
        }),
      );
    } catch (e: unknown) {
      if (e instanceof Error && e.name === 'TransactionCanceledException') {
        const reasons = (e as unknown as { CancellationReasons?: Array<{ Code?: string }> })
          .CancellationReasons;
        // Index 0 = email reservation — email already taken
        if (reasons?.[0]?.Code === 'ConditionalCheckFailed') {
          throw new EmailAlreadyTakenError();
        }
        // Index 3 = counter guard — users already exist
        if (reasons?.[3]?.Code === 'ConditionalCheckFailed') {
          throw new AdminAlreadyExistsError();
        }
        // Fallback for older SDK versions that embed reason in message
        if (e.message.includes('ConditionalCheckFailed')) {
          throw new AdminAlreadyExistsError();
        }
      }
      throw e;
    }

    return {
      id:           input.id,
      email:        normalizedEmail,
      name:         input.name,
      password_hash: input.password_hash,
      is_admin:     input.is_admin,
      disabled:     input.disabled,
      google_sub:   null,
      created_at:   input.created_at,
    };
  }

  /** Expose internals for test setup. */
  getClient(): DynamoDBClient { return this.client; }
  getTableName(): string { return this.tableName; }
}
