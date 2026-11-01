# Repository Pattern — How to Convert the Next Module

Date: 2026-11-02  
Updated: 2026-11-02 (pilot review pass)  
Author: backend-agent  
Pilot: `api-tokens` (S1 phase 1)

---

## Why the repository layer exists

The portal has 935 synchronous SQLite call sites across 67 files. Moving to DynamoDB (or any
async database) requires every call site to be async. The repository layer is the adapter
between business logic and the database:

```
Route handler / service code
        ↓
 ApiTokenRepository (interface)
        ↓
 SqliteApiTokenRepository  ←  default, local, tests
 DynamoDbApiTokenRepository ← USE_DYNAMODB=true is set
```

Each repository implementation is selected once at server startup. The rest of the code
never imports from `db.ts` directly for the covered entity.

---

## Files created by the api-tokens pilot

| File | Role |
|---|---|
| `server/repositories/backend.ts` | `usesDynamoDb()` master switch, region/endpoint helpers |
| `server/repositories/dynamo-client.ts` | Shared DynamoDB client singleton, attribute marshal helpers |
| `server/repositories/api-tokens.ts` | Interface + singleton factory |
| `server/repositories/api-tokens-sqlite.ts` | SQLite implementation |
| `server/repositories/api-tokens-dynamodb.ts` | DynamoDB implementation |
| `test/api-tokens-repo.test.ts` | Contract tests (both implementations) |

## Files created by S1 (auth, permissions, audit, delegation)

| File | Role |
|---|---|
| `server/repositories/auth.ts` | Interface + factory for users, sessions, invitations |
| `server/repositories/auth-sqlite.ts` | SQLite implementation |
| `server/repositories/auth-dynamodb.ts` | DynamoDB implementation (portal-users table) |
| `test/auth-repo.test.ts` | Contract tests (18 SQLite + 18 DynamoDB assertions) |
| `server/repositories/permissions.ts` | Interface + factory for permission groups/rules/project perms |
| `server/repositories/permissions-sqlite.ts` | SQLite implementation |
| `server/repositories/permissions-dynamodb.ts` | DynamoDB implementation (portal-config + portal-projects) |
| `test/permissions-repo.test.ts` | Contract tests (14 SQLite + 14 DynamoDB assertions) |
| `server/repositories/audit.ts` | Interface + factory for audit_log |
| `server/repositories/audit-sqlite.ts` | SQLite implementation |
| `server/repositories/audit-dynamodb.ts` | DynamoDB implementation (portal-projects table) |
| `test/audit-repo.test.ts` | Contract tests (7 SQLite + 7 DynamoDB assertions) |
| `server/repositories/delegation-settings.ts` | Interface + factory for delegation settings |
| `server/repositories/delegation-settings-sqlite.ts` | SQLite implementation |
| `server/repositories/delegation-settings-dynamodb.ts` | DynamoDB implementation (portal-config table) |
| `test/delegation-repo.test.ts` | Contract tests (8 SQLite + 8 DynamoDB assertions) |

---

## Shared infrastructure (use in every new DynamoDB module)

### backend.ts — master switch

```typescript
import { usesDynamoDb } from './backend.ts';

// In your repository factory:
if (usesDynamoDb()) {
  const { DynamoDbFooRepository } = await import('./foo-dynamodb.ts');
  _instance = new DynamoDbFooRepository();
}
```

`usesDynamoDb()` checks `USE_DYNAMODB === 'true'` (master switch) or
`DYNAMODB_TABLE_PORTAL_USERS` for backward compatibility.  Adding more per-table
env vars does NOT activate DynamoDB — always go through `usesDynamoDb()`.

**Never** check `process.env.DYNAMODB_TABLE_PORTAL_X` directly from a factory.
Using the shared function ensures the whole portal switches at once.

### dynamo-client.ts — shared client and helpers

```typescript
import { getDynamoDbClient, marshalItem, getString, getNumber } from './dynamo-client.ts';
```

- `getDynamoDbClient()` — returns a shared singleton; region defaults to `ap-southeast-1`.
- `marshalItem(obj)` — converts `{ key: string | number | null | undefined }` to DynamoDB
  `AttributeValue` map.  Undefined values are omitted; null → `{ NULL: true }`.
- `getString(item, key)` / `getNumber(item, key)` — read attributes from a DynamoDB item.

---

## Step-by-step: converting a new module

### 1. Audit the SQL

Find every `one()`, `all()`, `run()`, `insert()` call in `server/<module>.ts` that touches
the module's tables.  List them as named access patterns — see the design doc section 2 for
examples. Do the same for any callers outside the module file.

### 2. Create the interface

Create `server/repositories/<module>.ts`:

```typescript
export interface FooRecord { /* ... */ }
export interface CreateFooInput { /* ... */ }

export interface FooRepository {
  create(input: CreateFooInput): Promise<FooRecord>;
  getById(id: string): Promise<FooRecord | null>;
  // one method per access pattern
}

import { SqliteFooRepository } from './foo-sqlite.ts';
import { usesDynamoDb } from './backend.ts';

let _instance: FooRepository | null = null;

export async function initFooRepository(): Promise<void> {
  if (_instance) return;
  if (usesDynamoDb()) {
    const { DynamoDbFooRepository } = await import('./foo-dynamodb.ts');
    _instance = new DynamoDbFooRepository();
  } else {
    _instance = new SqliteFooRepository();
  }
}

export function getFooRepository(): FooRepository {
  if (!_instance) _instance = new SqliteFooRepository();
  return _instance;
}

export function setFooRepository(repo: FooRepository): void { _instance = repo; }
export function clearFooRepository(): void { _instance = null; }
```

### 3. Create the SQLite implementation

Create `server/repositories/<module>-sqlite.ts` wrapping the synchronous helpers in
`Promise.resolve()`.  All SQL lives here.

### 4. Create the DynamoDB implementation

Create `server/repositories/<module>-dynamodb.ts`.  Key rules:

- Import from `./dynamo-client.ts` — do NOT redeclare marshal helpers or create your own client.
- **No Scan** — use GetItem, Query with GSI, or BatchGetItem.
- **TTL retention** — set `expiresAtEpoch = floor(expires_at_unix + 90*86400)` so expired
  items remain in DynamoDB for 90 days, matching SQLite's behaviour.  Guard against
  unparseable dates with the `ttlEpoch()` helper pattern:
  ```typescript
  function ttlEpoch(dateStr: string | null | undefined): number | undefined {
    if (!dateStr) return undefined;
    const ms = Date.parse(dateStr);
    if (!Number.isFinite(ms)) return undefined;
    return Math.floor(ms / 1000) + 90 * 86400;
  }
  ```
- **listAll() pattern** — if the admin list requires all items regardless of user partition,
  maintain a `<ENTITY>_INDEX` sentinel partition (e.g. `TOKEN_INDEX`) and write a lightweight
  entry on `create()`, updating on `revoke()`.  See api-tokens-dynamodb.ts for reference.
- **listByUser ordering** — DynamoDB SK order ≠ creation-time order if SK includes a random
  token ID.  Fetch all items and sort by `createdAt` in-app, then apply limit.

### 5. Wire into server startup

In `server/index.ts`, add `await initFooRepository()` after `initApiTokenRepository()`.

### 6. Replace SQL in the module

Remove db.ts imports, import `getFooRepository`, and `await` every call.

### 7. Update callers outside the module

Search for any other files that query the module's table directly and replace those with
repository calls.

### 8. Write contract tests

Create `test/<module>-repo.test.ts` following `test/api-tokens-repo.test.ts`:

- Add `const RUN_TAG = Date.now().toString(36).slice(-5)` at module level and incorporate
  it into all token/item IDs so re-runs against DynamoDB Local never hit
  `ConditionalCheckFailedException`.
- Wrap the DynamoDB suite in `describe('DynamoDB Local suite', async () => { ... })` — the
  async body is awaited by node:test `--test` mode, which is required for the connectivity
  check and dynamic imports to work correctly.
- Use `DYNAMODB_ENDPOINT` (only) to trigger the DynamoDB suite.  Never set
  `DYNAMODB_TABLE_PORTAL_USERS` or `USE_DYNAMODB` during test runs — doing so activates DynamoDB
  globally for the server started by HTTP route test files in the same module.
- The SQLite and DynamoDB suites MUST pass the same assertions.

Required contract assertions (minimum):
- create round-trip
- getById returns null for wrong owner
- getByHash returns correct user fields (email, name, is_admin, disabled)
- getByHash disabled user returns `user_disabled=1`
- listByUser excludes delegate/scoped tokens, returns newest first, limited
- countActive excludes revoked tokens
- countActive excludes expired tokens
- listAll returns correct tokens, newest first, excludes delegates, includes user metadata

### 9. Update test-map.json

Add new `server/repositories/<module>*.ts` files to `"sources"` and the new test file to
`"tests"`.  Run `npm run test:map:check` to verify.

When `server/repositories/dynamo-client.ts` starts being used by more modules, move it to a
shared entry in `test/test-map.json` with `"affects": [...]` listing all affected modules.

---

## Running the DynamoDB contract tests

```sh
# 1. Start DynamoDB Local
docker run -d --name ddb-local -p 8000:8000 amazon/dynamodb-local

# 2. Run contract tests (DYNAMODB_ENDPOINT only — no global switch)
DYNAMODB_ENDPOINT=http://localhost:8000 REQUIRE_DYNAMODB=1 \
  npm run test:affected -- --module api-tokens --backend-only

# To run all repository modules at once:
DYNAMODB_ENDPOINT=http://localhost:8000 REQUIRE_DYNAMODB=1 \
  npm run test:repo-contracts

# 3. Stop and remove the container
docker stop ddb-local && docker rm ddb-local
```

Table name defaults to `portal-users-test` when `DYNAMODB_TABLE_PORTAL_USERS` is not set.
To use a custom table: `DYNAMODB_TABLE_PORTAL_USERS=my-table DYNAMODB_ENDPOINT=...`.

> ⚠️  **Never set `DYNAMODB_TABLE_PORTAL_USERS` or `USE_DYNAMODB` during test runs.**
> These activate DynamoDB globally, breaking HTTP route test files that start a real server.
> Use `DYNAMODB_ENDPOINT` only — the contract test files check it and run the DynamoDB suite
> without polluting the global repository singleton.

---

## Environment variables

| Var | Effect |
|---|---|
| `USE_DYNAMODB=true` | Master switch — activates DynamoDB for ALL repositories |
| `DYNAMODB_TABLE_PORTAL_USERS` | Table name override AND activates DynamoDB (legacy compat) |
| `DYNAMODB_ENDPOINT` | Override endpoint for DynamoDB Local; also triggers contract test suite |
| `DYNAMODB_REGION` | Override region (default: `AWS_REGION` → `ap-southeast-1`) |

`DYNAMODB_REGION` defaults to `ap-southeast-1` (portal target region), not `us-east-1`.

---

## Known limitations

### TOKEN_INDEX denormalization

`listAll()` stores user name/email in the TOKEN_INDEX entry at create time.  Subsequent
changes to the user record (display name, email) are not propagated.  `last_used_at` is also
not maintained in TOKEN_INDEX; the admin view shows null for that field.

### `updateLastUsed` not reflected in TOKEN_INDEX

The TOKEN_INDEX entry is not updated when a token is last used.  The admin list shows
`last_used_at: null` for all tokens.  Future improvement: add a separate UpdateItem call in
`updateLastUsed` to sync the index entry.

### Synchronous `authenticateApiToken()` compatibility shim

The deprecated `authenticateApiToken()` export in `server/api-tokens.ts` stays synchronous
to preserve existing tests.  It only works with the SQLite repository.  Future modules should
not add such shims; the async path in `server/auth.ts` is the correct route.

### `revokeRunToken(tokenId, userId)` signature change

The `revokeRunToken` function in `server/delegation.ts` gained a `userId` parameter so
DynamoDB can build the PK without a separate lookup.  When converting the next module that has
deletion or update operations, design the interface signature to include the partition key.

---

## Suggested conversion order (S1 remaining)

1. **`auth`** (sessions table) — B1–B4 access patterns, one GSI needed.
2. **`permissions`** — tiny/config, no complex queries.
3. **`audit`** — append-only, date-partitioned.
4. **`delegation`** (after api-tokens) — already uses the api-tokens repository.

Harder modules (joins, aggregates, FTS) are documented in `2026-11-02-dynamodb-data-design.md`.

---

## Snapshot / version pattern (settings and future config-like modules)

Settings are global configuration read synchronously by hundreds of call sites
(`getSetting`, `getSettings`).  Making all of them async would cascade across
the entire codebase.  The snapshot / version pattern avoids that:

### How it works

1. **At startup** — `initSettingsRepository()` loads all keys and a version
   counter into an in-memory `Snapshot { version, keys }`.
2. **Every HTTP request** — a pre-request hook (`refreshSnapshotIfStale()`)
   reads only the version counter (a single GetItem / SELECT).  If the version
   has not changed, no further I/O.  If it changed, the full snapshot is
   reloaded.
3. **Synchronous reads** — `getSetting(db, key)` and `getSettings()` read from
   the snapshot with no SQL or network I/O.
4. **Writes** — callers update the snapshot optimistically (`_updateSnapshotKey`)
   and fire the repository write.  In SQLite the write is sync-inside-async
   (effectively instant).  In DynamoDB the write is async and tracked via
   `registerBackgroundWrite`.

### Version counter

- **SQLite**: a reserved row `key = '_version'` in the settings table.
  Every `setKey / setKeys / deleteKey` call increments it inside the same
  transaction.  `loadSnapshot` and `getVersion` exclude `_version` from the
  key map.
- **DynamoDB**: `PK=SETTINGS, SK=_VERSION` item with a numeric `version`
  attribute, incremented via `ADD #v :inc` in the same `TransactWriteItems`
  call as the data write.

### Multi-key atomic writes

`setKeys(pairs)` writes all pairs **and** the single version bump in one
transaction / one `TransactWriteItems` call.  The PUT `/api/settings` route
collects all key-value changes first and calls `repo.setKeys(pairs)` once, so
the settings update is all-or-nothing on both backends.

### Fail-closed guarantee

- `initSettingsRepository()` must succeed at startup; if it throws the server
  does not start.
- `refreshSnapshotIfStale()` throws on version-check or reload errors; the
  pre-request hook propagates the error so the request returns 500 rather than
  reading stale or default values.
- Background timers that read settings must call `refreshSnapshotIfStale()`
  before reading.

### When to reuse this pattern

Any repository that:
- has many synchronous callers that cannot easily be made async, AND
- needs cross-instance freshness on Lambda

should use the same pattern:
1. Add a version counter to the interface.
2. Load a snapshot in `initXxxRepository()`.
3. Register `refreshSnapshotIfStale` (or a module-specific equivalent) as the
   pre-request hook, or call it explicitly in callers.
4. Expose synchronous snapshot-read helpers for existing callers.
