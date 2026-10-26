# MCP Server Catalogue & Integration Guide

**Who this is for:** junior developers getting started with the portal, and senior developers
who want to extend it with production-grade integrations.

**What is an MCP server?** MCP (Model Context Protocol) is an open standard that lets agents
call tools running in a separate process. The portal acts as the MCP client: it spawns or
connects to an MCP server, hands it to the agent, and the agent calls its tools just like
any built-in tool. No portal code changes are needed to add a new capability — you only
need to register the server under **Integrations**.

---

## Table of contents

1. [How integrations work in this portal](#how-integrations-work)
2. [Two connection types](#two-connection-types)
3. [MCP server catalogue](#mcp-server-catalogue)
   - [Tier 1 — Built-in packs (one click)](#tier-1--built-in-packs)
   - [Tier 2 — First-party servers (copy-paste setup)](#tier-2--first-party-servers)
   - [Tier 3 — Community servers (advanced)](#tier-3--community-servers)
4. [Step-by-step: adding your first integration](#step-by-step-adding-your-first-integration)
5. [Step-by-step: adding a custom stdio server](#step-by-step-adding-a-custom-stdio-server)
6. [Attaching an integration to a session](#attaching-an-integration-to-a-session)
7. [Security rules every integration follows](#security-rules)
8. [Troubleshooting](#troubleshooting)

---

## How integrations work

```
Your project session
       │
       ▼
   Agent run (Claude / Kiro)
       │  calls tool: "create_jira_issue"
       ▼
   Portal MCP client  ──────────────────────► MCP server process
                        stdio or HTTP             (Jira, browser, etc.)
                        JSON-RPC 2.0
```

1. You register a server under **Integrations** (a URL for HTTP, or a command for stdio).
2. You attach the integration to a **Workspace** or pick it when starting a session.
3. When the session starts, the portal either spawns the process or opens the HTTP connection.
4. The agent sees the server's tools alongside its built-in ones and can call them freely.
5. **Read-only by default.** Tools whose names indicate a write operation (create, update,
   delete, put, post, …) are blocked unless you tick "Allow writes" on the integration.

---

## Two connection types

### HTTP (remote or local)

The server listens on an HTTP port and speaks Streamable HTTP MCP.

- Works for servers you do not control (hosted SaaS like Atlassian's Rovo).
- Works for servers running on the same host (`http://localhost:PORT`).
- Secrets go in HTTP headers (e.g. `Authorization: Bearer …`).

### stdio (command on the portal server)

The portal spawns the server as a child process and communicates over stdin/stdout.

- Requires admin permission (the process runs on the server with the portal's OS user).
- Works for any npm/npx/uvx package that implements MCP over stdio.
- Secrets go in environment variables.
- No network port exposed — the safest option for local tools.

---

## MCP server catalogue

### Tier 1 — Built-in packs

These are managed by the portal and installed with a single button click under
**Settings › Tools** (admin only). They need no manual configuration.

| Pack | What the agent can do | Install |
|---|---|---|
| **Documents pack** *(planned)* | Upload PDFs, Word, Excel, PPTX; generate Word/Excel/PPTX from sessions | Settings › Tools › Install |
| **Icon diagrams (draw.io)** | Look up official AWS/Azure/GCP/Kubernetes icons, draw architecture diagrams | Settings › Tools › Install |
| **Web browser** | Open pages, click, fill forms, take screenshots, run JavaScript | Settings › Tools → then `docker compose --profile browser up -d` |
| **uv / uvx** | Run AWS API MCP server, custom uvx-based MCP servers | Settings › Tools › Install |
| **Kiro CLI** | Use Kiro as the agent engine | Settings › Tools › Install |

---

### Tier 2 — First-party servers

Well-maintained servers with official support. Junior developers: start here.

---

#### 🔵 Atlassian Jira & Confluence
**What the agent can do:** search issues, create/update Jira tickets, read Confluence pages,
post comments, change issue status.

**Connection type:** HTTP (Atlassian hosts the server)  
**URL:** `https://mcp.atlassian.com/v1/mcp`  
**Auth:** your Atlassian email + an API token from https://id.atlassian.com/manage-profile/security/api-tokens

**Setup (junior):**
1. Go to **Integrations** → click the **Jira & Confluence** tile.
2. Enter your Atlassian email and paste your API token.
3. Click **Save**, then **Test** — you should see "Connected".
4. Attach to a workspace under **Workspaces › Edit**.

**Setup (senior — team-wide):**
- Use a service-account email and a long-lived token.
- Set scope to **Team** so all project members can use it.
- In the Jira project, give the service account the "Developer" role at minimum.

---

#### 🟠 AWS API (read-only)
**What the agent can do:** query CloudWatch Logs, describe Lambda functions, list DynamoDB
tables and items, read CloudFormation stacks, describe ECS services, and ~300 other read
operations across all AWS services.

**Connection type:** stdio (portal spawns `uvx awslabs.aws-api-mcp-server`)  
**Requires:** uv pack installed (Settings › Tools)  
**Auth:** an AWS connection already set up under **Connections**

**Setup (junior):**
1. Install the uv pack under **Settings › Tools** (one-time, admin only).
2. Go to **Integrations** → click the **AWS (read-only)** tile.
3. Pick the AWS connection to use.
4. Click **Save**.

**Setup (senior — least-privilege):**
- Create an IAM role with `ReadOnlyAccess` and attach it to the portal's EC2 instance role,
  or create an IAM user with a scoped policy covering only the services the agent needs.
- Consider a separate AWS connection per project so spend and permissions are isolated.

---

#### 🌐 Web browser (Playwright MCP)
**What the agent can do:** navigate to any URL, read page content, click buttons, fill forms,
take screenshots, evaluate JavaScript in the page, extract structured data.

**Connection type:** stdio (browser runs in an isolated container)  
**Requires:** Browser pack (`docker compose --profile browser up -d`)

**Setup:**
1. `docker compose --profile browser up -d` on your host.
2. The portal auto-creates a "Web browser" integration — no manual steps.
3. In a session, toggle **Browser on** in the Tools row, or use the slash command `/browser on`.

**Security note:** each run gets its own isolated browser context. Sessions never share
cookies or history. The browser container is not reachable from outside the compose network.

---

#### 🟣 GitHub (via MCP)
**What the agent can do:** read/create issues and PRs, search code, list repositories,
read file contents, create branches.

**Connection type:** HTTP  
**URL:** `https://api.githubcopilot.com/mcp/` (GitHub Copilot MCP, requires Copilot subscription)
or self-host `@modelcontextprotocol/server-github` via stdio.

**HTTP setup (junior):**
1. Go to **Integrations** → **New integration** → kind: **Custom MCP (HTTP)**.
2. Name: "GitHub", URL: `https://api.githubcopilot.com/mcp/`
3. Add header: `Authorization` = `Bearer YOUR_GITHUB_TOKEN`
4. Leave "Allow writes" **off** for read-only; tick it if the agent should create branches/PRs.

**stdio setup (senior — self-hosted):**
```bash
# Verify it works locally first
npx -y @modelcontextprotocol/server-github
```
1. Go to **Integrations** → **New integration** → kind: **Custom MCP (command)** (admin only).
2. Command: `npx`, Args: `-y @modelcontextprotocol/server-github`
3. Env variable: `GITHUB_PERSONAL_ACCESS_TOKEN` = your token
4. Click **Save**.

---

#### 🟡 Slack
**What the agent can do:** post messages, read channel history, search messages, list channels
and members (with appropriate OAuth scopes).

**Connection type:** HTTP  
**URL:** `https://mcp.slack.com/sse` (Slack's hosted MCP, requires a Slack app)

**Setup:**
1. Create a Slack app at https://api.slack.com/apps with scopes:
   `channels:read`, `chat:write`, `channels:history`, `users:read`
2. Install the app to your workspace, copy the Bot Token (`xoxb-…`).
3. Go to **Integrations** → **New integration** → kind: **Custom MCP (HTTP)**.
4. Name: "Slack", URL: `https://mcp.slack.com/sse`
5. Header: `Authorization` = `Bearer xoxb-YOUR-TOKEN`
6. Tick "Allow writes" to let the agent post messages.

---

#### 🟢 Google Drive / Docs / Sheets
**What the agent can do:** read and search Drive files, read Docs content, read Sheets data,
create/update Docs and Sheets (with writes allowed).

**Connection type:** stdio  
**Package:** `@google-labs/google-drive-mcp`

```bash
# Test locally first
npx @google-labs/google-drive-mcp --help
```

**Setup (senior):**
1. Create a Google Cloud project, enable Drive + Docs + Sheets APIs.
2. Create a service account, download its JSON key.
3. **Integrations** → **New integration** → kind: **Custom MCP (command)**.
4. Command: `npx`, Args: `-y @google-labs/google-drive-mcp`
5. Env vars: `GOOGLE_APPLICATION_CREDENTIALS` = `/path/to/service-account.json`

**Setup (junior — OAuth):**
Use a personal OAuth token:
- `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REFRESH_TOKEN`
- Easier to get started; not suitable for team-wide use.

---

#### 🔴 Notion
**What the agent can do:** read and search Notion pages, databases and blocks; create pages
and database rows; update page content.

**Connection type:** HTTP  
**URL:** `https://api.notion.com/mcp`

**Setup:**
1. Go to https://www.notion.so/profile/integrations → create an Internal integration.
2. Grant it access to the pages/databases you want the agent to use.
3. Copy the Internal Integration Token.
4. **Integrations** → **New integration** → kind: **Custom MCP (HTTP)**.
5. Name: "Notion", URL: `https://api.notion.com/mcp`
6. Header: `Authorization` = `Bearer ntn_YOUR_TOKEN`
7. Header: `Notion-Version` = `2022-06-28`

---

#### 🗄️ PostgreSQL / MySQL / SQLite
**What the agent can do:** run queries, inspect schema, list tables and columns.

**Connection type:** stdio  
**Package (Postgres):** `@modelcontextprotocol/server-postgres`  
**Package (MySQL):** community packages vary — see https://github.com/topics/mcp-server  

**Setup (Postgres, senior):**
```bash
npx @modelcontextprotocol/server-postgres postgresql://user:pass@host:5432/dbname
```
1. **Integrations** → **New integration** → kind: **Custom MCP (command)**.
2. Command: `npx`, Args: `-y @modelcontextprotocol/server-postgres`
3. Env: `DATABASE_URL` = `postgresql://user:pass@host:5432/dbname`
4. **Leave "Allow writes" OFF** unless you intend for the agent to run INSERT/UPDATE/DELETE.

**Security note for seniors:** create a read-only Postgres role for agent use:
```sql
CREATE ROLE agent_reader LOGIN PASSWORD 'strong_password';
GRANT CONNECT ON DATABASE mydb TO agent_reader;
GRANT USAGE ON SCHEMA public TO agent_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO agent_reader;
```
Then use that role's credentials in the integration.

---

### Tier 3 — Community servers

These require more setup and are aimed at senior developers or those with specific needs.

| Server | Transport | Package / URL | Use case |
|---|---|---|---|
| **Filesystem** | stdio | `@modelcontextprotocol/server-filesystem` | Read/write specific directories on the portal server |
| **Redis** | stdio | `@modelcontextprotocol/server-redis` | Read keys, inspect cache state |
| **Elasticsearch** | stdio | community | Search and read ES indices |
| **Linear** | HTTP | `https://mcp.linear.app/sse` | Linear issues, cycles, projects |
| **PagerDuty** | stdio | `mcp-server-pagerduty` (uvx) | Read incidents, escalation policies |
| **Sentry** | stdio | `mcp-server-sentry` | Read errors and traces |
| **Datadog** | HTTP | `https://mcp.datadoghq.com/mcp` | Metrics, logs, dashboards |
| **Confluence standalone** | stdio | community | On-prem Confluence without Atlassian cloud |
| **OpenAPI / Swagger** | stdio | `mcp-openapi-server` | Turn any REST API spec into agent tools |
| **Docker** | stdio | `vonwig/mcp-docker` | List containers, inspect images, pull logs |
| **Kubernetes** | stdio | `mcp-server-kubernetes` | List pods, read logs, describe resources |
| **Terraform Cloud** | HTTP | community | Plan, apply, read workspace state |

**Finding more:** https://github.com/modelcontextprotocol/servers (official) and
https://github.com/punkpeye/awesome-mcp-servers (community list).

---

## Step-by-step: adding your first integration

This example adds a **Custom MCP over HTTP** (e.g. an internal tool your team built).

### For junior developers

1. **Open Integrations** from the left menu.
2. Click **New integration**.
3. Choose a kind from the dropdown — pick **Custom MCP (HTTP)** for a remote server.
4. Fill in:
   - **Name** — anything descriptive, e.g. "Internal analytics API"
   - **URL** — the full address of the MCP server, e.g. `https://analytics.internal/mcp`
   - **Secret headers** — if the server needs auth, click **Add header**, enter the name
     (e.g. `Authorization`) and the value (e.g. `Bearer my-token`). The value is
     write-only: once saved you cannot read it back.
5. **Scope** — "Only you" to keep it personal, "Team" to share with everyone.
6. Click **Save**, then click **Test** to verify the server responds.
7. **Attach to a workspace** — go to **Workspaces**, open the workspace you use, and add
   the integration from the list.

That's it. The next session you start in that workspace will have the server's tools
available to the agent.

### For senior developers

Same steps, plus:
- **"Allow writes"** toggle: off by default. Turn it on only if the server exposes
  mutation tools you need (the portal's guard still blocks destructive patterns).
- **Validate the server manually** before adding it:
  ```bash
  curl -N -H "Authorization: Bearer TOKEN" \
       -H "Content-Type: application/json" \
       -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
       https://your-mcp-server/mcp
  ```
  You should get a JSON response listing the available tools.
- **Pin a specific version** for stdio servers: use `npx package@1.2.3` in the Args
  field rather than `npx package@latest`. This prevents unexpected tool behaviour
  after upstream releases.

---

## Step-by-step: adding a custom stdio server

Stdio servers run as a child process on the portal's host. This is admin-only because the
process runs with the portal's OS permissions.

### Prerequisites

- Admin account on the portal.
- The MCP server package installable via `npx`, `uvx`, or a direct binary path.
- Access to the portal's host (Docker exec, SSH, etc.) to test the command first.

### Step 1 — Test the command on the host

```bash
# For an npm/npx server:
npx -y some-mcp-server --help

# For a uvx server (requires uv pack installed):
uvx some-mcp-server --help
```

If the command prints a help message without errors, it's ready.

### Step 2 — Register in the portal

1. Open **Integrations** → **New integration**.
2. Kind: **Custom MCP (command)** (visible to admins only).
3. **Command**: `npx` (or `uvx`, or an absolute path like `/usr/local/bin/my-server`)
4. **Args**: `-y some-mcp-server --flag value` (space-separated, one per line in the UI)
5. **Environment variables**: click **Add env var** for each secret:
   - Name: `API_KEY`, Value: your secret
   - Values are stored encrypted and never shown after saving.
6. Click **Save** → **Test**.

### Step 3 — Confirm it works

The **Test** button spawns the process, sends a `tools/list` request, and reports back the
number of tools found. A healthy response looks like:

```
Connection OK — 12 tools available
```

If it fails, check the error message:
- `spawn ENOENT` — the command was not found; make sure `npx`/`uvx` is on PATH.
- `Timeout` — the server took more than 5 s to respond; it may be downloading packages.
  Add `--yes` to the npx args to pre-accept prompts, or pre-install the package.
- `Exit code 1` — the server crashed; check its docs for required env vars.

### Step 4 — Pin the version (senior)

```
# Instead of:   npx -y some-mcp-server
# Use:           npx -y some-mcp-server@2.1.0
```

This prevents the agent's tools from changing unexpectedly when the package releases
a new version.

---

## Attaching an integration to a session

Once an integration is registered, you have two ways to use it:

### Option A — Through a Workspace (recommended for recurring use)

1. Go to **Workspaces** in the left menu.
2. Open (or create) a workspace.
3. Under **Integrations**, add one or more integrations from the list.
4. When you start a session and pick this workspace, the integrations are automatically
   available to the agent.

### Option B — Per-session (one-off)

1. Open the **New session** dialog.
2. In the **Tools for this session** row, integrations attached to the selected workspace
   appear as toggles.
3. Toggle the ones you need for this run.

The agent sees every enabled integration's tools and can call them without any further
setup. It does not "know" it is calling a remote server — the tools look identical to
built-in ones.

---

## Security rules

Every integration follows these rules regardless of how it is configured:

| Rule | Detail |
|---|---|
| **Read-only by default** | Tools whose names match write patterns (create, update, delete, put, patch, post, write, set, …) are blocked unless "Allow writes" is on |
| **Secrets are write-only** | Token/key values are AES-256-GCM encrypted at rest and never returned to the browser |
| **Scope limits access** | Personal integrations are invisible to other users via the API (404) |
| **No portal secrets in scope** | The spawned process receives only the env vars you explicitly listed — portal's DB path, secret key, etc. are never passed |
| **Tool name cap** | Each server can expose at most 128 tools; beyond that the extras are ignored |
| **stdio = admin only** | Only admins can register commands; regular users can only add HTTP servers |
| **URL validation** | HTTP integrations must use `https://` in production mode (or `http://localhost` for local development) |

---

## Troubleshooting

### "Connection failed" on Test

- **HTTP**: check the URL is reachable from the portal server (not just your browser).
  Inside Docker: `docker compose exec portal curl -I https://your-server/mcp`
- **stdio**: the command may not be on PATH inside the container. Check with:
  `docker compose exec portal which npx`

### "0 tools available" on Test

The server started but returned an empty tool list. Common causes:
- Wrong server version — some packages changed their tool list in a minor version.
- Missing required env var — the server silently skips tool registration if its
  config is incomplete. Check the server's README for required env vars.

### The agent says it cannot find a tool

The integration may not be attached to the workspace/session. Check:
1. **Integrations** — does the integration show "Healthy"?
2. **Workspaces** — is it listed under the workspace used by the session?
3. In the session, run `/tools` to see which MCP servers are active.

### stdio server keeps restarting

The portal restarts the process on each run (by design — no state leaks between sessions).
If the server takes more than 10 s to start, the run will time out. Pre-install the package:

```bash
# Inside the container, pre-install so npx doesn't download it each time:
docker compose exec portal npm install -g some-mcp-server@2.1.0
# Then in the integration, use: node /usr/local/lib/node_modules/some-mcp-server/dist/index.js
```

### Writes are being blocked

The portal's write guard blocks mutating tools unless "Allow writes" is enabled.
Go to the integration, click **Edit**, and toggle **Allow writes** on.
If a specific tool is still blocked, check the tool's name — it may contain a keyword
that triggers the guard (`delete`, `remove`, `destroy`, `truncate`, etc.).

---

*Last updated: 2026-10-26*
