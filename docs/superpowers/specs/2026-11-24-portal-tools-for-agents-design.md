# Portal tools for agents

Date: 2026-11-24. Status: approved by the owner ("Merge all of them to main_v3 and deploy", after the two-part proposal), built.

## Intent

Agents did not understand the portal's own services: "the vault" was guessed as Azure Key Vault or Drive, "google it" opened
Google in the cloud browser (which blocks automated browsers), connected integrations appeared as unexplained tool names, and
agents could not read the project's Knowledge or the Vault at all.

## Design

1. **Portal tools briefing** (server/agent/portal-tools-guidance.ts), appended to every run's task after the person's text and
   built from what the run has: web search first (the engine's search tool, else WebFetch on DuckDuckGo's HTML page; never a
   search engine in the browser); the browser for a specific site only; what Knowledge and the Vault are and how to use them; each
   connected integration with its purpose; Jira without the Atlassian sign-in; the project's AWS account. It replaces the
   separate vault and Jira hints. The browser guidance is reworded to match.
2. **Portal data MCP** (server/portal-data-mcp.ts): `POST /api/mcp/portal-data`, read-only tools `search_knowledge`,
   `list_knowledge`, `list_vault` (team / mine) and `read_vault_file` (text as is; Word, Excel, PowerPoint and PDF converted).
   Authenticated by a 12-hour HMAC token naming the person and the project (`pd_…`, the same pattern as the Google Workspace
   server); every call re-checks that the person may see the project; Vault visibility is the Files panel's (personal files of
   that person only, project files, portal-wide files). Added first to every cloud run's MCP servers when the portal has an
   https public address. The tool policy already allows read-only MCP tools without asking.
3. SQLite keyword search now matches any word (quoted, OR), like the DynamoDB index, so whole questions find passages locally too.

## Local runs (added the same day)

Claude and Kiro runs on the portal's own machine get the same server over the loopback address (`portalDataLocalSpec`,
`AgentRun.localPortalData`): Claude as an HTTP MCP server in the SDK options, Kiro as an entry in the run home's
`~/.kiro/settings/mcp.json`, removed after the run like the delegation entry. Codex and Cursor on the portal's machine take no
MCP configuration here (their config handling refuses it by design), so their briefing says to ask for an attachment.

## Not included

No write tools.
