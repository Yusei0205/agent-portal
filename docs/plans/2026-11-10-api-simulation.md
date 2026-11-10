# Plan: Client API simulation (mock REST APIs from client specs)

Status: in progress. Phases 1-4 are built and tested on `feat/api-simulation`: mock engine, Excel parser, storage, routes, the hosted simulated API, and the team UI (Tests > API simulation). The DynamoDB repository type-checks but has not been run against DynamoDB. Phase 5 onward (AI enrichment, MCP facade, spec diff) is a proposal. Written 2026-11-10.

## Goal

When a client's REST API is not ready (or only partly ready), our team can import the client's API specification and get a working simulated API from it. Agents and the code under development call the simulation exactly as they would call the real API, and a project can switch to the real API one endpoint at a time.

## Decisions (agreed with the team)

| Topic | Decision |
|---|---|
| Protocol | HTTP/REST only |
| Scope | Per project; no sharing between projects |
| Who edits | Our team only |
| Inputs | OpenAPI and Postman directly. Word and Excel go through a deterministic parse, then AI enrichment |
| API granularity | One sheet = one API. Each API has its own path, mode, spec versions and mock rules. Shared lookup sheets (status, action and message codes) are imported once per project and referenced |
| Paths and base URL | Taken from the document when present, otherwise entered by the team in the review step. An API with no path cannot be approved |
| Missing mock rule | Hard block: the caller gets an explicit error. A call never falls through to the real API |
| Conditional rules ("mandatory when action = 142") | Non-blocking warning, shown with an exclamation icon |
| Model for AI generation | Chosen by the user from a dropdown |
| Spec changes later | Versioned; diff on re-import; hand edits kept; runs pinned to a version |

## What exists today

- Integrations (`server/integrations.ts`) are **remote MCP servers**. Type `http` means "an MCP server at this URL". There is no integration that calls a plain REST API.
- A run gets its integrations from `server/agent/runner-integrations.ts`; the runner reaches them through `McpHttpClient` in `server/agent/runner-mcp.ts`.
- SSRF protection for outbound calls: `server/testing/ssrf.ts`.
- Repositories follow the SQLite + DynamoDB pattern (`server/repositories/*`); DynamoDB uses the no-scan rule.
- `exceljs` is already a dependency; no YAML or OpenAPI library is installed (`ajv` is).

Consequence: the simulation cannot hide inside an existing REST integration. It is exposed in **two ways** from the same engine:

1. **A REST endpoint hosted by the portal** (`/api/sim/:projectId/:apiId/...`). The team's own code, tests and tools call it like the client's API.
2. **An MCP server hosted by the portal**, one tool per operation. It is added to a project as an ordinary `http` integration, so agents get the simulated API with no change to the runner. In `live` mode the same MCP tools forward to the client's real base URL.

## What the sample spec looks like

Reference: `WS_GENAI_FLASH_ISD3_RestAPI_v1.9.xlsx` (22 sheets; 8 of them are API definitions: Login, UpdateFlash (all metadata), UpdateFlash (update rework), UpdateProgressive, InitiateProgressive, ReassignUsers, RetriggerHostFailed, Collateral Number Updated).
- Six of the eight do not list a response; they say "Refer to UpdateFlash(all metadata) worksheet response". The parser copies it and flags it.

- Each API sheet: header block (API Name, Method, Authentication, Content-Type), then a Request table and a Response table with columns NO. | FIELD NAME | M/O/CM/Echo | Data Type | Length | Description | Remarks.
- Nesting is encoded in the NO. column, not by indentation: `11.[n].10.[m].2` is `collateralList[] > fireInsuranceListing[] > noOfStoreys`. A row named `-` is an array-element marker.
- Column positions differ between sheets (extra columns such as Screen Code, FLASH Remarks), so columns are found by header text.
- Request headers and the Bearer token appear as rows inside the field table.
- Enums are free text in Remarks ("Valid Values: Y - Yes, N - No"); some live on separate sheets (Workflow Status List, Workflow Action Code List).
- Conditional rules are free text in Remarks, with inline version tags (`[v1.9]`).
- No URL paths or base URL are given. Some sheets are near-duplicates, and one sheet's API Name does not match its sheet.
- Some sheets are images only; some have absurd used ranges (up to column XEU).

## How to call it (built)

- Team routes live under `/api/projects/:id/sim/...` (import, list, approve, set path, rules, try).
- The simulated API is `/api/sim/:projectId/:apiId/call/<path in the spec>`. It needs a portal API token in `Authorization: Bearer ap_...`, so the client's own credential goes in `X-Sim-Authorization`. The portal token is never forwarded to the live API.
- It answers only from an approved spec version; before that it returns 409 `API_NOT_APPROVED`.

## Design

```
Client doc (xlsx/docx/postman/openapi)
  -> deterministic parse -> field tree
  -> AI enrichment (user-chosen model) -> DRAFT OpenAPI per API
  -> review screen (team fixes paths, resolves flagged items) -> approved spec version
  -> mock rules / scenarios per operation
  -> modes: mock | hybrid | live (per API, with per-operation override)
```

### Spec model
- Canonical format is OpenAPI 3.0 (JSON). Postman is converted to it.
- Extensions: `x-conditional` (conditional-rule text), `x-flags` (items for the exclamation icon), `x-source` (sheet and row it came from).
- Specs are immutable once approved. Editing creates the next version. Operations have stable IDs so rules survive a re-import.

### Mock engine
- Match on method and path template; first match wins.
- Validate the request against the spec (types, required fields, enums, lengths). A violation returns 400 with the field list. Conditional rules only produce warnings in the response log.
- Response comes from the chosen scenario: status, body, delay, or a failure (timeout, 500, 429, malformed body). With no scenario, a response is generated from the response schema (examples first, then type-based values).
- **Block rule:** no matching operation, or an operation whose rules are marked "needs review", returns `501 NO_MOCK_RULE` naming the method and path. It is logged. Nothing is forwarded to the real API.
- Stateful mocks (POST then GET returns the record) come later.

### Modes
- `mock`: engine only. Makes no outbound request.
- `live`: forward to the client's base URL (SSRF-checked), with the project's stored headers.
- `hybrid`: per operation. An operation marked live goes through; every other operation uses the mock, and a missing rule blocks.

### Spec changes
- Re-importing creates a draft of the next version and shows added, removed and changed operations and fields.
- Rules touching a changed operation become "needs review" and are blocked until the team confirms them.
- Hand edits to AI output are stored as overrides and reapplied on the next import; a conflict is flagged.
- A run is pinned to the spec version it started with.

### Flags (exclamation icon)
Shown on the review screen, the API list, and in mock logs. Raised when: the AI assumed a type or enum, a conditional rule could not be expressed, a path is missing, two sheets look like duplicates, an API name does not match its sheet, or a rule needs review after a spec update. Warnings never block; hard errors (invalid schema, missing mock rule) use different styling.

### Storage
New repository (SQLite + DynamoDB, same pattern as integrations). Per project: APIs, spec versions, scenarios, mode settings, generation jobs. Large specs live in S3 or as compressed items; only metadata is indexed. No scans.

## Phases

1. **Core (building now):** OpenAPI types, mock engine with request validation, schema-based response generation and the block rule. Unit tested.
2. **Excel parser (building now):** deterministic parse of the layout above into a field tree and a draft OpenAPI document, tested on a synthetic workbook and on the real sample when present.
3. **Storage and routes (built):** repository, import, version/approve flow, rules, "Try it", the hosted REST endpoint and mode routing. Live mode forwards the caller's own credential (`X-Sim-Authorization`); stored, encrypted live credentials are not built. Per-call logging is a console line only; a stored call log for the run view is still to do.
4. **Team UI (built):** the "API simulation" tab on the Tests page (`#/p/<project>/tests/simulation`): import, a review screen with exclamation-icon warnings and field tables, path entry, approve, mock rules, "Try it", settings and a "How to call it" panel. Not built yet: the version diff view and the model dropdown (it belongs to the AI step).
5. **AI enrichment:** per-sheet job, model dropdown, validation with one repair pass.
6. **MCP facade:** the simulation as an MCP server so agents can use it.
7. **Versioning, diff, overrides;** Word and Postman import; contract check against the real API; stateful mocks.

## Test automation: generating tests from the specs (proposal)

Read of `server/testing/` and `web/src/pages/tests/` on 2026-11-10; nothing below is built.

### What the Tests module already has
- **Test projects** with `app_url`, `api_base_url`, a vault of logins and secrets, and a timeout.
- **Scripts**: ordered steps. The `api_request` step takes method, path, headers, body, `expectedStatus` and `jsonAssertions` (exact value at a JSON path). Headers and body may use vault references such as `{{vault.NAME.value}}`.
- **Runner** with an SSRF guard. `test.allowPrivateNetworks` defaults to true, so a test can call the portal itself.
- **Case sets**: manual QA sheets (test id, category, scenario, precondition, steps, expected result, plus `request` and `response` columns), generated by AI from documents, editable, exportable to Excel, and performed by an agent (agent runs) with pass/fail counts.

### What is missing for API testing
1. The simulated API needs a portal API token and `X-Sim-Authorization`. A script can carry both through vault secrets today, but every test project would have to set that up by hand.
2. `api_request` cannot check a response against the spec. It only checks a status code and exact values.
3. The client documents do not say how the real API reports an error (HTTP 4xx, or HTTP 200 with a `code` other than "00"). Negative-case expectations therefore need a per-API setting, flagged with the exclamation icon until someone fills it in.
4. A test project has no link to a simulated API.

### Proposed design
- **API target on a test project:** pick one or more simulated APIs from the same portal project. The runner resolves the base URL and credentials itself. In simulated mode it can call the engine in-process (no token, no network); in live mode it calls the client's address with the credential held in the vault. The same generated tests then run against the simulation first and the real API later.
- **Deterministic generator (no AI):** for each operation in an approved spec version, produce cases from the schema:

| Case | Built from | Expected |
|---|---|---|
| Valid request | sample body from the request fields | success status, response matches the response fields |
| Each required field missing | `required` list | rejected |
| Wrong type per field | field types | rejected |
| Value outside the allowed list | `enum` | rejected |
| Value over the length limit | `maxLength` | rejected |
| Missing login token | `security` | 401 |
| Unknown path | none | blocked (501 on the simulation) |

  Each case is written twice: as a **case set row** (with the request and expected response filled in) for the existing Excel export and agent runs, and as a **runnable script** of `api_request` steps.
- **AI layer (user picks the model):** reads the conditional rules ("mandatory when action = 142") and the enum descriptions and adds business-rule cases the schema cannot give. It uses the existing case-set generation and the model dropdown.
- **New assertions:** `assert_schema` (response matches the approved spec) and a per-API "how errors are reported" setting.
- **Contract report:** run the same script against the simulation, then against the live API, and show the difference per case. A case that passes on the simulation and fails on live means the client's API does not match their own document.

### Delivery order
1. Deterministic generator that writes a case set and a script from an approved version, with a "Generate tests" button on the API's page.
2. API target on a test project, resolved by the runner (in-process for simulated mode).
3. `assert_schema` and the per-API error-style setting.
4. AI business-rule cases and the model dropdown.
5. Mock-versus-live contract report; scheduled runs.

## Risks

- AI output quality on messy documents. Mitigation: the deterministic parse does most of the work; AI fills in types, enums and flags; the team reviews before approval.
- Conditional rules in prose cannot all be turned into machine checks. They stay as warnings.
- The simulation is only as accurate as the client document. The contract check (phase 7) is the safeguard once a real API exists.
- Live mode forwards stored credentials; it reuses the SSRF guard and the existing encrypted-config handling.
