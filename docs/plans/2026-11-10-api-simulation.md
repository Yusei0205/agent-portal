# Plan: Client API simulation (mock REST APIs from client specs)

Status: built on `feat/api-simulation` and tested, with the gaps listed under "Not built" below. Written 2026-11-10.

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

1. **Core (built):** OpenAPI types, mock engine with request validation, schema-based response generation and the block rule.
2. **Excel parser (built):** deterministic parse of the layout above into a field tree and a draft OpenAPI document, tested on a synthetic workbook and on the real sample (8 APIs found).
3. **Storage and routes (built):** repository (SQLite and DynamoDB), import, version/approve flow, rules, "Try it", the hosted REST endpoint and mode routing. Live mode forwards the caller's own credential (`X-Sim-Authorization`); stored, encrypted live credentials are not built. Per-call logging is a console line only.
4. **Team UI (built):** the "API simulation" tab on the Tests page (`#/p/<project>/tests/simulation`): import, a review screen with exclamation-icon warnings and field tables, path entry, approve, mock rules, "Try it", settings, and a "how to call it" panel.
5. **AI (built, narrower than first planned):** the AI step turns rules the document states in words into structured checks (see test automation, step 4), with a model dropdown. The Excel-to-OpenAPI conversion itself is deterministic, not AI, because the sample's layout is regular.
6. **MCP facade (built):** `POST /api/sim-mcp/:projectId` serves the approved APIs of a project as MCP tools (one per operation), through the same code as the hosted endpoint. Checked with the runner's own MCP client. The agent runner only accepts https addresses, so it works on a portal reached over https.
7. **Versioning (built):** a version diff in plain sentences, and Postman collections as a third import format. The contract check against the real API is "Compare both" on the case sheet.

### Added after the first plan
- **Word and Excel of any layout are read by AI** (`ai-extract.ts`, `ai-import.ts`). Both document types vary from project to project, so nothing in the reader knows a layout: the document is converted to text, an outline call finds the APIs and the general information, and one call per API returns a description that is checked and rebuilt into a draft. It runs as a background job with progress, with the model chosen from the dropdown. OpenAPI and Postman files are read directly, with no AI. The fixed-layout Excel reader still exists as an optional choice for workbooks laid out like the FLASH sample.
- **Updating from a new document:** reading an updated document into the same group adds a version to the APIs it recognises, matched by the same source or by method and path, keeping their operation ids, and a URL path someone typed in is kept.
- **Groups:** every API belongs to a group (the client or document). An import names the group and, optionally, the version of the document ("v1.9"), which is shown on each spec version. Deleting a group removes all its APIs with their versions and rules. Importing into a different group keeps a separate copy instead of adding a version.
- **Mock rules from the document's own error samples**, one click each.
- **Scheduled API test runs** (`api-schedule.ts`): a case set run on a cron schedule against the simulation, the live API or both, with a run history shared with the Run button. Locally a timer runs it; on AWS the new `api-test-runs` schedule in `infra/lib/portal-stack.ts` (not deployed).
- The simulation tables repair themselves when the database is opened (`ensureApiSimSchema` in `server/db.ts`), because migration numbers are positions in a list and a database that has met another branch can skip one.

### Not built
- Stateful mocks (a POST followed by a GET that returns what was created).
- A stored per-call log in the run view (calls only print a console line).
- Stored, encrypted credentials for the live API in hosted and MCP calls (a vault reference is used for test runs; a caller sends its own login for live calls).
- Word files that are not in the document order the converter expects (scanned or image-only documents).
- The AI steps have only been run against stand-in models that return fixed answers, not a real one.
- The DynamoDB repository type-checks but has not been run against DynamoDB.

## Test automation: generating tests from the specs

Read of `server/testing/` and `web/src/pages/tests/` on 2026-11-10. Steps 1 to 5 below are built; the notes say how.

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
1. **(built)** Deterministic generator (`server/api-sim/test-cases.ts`, route `POST /api/projects/:pid/tests/:tpid/case-sets/from-api`). It is reached from the existing "Generate test cases" dialog, where the API specification is optional: choose an API from the simulation, or import a file that is read for the cases only and not added to the simulation. A description is then optional too; with one, the AI generation also runs and makes its own case set. Tested: every generated runnable case gets the status it expects from the mock engine and from the hosted endpoint. Limits today: a rejected request is assumed to return HTTP 400, a successful one is checked by status only, and a rule stated only in words becomes a manual case.
2. **(built, differently from the first sketch)** API runs without a browser: the existing script runner needs one and the cloud portal has none, so `server/api-sim/api-runner.ts` runs a case set's API cases directly: in-process against the simulation, or over HTTP (SSRF-checked) against the client's live address. Settings per test project (`GET/PUT .../api-target`): which APIs, how the client's API reports a rejected request (HTTP status or a result code in the body), and a live login header that must be a vault reference (never a plain secret) and replaces the placeholder token in the cases that send one. Results are written into the sheet as Status and a "Run [...]" remark.
3. **(built)** Response check: a successful answer is compared with the specification's response fields (`assert_schema` as part of the run, not as a new step kind), and the error style setting. The scripts the generator writes still use the old `api_request` step and are not changed.
4. **(built, with a different design)** Rules the document states in words ("mandatory when action = 142"). Instead of an AI that writes extra test cases (which the simulation could not answer correctly), the AI turns each rule into a **structured check** once, at specification time (`server/api-sim/ai-rules.ts`, `rules.ts`). The model is chosen with the existing credential/model dropdown. Its answer is never trusted: only rules whose fields exist in the request, with a short list of tests, are kept, as *suggested*, on a new draft version. A person confirms each one; only confirmed rules are enforced by the simulation (HTTP 400 naming the field) and used by the test generator, which then writes exact cases from them with no AI (condition met, field given / missing, condition not met). Limits: rules may only refer to fields outside lists, and only "these fields are required when ..." is supported. Not checked against a real model here, only against a stand-in that returns fixed answers.
5. **(built)** Mock-versus-live comparison ("Compare both" on the case sheet): runs the same cases on both and lists the ones that pass on the simulation but fail on the live API. Scheduled runs are not built.

## Risks

- AI output quality on messy documents. Mitigation: the deterministic parse does most of the work; AI fills in types, enums and flags; the team reviews before approval.
- Conditional rules in prose cannot all be turned into machine checks. They stay as warnings.
- The simulation is only as accurate as the client document. The contract check (phase 7) is the safeguard once a real API exists.
- Live mode forwards stored credentials; it reuses the SSRF guard and the existing encrypted-config handling.
