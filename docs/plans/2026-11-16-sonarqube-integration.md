# SonarQube integration — plan

Date: 2026-11-16
Status: **plan only, nothing built yet** (a first look at the code found one blocker for Phase A, see A2)

## Goal

Let a team use SonarQube (Cloud, Server or Community Build) for code scanning from the portal: see the issues and the quality gate of a
branch or pull request, triage and fix them with an agent, and, in a second step, treat them like any other review finding (accept or
reject, post to the PR, block a merge).

Not goals (for now): running the scanner inside the portal's runners (Phase C), replacing the portal's AI review, managing Sonar
projects, rules or quality profiles from the portal.

## What the portal already has

| Piece | Where | Why it matters |
|---|---|---|
| Findings with file, line, severity (`critical/high/medium/low/info`), title, body, confidence; accept/reject; post to the PR; merge gate by minimum severity; re-run; export to Excel/Word; dashboard | `server/review.ts`, `server/repositories/reviews.ts` | Sonar issues map onto this almost one to one (Phase B) |
| Per-project remote MCP servers ("Tools & services"): the URL and secret headers are stored encrypted, tested on save, offered to agents read-only unless "Allow writes" is on, optionally personal to one person | `server/integrations.ts`, `server/agent/runner-integrations.ts`, `web/src/pages/Integrations.jsx` (`MCP_PRESETS`) | Phase A is this, with a SonarQube preset |
| A Streamable-HTTP MCP client (POST with JSON or SSE replies, `Mcp-Session-Id`) | `server/agent/runner-mcp.ts` (`McpHttpClient`, `isReadOnlyTool`) | Same transport Sonar's MCP server uses: no new transport code |
| Built-in prompt commands (`/init`, `/review`) that become a prompt for the agent in any engine | `server/workflows/session-commands.ts` | A `/sonar` command fits here |
| Runners on the public network | `infra/lib/harness-stack.ts` (`networkMode: 'PUBLIC'`) | They can reach a SonarQube that is reachable from the internet, and **cannot** reach a private one |
| Encrypted secrets | `server/secrets.ts` | Where a Sonar token would be kept (Phase B) |

The runner images have no Java.

## What SonarQube offers (checked against Sonar's own docs, 2026-11-16)

- An official MCP server for SonarQube Cloud, Server and Community Build: [repository](https://github.com/SonarSource/sonarqube-mcp-server),
  [tool list](https://docs.sonarsource.com/sonarqube-mcp-server/reference/tools).
- **Hosted by SonarQube Cloud:** `https://api.sonarcloud.io/mcp` (US region: `https://api.sonarqube.us/mcp`). Headers:
  `Authorization: Bearer <user token>` (required; the old `SONARQUBE_TOKEN` header is deprecated) and `SONARQUBE_ORG: <organization key>`.
  Docs: [Cloud-hosted](https://docs.sonarsource.com/sonarqube-mcp-server/setup/sonarqube-cloud-hosted).
  The hosted service also accepts OAuth.
- **Self-hosted (Server or Community Build):** you run Sonar's MCP server yourself in HTTP(S) mode (`SONARQUBE_TRANSPORT=http|https`,
  default port 8080, endpoint `/mcp`), and give it your server URL. Streamable HTTP only; the older SSE-only transport is unsupported.
  Docs: [self-hosted](https://docs.sonarsource.com/sonarqube-mcp-server/setup/self-hosted).
- Tools that matter for scanning: `search_my_sonarqube_projects`, `list_branches`, `list_pull_requests`, `get_project_quality_gate_status`,
  `search_sonar_issues_in_projects`, `search_security_hotspots`, `show_security_hotspot`, `show_rule`, `get_raw_source`,
  `get_component_measures`, `get_duplications`, `search_files_by_coverage`.
- Tools that change data: `change_sonar_issue_status`, `change_security_hotspot_status`, `create_webhook`, `toggle_automatic_analysis`,
  `architecture_set`. Some tools are unavailable on the Cloud-hosted server (for example `run_advanced_code_analysis`, the System tools).
- A user token (My Account > Security) is needed; give it the least access that works.

## Options

| | What it does | Effort | Limits |
|---|---|---|---|
| **A. Sonar's MCP server as a per-project tool, plus `/sonar`** | Agents query issues, hotspots and the quality gate during a session | Small | Agent-driven only: no gate, no dashboard, no PR comments |
| **B. A built-in Sonar connection in Reviews** | Portal fetches a PR's or branch's issues and quality gate from Sonar and shows them as normal findings | Medium | Relies on the team's CI to run the scan |
| **C. The portal runs the scan** | The runner runs `sonar-scanner` and uploads | Large | Java in the image, each language's build, long runs |
| **D. Import a Sonar report file** | Upload an export, parse it into findings | Small | Manual; as fresh as the export |

**Decision:** do A, then B. C only if the team has no CI scanning. D is the fallback for a Sonar the portal cannot reach.

## Phase A — Sonar's MCP server as a tool, and `/sonar`

### A1. Two presets in `MCP_PRESETS`

- **SonarQube Cloud**: URL `https://api.sonarcloud.io/mcp`; header rows `Authorization` (value "Bearer " + user token) and
  `SONARQUBE_ORG` (organization key). The hint mentions the US URL and that "Allow writes" should stay off.
  A preset today carries one header (`header`); allow a list (`headers`) and keep `header` working for the existing presets.
- **SonarQube Server**: no URL filled in (it is the team's own MCP server, `https://<host>:<port>/mcp`), one `Authorization` row. The hint
  says it must be reachable from the internet over HTTPS, because the runners are on the public network and the cloud portal refuses
  private addresses.

### A2. Header names: allow `_` (blocker found while planning)

`HEADER_NAME_RE` in `server/integrations.ts` is `/^[A-Za-z0-9-]{1,64}$/`, so `SONARQUBE_ORG` is rejected and the Cloud preset could
not be saved. An underscore is a valid header-name character (RFC 9110 token). Change the rule to `/^[A-Za-z0-9_-]{1,64}$/`. Nothing
else uses the rule; no existing test depends on it. (Some reverse proxies drop headers with underscores; Sonar's own docs use this name.)

### A3. What the agent is offered

By default an integration offers only tools that are read-only: `readOnlyHint: true`, or (when there is no hint) a name starting with
`get/list/search/read/describe/fetch/query/find/view/show/lookup/count`. For Sonar that means the issue, hotspot, quality-gate, rule and
source tools are offered, and `change_*`, `create_webhook`, `toggle_*` and `architecture_set` are not. Two read tools with other names
(`analyze_code_snippet`, `architecture_get`) would be hidden unless the name rule or Sonar's annotations cover them. **To confirm against
a live server**: whether Sonar sets `readOnlyHint` on its tools; the "N of M tools offered" line shown after Test says what is offered.
No change to the rule is planned.

### A4. `/sonar [project key] [branch | pr N] [notes]`

A built-in prompt in `PROMPTS` (`server/workflows/session-commands.ts`), the same kind as `/review`. The prompt tells the agent to:

1. Use the SonarQube tools connected to the project. If there are none, say so and point to **Tools & services**; do not invent results.
2. Find the project (the key if given, else `search_my_sonarqube_projects` matched to the repository's name; ask if more than one fits).
3. Choose the scope (a branch or PR if given, else the repository's current branch; say which one has an analysis).
4. Report the quality gate (passed or failed, and the failing conditions), then all open issues (page through all of them) and the
   security hotspots to review.
5. Write the result as a short summary (counts by severity and type) and a list, most serious first: severity, rule, `file:line`,
   message, and a concrete fix after reading the code at that line (`show_rule` for rules that are not obvious).
6. Save the full report in the **work folder** (not `/tmp`), as `sonarqube-report.md`.
7. Not change any issue's status and not edit code unless asked.

### A5. Tests

- A fake Sonar MCP server (Streamable HTTP, an SSE reply for `tools/list`, `Mcp-Session-Id`) that insists on `Authorization: Bearer` and
  `SONARQUBE_ORG`, with Sonar's real tool names. Through the portal's real code: the connection test says "Connected. N of M tools
  offered (read-only)", a wrong token fails, `change_*` and `create_webhook` are not offered, and are offered with "Allow writes".
- The create route accepts a Sonar-shaped body (both headers, including `SONARQUBE_ORG`) and still refuses a bad header name.
  (The create route requires `https://`, so the connection test seeds the stored record directly.)
- `/sonar` appears in the command menu and `/help`; the prompt carries the key steps and the arguments.
- A browser test of the preset: picking "SonarQube Cloud" fills the URL and both header rows and shows the hint.
- Each of these is checked by breaking the thing it protects and seeing the test fail.

### A6. Docs

A "SonarQube" entry in `docs/mcp-server-catalogue.md`, a help topic line for `/sonar`, and this plan.

### A7. Acceptance on the live portal (needs a real token)

Add the preset, press Test (expect "Connected"), start a Kiro or Claude session on a repository that has a Sonar project, run `/sonar`,
and compare the issue and hotspot counts and the quality gate with the Sonar web UI.

### Risks (A)

- **A private SonarQube Server** cannot be reached from the runners, and the cloud portal blocks private addresses. It needs a public
  HTTPS address (for example behind a proxy that requires the token), or Phase B with server-side connectivity.
- **The token is personal.** Use the integration's "personal" option so only its creator's sessions use it, and a read-only token.
- **OAuth for the Cloud-hosted endpoint** is supported by Sonar, and the portal has its own OAuth flow for integrations (`auth: 'oauth'`).
  Not verified to work together; token headers are the plan.

## Phase B — a built-in connection in Reviews (design; to be refined after A)

1. **Connection (per project)**: server URL, organization (Cloud), token (encrypted with `secrets.ts`); and, per repository, the Sonar
   project key. Test button. Personal or shared, as for integrations.
2. **Fetch (server side, Sonar Web API; endpoint names to confirm against the team's SonarQube version)**: issues for a branch or pull
   request (open and confirmed), the quality-gate status of that branch or PR, and the hotspots to review, paged.
3. **Map to findings**: file (the component key without the project key), line, title (rule name), body (message, rule key, link to the
   issue in Sonar), severity. Legacy severities `BLOCKER/CRITICAL/MAJOR/MINOR/INFO` map to `critical/high/medium/low/info`; newer
   SonarQube versions use impact levels (`HIGH/MEDIUM/LOW`), which map to `high/medium/low`. Confidence stays empty. De-duplicate by the Sonar issue key.
4. **Mark the origin**: a `source` on findings (AI review or SonarQube) and the Sonar issue key. This needs a column in both repositories
   (SQLite and DynamoDB) and contract tests on both.
5. **Where it shows**: the review of the PR (a "SonarQube" origin on its findings, with the quality-gate result at the top) and the Reviews
   dashboard counts. Accept, reject, post to the PR, export and the merge gate then work as they do now. A setting makes a failed
   quality gate block a merge.
6. **When**: an "Import from SonarQube" button on a review and a branch scan; later, a Sonar webhook (quality-gate result) into the portal.
7. **Tests**: the mapping (every severity, a PR with no analysis, paging, a moved or deleted file), both repository backends, a fake Sonar
   API, and the review page in a browser.

Open questions for B: how a review's PR number or head ref lines up with Sonar's pull-request analysis name; whether one review may hold
issues from several Sonar projects (a monorepo); who may see the token.

## Phase C — the portal runs the scan (deferred)

Only if the team has no scanning in CI. It needs the scanner CLI and Java in the runner image, a build for compiled languages, network
access from the runner to Sonar, a token inside the run, and enough time within the runner's limits. Decide after A and B.

## Phase D — import a report (fallback)

Upload a Sonar export (JSON or the zip the team already downloads), parse it into findings with the Phase B mapping. Useful when the
portal cannot reach Sonar. Small once B's mapping exists.

## Questions for the team

1. Which SonarQube: Cloud, Server or Community Build, and which version?
2. Can it be reached from the internet over HTTPS (or can a public proxy be put in front)?
3. Does CI already scan pull requests (which decides B versus C)?
4. Which projects and repositories, and how are the project keys named?
5. Which severity (or a failed quality gate) should block a merge?
6. One shared token for the project, or each person's own?

## Order of work

A1 to A7 first (small, and it answers the connectivity questions with a real server), then B. The sizes are rough guesses: A about a
day, B several days.
