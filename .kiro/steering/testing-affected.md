---
inclusion: always
---

# Testing — Run Only Affected Tests

## TL;DR

**Always use `npm run test:affected` instead of `npm test` or the full smoke suite.**  
Only run `--all` when explicitly asked, or when you know a shared core file changed.

---

## Commands

```sh
# Preview what would run (no tests executed)
npm run test:affected -- --dry-run

# Run affected modules (recommended for every change)
npm run test:affected

# Force a complete run (use only when asked or after shared-core changes)
npm run test:affected -- --all

# Run one specific module
npm run test:affected -- --module <id>

# Backend tests only (skip UI smoke, update only backend records)
npm run test:affected -- --backend-only

# UI smoke only (skip backend tests, update only UI records)
npm run test:affected -- --ui-only

# Validate the module map
npm run test:map:check

# Regenerate TEST_CHECKLIST.md from the map + pass record
npm run test:checklist
```

---

## Module map

- Source of truth: `test/test-map.json`
- Pass record (local, git-ignored): `.test-pass-record.json`
- Override record path: `TEST_RECORD_FILE=<path>` (both runner and checklist honour this)
- Checklist (auto-generated): `test/TEST_CHECKLIST.md`

---

## When to use `--all`

Only when:
- A task explicitly asks for a full test run.
- You changed a shared core file (`server/db.ts`, `server/http.ts`, `server/util.ts`,
  `server/index.ts`, `server/events.ts`, `web/src/App.jsx`, `web/src/lib/api.js`,
  `package.json`, `scripts/build.mjs`, `test/fixtures.ts`).

A change to any shared-core file automatically marks all affected modules stale,
so `npm run test:affected` without `--all` will also run everything in that case.

---

## Per-part tracking

Each module tracks backend and UI progress independently in `.test-pass-record.json`:

```json
"dashboard": {
  "backend": { "hash": "<sha256>", "result": "pass", "at": "<iso>", "commit": "<ref>" },
  "ui":      { "hash": "<sha256>", "result": "pass", "at": "<iso>", "commit": "<ref>" }
}
```

- A module is stale if **any** of its parts is stale.
- A part is stale if: it was never recorded, its last result was `fail`, or its hash changed.
- **Failed modules always re-run** — a `result: "fail"` entry is always treated as stale.
- `--backend-only` only updates the `backend` part; the `ui` part is unaffected.
- `--ui-only` only updates the `ui` part; the `backend` part is unaffected.
- `SMOKE_ONLY` receives only modules whose `ui` part is stale — a module stale only on the backend side does not trigger a smoke run.

---

## Fail-safes

**Unmapped source files** — Before detecting affected modules, the runner scans `server/` and
`web/src/` for files not covered by any module or shared entry. If any are found, it prints them
as a warning and forces `--all`. This ensures an untracked file can never silently suppress tests.
`--dry-run` shows the unmapped files as the reason for forcing all.

**UI "not run"** — If a needed UI part ends with no results (smoke results file missing,
`completed: false`, or a section with `ran: false`), the runner exits non-zero and lists those
modules in the summary as "not run". A zero exit always means every requested part ran and passed.

---

## Shared-entry `part` field

Shared entries in `test/test-map.json` may carry a `"part"` field: `"backend"`, `"ui"`, or absent (both).

| Shared entry | `part` | Reason |
|---|---|---|
| `server/db.ts`, `http.ts`, `util.ts`, `index.ts`, `events.ts` | absent (both) | Server changes can break both backend tests and smoke tests (smoke runs against the real server). |
| `test/fixtures.ts`, `test/fake-sdk.mjs`, `test/fake-kiro.mjs` | `backend` | Backend test helpers only — not compiled into the server or the web bundle. |
| `test/ui/smoke.ts` | `ui` | Changing the smoke runner only affects UI (smoke) outcomes, not backend unit tests. |
| `web/src/App.jsx`, `web/src/lib/api.js`, and other `web/` files | `ui` | Web-only — never loaded by backend tests. |
| `server/agent/**` | absent (both) | Server code that affects both backend tests and the running server seen by smoke. |

Note: `web/` files in a module's `sources` list are automatically excluded from its **backend** hash.
Editing a web file marks only the UI part stale, never the backend part.

---

## Adding new tests

1. Create your test file as `test/<name>.test.ts`.
2. Add it to the correct module in `test/test-map.json`:
   ```json
   "your-module": {
     "tests": ["test/<name>.test.ts"]
   }
   ```
3. Run `npm run test:map:check` — it will fail if the file is unmapped.
4. Run `npm run test:checklist` to regenerate `TEST_CHECKLIST.md`.

---

## Known failures

Some modules have pre-existing failures that cannot be fixed immediately. Rather than
exiting 1 every run, they can be listed in `test/known-failures.json`.

**Rules:**
- Adding an entry is a **deliberate choice** — do not use it to hide regressions.
- Each entry must name the **exact test** (backend: file + testName as it appears in
  spec/TAP output; UI: sectionId + testName from smoke failure message).
- Include a `reason` and `addedAt` date.
- **Remove the entry once the underlying issue is fixed.** When a known-failing test
  passes on re-run, the runner prints a notice that the entry can be removed.

**Special test name `__process_timeout__`** (backend only): use this when an entire
test file hangs the process rather than failing with a specific assertion. The runner
adds this synthetic failure when it kills a hung test process after 3 minutes (180 s).
The `file` field is **required** for `__process_timeout__` entries — matching is
exact so a hang in one file cannot silence an unexpected hang in another file of the
same module. `test:map:check` will error if a timeout entry is missing `file`.

The per-file kill timeout defaults to 180 s and can be overridden with
`TEST_FILE_TIMEOUT_MS` (milliseconds):
```sh
TEST_FILE_TIMEOUT_MS=5000 npm run test:affected
```

```json
// test/known-failures.json
{
  "version": "1",
  "entries": [
    {
      "module": "repos",
      "part": "backend",
      "file": "test/repos.test.ts",
      "testName": "Suite Name > exact test description",
      "reason": "Short explanation",
      "addedAt": "2026-10-31"
    },
    {
      "module": "repos",
      "part": "ui",
      "sectionId": "repos",
      "testName": "Exact failure message from smoke output",
      "reason": "Short explanation",
      "addedAt": "2026-10-31"
    }
  ]
}
```

---

## Adding a new module

1. Choose a module ID from the contract or invent a backend-only one.
2. Add an entry in `test/test-map.json` under `"modules"`:
   ```json
   "new-module": {
     "description": "...",
     "sources": ["server/new-feature.ts", "web/src/pages/NewPage.jsx"],
     "tests":   ["test/new-feature.test.ts"],
     "smokeIds": ["new-module"]
   }
   ```
3. If new source files are introduced, add them to `"sources"`.
4. Run `npm run test:map:check` to confirm everything is wired up.

---

## Adding a new smoke section

1. Open `test/ui/smoke.ts` and read it before editing.
2. Add your section to the `SECTIONS` array with a unique `id` and the relevant `modules`.
3. Wrap your test block in `if (sectionEnabled(...modules))` so it can be skipped with `SMOKE_ONLY`.
4. Run `npm run test:map:check` — it cross-checks all map `smokeIds` against the registered sections.

---

## Module ID contract

The canonical module IDs (shared with the smoke-suite SMOKE_ONLY contract):

`auth`, `setup`, `api-tokens`, `permissions`, `audit`, `delegation`, `projects`,
`workspaces`, `sessions`, `workflows`, `ide`, `dashboard`, `knowledge`, `create`,
`diagrams`, `generated-docs`, `presentations`, `vault`, `insights`, `inbox`,
`connections`, `repos`, `integrations`, `aws-accounts`, `credentials`, `bedrock-sso`,
`settings`, `config`, `kiro`, `reviews`, `branch-scans`, `testing-module`,
`api-access`, `loop-specs`, `engines`, `shell`, `theme`, `attachments`

Backend-only additions (no smoke section):
`security`, `storage`, `db`, `health`, `guardrails`, `output-files`, `user-config`

---

## How affected detection works

For each module, two SHA-256 hashes are computed:

- **backend hash**: non-web module sources + module test files + shared entries applicable to `backend`
- **ui hash**: all module sources + shared entries applicable to `ui`

If the stored hash for a part differs from the current hash — or if the stored result is `fail` —
that part is stale and will re-run.
