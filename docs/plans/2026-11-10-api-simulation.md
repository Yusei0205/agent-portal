# Plan: Client API simulation (mock REST APIs from client specs)

Status: in progress. Phases 1-3 are built and tested on `feat/api-simulation`: mock engine, Excel parser, storage (SQLite + DynamoDB), routes and the hosted simulated API. The DynamoDB repository type-checks but has not been run against DynamoDB. Phase 4 onward (UI, AI enrichment, MCP facade, spec diff) is a proposal. Written 2026-11-10.

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
4. **Team UI:** "Simulation" tab on the project's Integrations page: import, review with flags, endpoint list with mode toggles, "Try it" panel, version history.
5. **AI enrichment:** per-sheet job, model dropdown, validation with one repair pass.
6. **MCP facade:** the simulation as an MCP server so agents can use it.
7. **Versioning, diff, overrides;** Word and Postman import; contract check against the real API; stateful mocks.

## Risks

- AI output quality on messy documents. Mitigation: the deterministic parse does most of the work; AI fills in types, enums and flags; the team reviews before approval.
- Conditional rules in prose cannot all be turned into machine checks. They stay as warnings.
- The simulation is only as accurate as the client document. The contract check (phase 7) is the safeguard once a real API exists.
- Live mode forwards stored credentials; it reuses the SSRF guard and the existing encrypted-config handling.
