# Agent Portal — Test Checklist

> **Auto-generated** by `npm run test:checklist` on 2026-11-18.
> Do not edit by hand — changes will be overwritten.
> Source of truth: `test/test-map.json` + `.test-pass-record.json`.

## How to use

1. Find every module whose files you changed.
2. Run: `npm run test:affected -- --dry-run` to preview what will run.
3. Run: `npm run test:affected` to run only affected modules and record passes.
4. To force a full run: `npm run test:affected -- --all`
5. To run one module: `npm run test:affected -- --module <id>`
6. To run backend only: `npm run test:affected -- --backend-only`
7. To run UI smoke only: `npm run test:affected -- --ui-only`
8. Regenerate this file: `npm run test:checklist`

## Status key

| Symbol | Meaning |
|--------|---------|
| ✅ | Passed (hash recorded) |
| ⚑ | Known failure (skipped until files change) |
| ⚠️ | Last run failed |
| ❌ | Never run / not yet tested |

## Direct test commands

```sh
# Run all backend tests
npm test

# Run backend tests for a single file
npm run test:file -- test/dashboard.test.ts

# Run affected modules (recommended)
npm run test:affected

# Dry-run: see what would run without running it
npm run test:affected -- --dry-run

# Full smoke suite (build first)
npm run test:ui

# Fast smoke suite (skip build)
npm run test:ui:fast

# Validate the module map
npm run test:map:check
```

## 1 — Authentication & Users

| Module ID | Description | Source files | Test files | Smoke IDs | Status | Last pass |
|-----------|-------------|-------------|-----------|-----------|--------|-----------|
| auth | Authentication, login, session cookies | server/auth.ts<br>server/governance/users.ts<br>server/repositories/auth.ts<br>server/repositories/auth-sqlite.ts<br>server/repositories/auth-dynamodb.ts<br>web/src/pages/Auth.jsx | test/auth.test.ts<br>test/auth-repo.test.ts<br>test/setup-security.test.ts<br>test/session-policy.test.ts<br>test/login-limiter.test.ts<br>test/client-ip.test.ts<br>test/step-up.test.ts<br>test/totp.test.ts<br>test/mfa.test.ts | auth | ❌ never run | — |
| setup | First-run setup wizard | web/src/pages/setup/SetupWizard.jsx<br>web/src/pages/setup/AdminAccount.jsx<br>web/src/pages/setup/CloudSecurity.jsx<br>web/src/pages/setup/CloudStorage.jsx<br>web/src/pages/setup/ConfirmStep.jsx<br>web/src/pages/setup/DeployTarget.jsx<br>web/src/pages/setup/ModelProvider.jsx<br>web/src/pages/hub/ProjectHub.jsx<br>web/src/components/WizardProgress.jsx<br>web/src/styles/setup-wizard.css | — | setup | ❌ never run | — |
| api-tokens | API token management and token scope enforcement | server/api-tokens.ts<br>server/repositories/api-tokens.ts<br>server/repositories/api-tokens-sqlite.ts<br>server/repositories/api-tokens-dynamodb.ts<br>web/src/pages/ApiAccess.jsx | test/api-tokens.test.ts<br>test/token-scopes.test.ts<br>test/api-tokens-repo.test.ts | api-tokens | ❌ never run | — |
| permissions | Role-based access control, permission checks | server/permissions.ts<br>server/guardrails.ts<br>server/governance/users.ts<br>server/repositories/permissions.ts<br>server/repositories/permissions-sqlite.ts<br>server/repositories/permissions-dynamodb.ts | test/permissions.test.ts<br>test/permissions-repo.test.ts | permissions | ❌ never run | — |
| audit | Audit log recording and retrieval | server/audit.ts<br>server/repositories/audit.ts<br>server/repositories/audit-sqlite.ts<br>server/repositories/audit-dynamodb.ts | test/audit-fixes.test.ts<br>test/audit-fixes-3.test.ts<br>test/audit-repo.test.ts | audit | ❌ never run | — |
| delegation | Delegate tokens for sub-agent authentication | server/delegation.ts<br>server/repositories/delegation-settings.ts<br>server/repositories/delegation-settings-sqlite.ts<br>server/repositories/delegation-settings-dynamodb.ts<br>server/repositories/sessions.ts<br>server/repositories/sessions-sqlite.ts<br>server/repositories/sessions-dynamodb.ts | test/delegate-token.test.ts<br>test/delegation.test.ts<br>test/delegation-repo.test.ts<br>test/delegation-session-repo.test.ts<br>test/agentcore-multi-agent.test.ts | delegation | ❌ never run | — |

## 2 — Projects & Workspaces

| Module ID | Description | Source files | Test files | Smoke IDs | Status | Last pass |
|-----------|-------------|-------------|-----------|-----------|--------|-----------|
| projects | Project CRUD and listing, project/team repository layer | server/projects.ts<br>server/project-settings-pr.ts<br>server/repositories/projects.ts<br>server/repositories/projects-sqlite.ts<br>server/repositories/projects-dynamodb.ts<br>web/src/pages/Projects.jsx | test/projects.test.ts<br>test/projects-repo.test.ts<br>test/project-pr-settings.test.ts | projects | ❌ never run | — |
| workspaces | Workspace management per project | server/workspaces.ts<br>server/workflows/crud.ts<br>server/repositories/workspaces.ts<br>server/repositories/workspaces-sqlite.ts<br>server/repositories/workspaces-dynamodb.ts<br>web/src/pages/Workspaces.jsx<br>web/src/components/WorkspaceHeader.jsx<br>web/src/styles/workspace.css | test/workspaces.test.ts<br>test/workspaces-repo.test.ts | workspaces | ❌ never run | — |

## 3 — Sessions, Workflows & IDE

| Module ID | Description | Source files | Test files | Smoke IDs | Status | Last pass |
|-----------|-------------|-------------|-----------|-----------|--------|-----------|
| sessions | Session lifecycle, context, files, and live run streaming | server/session-lifecycle.ts<br>server/session-context.ts<br>server/session-files.ts<br>server/runs.ts<br>server/portal-events.ts<br>server/superpowers-skills.ts<br>server/bundled-skills.ts<br>server/repositories/sessions.ts<br>server/repositories/sessions-sqlite.ts<br>server/repositories/sessions-dynamodb.ts<br>server/repositories/stats.ts<br>server/repositories/stats-sqlite.ts<br>server/repositories/stats-dynamodb.ts<br>server/repositories/vault-files.ts<br>server/repositories/vault-files-sqlite.ts<br>server/repositories/vault-files-dynamodb.ts<br>web/src/lib/session-title.js<br>server/agent/host-limit.ts<br>web/src/pages/sessions/SessionList.jsx<br>web/src/pages/sessions/SessionLive.jsx<br>web/src/pages/sessions/SessionsShell.jsx<br>web/src/pages/sessions/SessionWorkspace.jsx<br>web/src/pages/sessions/SessionChanges.jsx<br>web/src/pages/sessions/NewSessionDialog.jsx<br>web/src/pages/sessions/SwitchEngineDialog.jsx<br>web/src/lib/approvalState.js<br>web/src/lib/useRunStream.js<br>web/src/lib/mergeEvents.js<br>web/src/lib/messageHistory.js<br>web/src/lib/clearBoundary.js<br>web/src/lib/outputFileMatch.js<br>web/src/lib/outputFileUtils.js<br>web/src/lib/pullRequestCard.js<br>web/src/lib/model-groups.js<br>web/src/components/ModelOptions.jsx<br>web/src/components/AiChoicePicker.jsx<br>web/src/pages/sessions/PullRequestCard.jsx<br>web/src/styles/sessions.css | test/bundled-skills.test.ts<br>test/run-limit-clone-first.test.ts<br>test/clone-failure-explained.test.ts<br>test/create-clone-first.test.ts<br>test/session-title.test.ts<br>test/session-lifecycle.test.ts<br>test/web-idle-countdown.test.ts<br>test/session-agent-events.test.ts<br>test/session-context.test.ts<br>test/session-files.test.ts<br>test/sanitize-merge.test.ts<br>test/output-files-match.test.ts<br>test/conversation-files.test.ts<br>test/web-session-agents.test.ts<br>test/output-file-utils.test.ts<br>test/web-pull-request-session.test.ts<br>test/kiro-runner-interrupt.test.ts<br>test/kiro-runner-turn-limit.test.ts<br>test/kiro-runner-metering.test.ts<br>test/kiro-metering.test.ts<br>test/queued-messages.test.ts<br>test/lost-runs.test.ts<br>test/recovery.test.ts<br>test/web-inbox-interrupted.test.ts<br>test/agentcore-stall.test.ts<br>test/web-stop-shortcut.test.ts<br>test/web-message-history.test.ts<br>test/web-clear-view.test.ts<br>test/web-chat-attach-drop-paste.test.ts<br>test/web-pull-request-card.test.ts<br>test/sessions-repo.test.ts<br>test/engine-switch.test.ts<br>test/approval-state.test.ts<br>test/session-composer-layout.test.ts<br>test/model-groups.test.ts<br>test/session-files-vault-read.test.ts<br>test/plan-mode.test.ts<br>test/web-composer-keys.test.ts<br>test/web-edit-diff.test.ts<br>test/web-execution-summary.test.ts<br>test/web-output-card-excerpt.test.ts<br>test/web-output-excerpt.test.ts<br>test/web-session-status.test.ts<br>test/web-tool-groups.test.ts<br>test/web-session-groups.test.ts<br>test/web-execution-stages.test.ts<br>test/web-sparkline.test.ts | sessions | ⚠️ ⚠️ backend | 2b47f62 · 2026-11-17 |
| workflows | Workflow engine, controls, and driver | server/workflows/crud.ts<br>server/workflows/controls.ts<br>server/workflows/lost-runs.ts<br>server/workflows/recovery.ts<br>web/src/pages/Inbox.jsx<br>agent-runner/src/sse-keepalive.ts<br>kiro-runner/src/sse-keepalive.ts<br>codex-runner/src/sse-keepalive.ts<br>server/workflows/driver.ts<br>server/workflows/working-copies.ts<br>server/tool-packs.ts<br>server/review-lifecycle.ts<br>server/repositories/sessions.ts<br>server/repositories/sessions-sqlite.ts<br>server/repositories/sessions-dynamodb.ts | test/workflows.test.ts<br>test/session-sse.test.ts<br>test/run-events-sse.test.ts<br>test/working-copies.test.ts<br>test/resume-retry.test.ts<br>test/transcript-coalesce.test.ts<br>test/conditional-transitions.test.ts | sessions | ❌ never run | — |
| ide | In-browser IDE workspace — editor, explorer, terminal, source control, live browser | server/terminal.ts<br>server/terminal-cloud.ts<br>server/agent/runner-terminal.ts<br>server/agent/runner-terminal-auth.ts<br>server/browser-live.ts<br>web/src/pages/sessions/AgentDetail.jsx<br>web/src/pages/sessions/AgentOrbit.jsx<br>web/src/pages/sessions/AgentViews.jsx<br>web/src/pages/sessions/AgentsPanel.jsx<br>web/src/lib/agent-activity.js<br>web/src/lib/agent-timeline.js<br>web/src/lib/agent-orbit.js<br>web/src/styles/agents-panel.css<br>web/src/pages/sessions/SessionAgentsStrip.jsx<br>web/src/pages/sessions/useSessionAgents.js<br>web/src/pages/sessions/IdeAgents.jsx<br>web/src/pages/sessions/AgentGraph.jsx<br>web/src/lib/conversationFiles.js<br>web/src/pages/sessions/IdeBrowser.jsx<br>web/src/pages/sessions/IdeEditor.jsx<br>web/src/pages/sessions/IdeExplorer.jsx<br>web/src/pages/sessions/IdeHeader.jsx<br>web/src/pages/sessions/IdeOutputs.jsx<br>web/src/pages/sessions/IdeSessionPanel.jsx<br>web/src/pages/sessions/IdeSourceControl.jsx<br>web/src/pages/sessions/IdeStatusBar.jsx<br>web/src/pages/sessions/IdeTerminal.jsx<br>web/src/pages/sessions/IdeWorkspace.jsx<br>web/src/pages/sessions/OutputFilePreview.jsx<br>web/src/pages/sessions/RunOutputsCard.jsx<br>web/src/pages/sessions/codemirror-editor.jsx<br>web/src/pages/sessions/xterm-terminal.jsx<br>web/src/lib/outputFileUtils.js<br>web/src/lib/terminal-pipe.js<br>web/src/styles/ide.css | test/agent-orbit.test.ts<br>test/agent-timeline.test.ts<br>test/web-agent-detail.test.ts<br>test/browser-live.test.ts<br>test/chat-attachments-ui.test.ts<br>test/web-session-agents.test.ts<br>test/conversation-files.test.ts<br>test/terminal.test.ts<br>test/terminal-cloud.test.ts<br>test/runner-terminal.test.ts<br>test/terminal-pipe.test.ts | ide | ❌ never run | — |

## 4 — Dashboard

| Module ID | Description | Source files | Test files | Smoke IDs | Status | Last pass |
|-----------|-------------|-------------|-----------|-----------|--------|-----------|
| dashboard | Agent performance dashboard KPIs and drill-downs | server/dashboard.ts<br>server/repositories/stats.ts<br>server/repositories/stats-sqlite.ts<br>server/repositories/stats-dynamodb.ts<br>web/src/pages/Dashboard.jsx<br>web/src/components/DashboardInsights.jsx<br>web/src/components/CostPanel.jsx<br>web/src/styles/dashboard.css | test/dashboard.test.ts<br>test/stats-repo.test.ts<br>test/web-dashboard-insights.test.ts | dashboard | ❌ never run | — |

## 5 — Knowledge

| Module ID | Description | Source files | Test files | Smoke IDs | Status | Last pass |
|-----------|-------------|-------------|-----------|-----------|--------|-----------|
| knowledge | Knowledge base documents, search, ask, decisions, and learning content | server/knowledge.ts<br>server/learn.ts<br>server/repositories/knowledge.ts<br>server/repositories/knowledge-sqlite.ts<br>server/repositories/knowledge-dynamodb.ts<br>server/repositories/learn.ts<br>server/repositories/learn-sqlite.ts<br>server/repositories/learn-dynamodb.ts<br>web/src/pages/Knowledge.jsx<br>web/src/pages/Learn.jsx<br>web/src/lib/templates/index.js | test/knowledge.test.ts<br>test/knowledge-repo.test.ts<br>test/learn-repo.test.ts | knowledge | ❌ never run | — |

## 6 — Create (Diagrams / Documents / Decks)

| Module ID | Description | Source files | Test files | Smoke IDs | Status | Last pass |
|-----------|-------------|-------------|-----------|-----------|--------|-----------|
| create | Create hub page (container for Diagrams / Documents / Decks tabs) | web/src/pages/Create.jsx | test/create-repos.test.ts | create | ❌ never run | — |
| diagrams | Diagram creation and rendering — draw.io, mermaid, and icon packs | server/diagrams.ts<br>server/repositories/diagrams-data.ts<br>server/repositories/diagrams-data-sqlite.ts<br>server/repositories/diagrams-data-dynamodb.ts<br>server/drawio.ts<br>server/drawio-cloud.ts<br>server/drawio-pack.ts<br>server/drawio-render.ts<br>server/drawio-text.ts<br>server/diagram-icons.ts<br>server/diagram-text.ts<br>web/src/pages/Diagrams.jsx<br>web/src/components/DiagramStyle.jsx<br>web/src/components/MermaidViewer.jsx | test/diagrams.test.ts<br>test/resume-retry.test.ts | create | ❌ never run | — |
| generated-docs | AI-generated documents — Word/PDF/HTML generation pipeline | server/generated-docs.ts<br>server/repositories/generated-docs-data.ts<br>server/repositories/generated-docs-data-sqlite.ts<br>server/repositories/generated-docs-data-dynamodb.ts<br>server/generated-doc-text.ts<br>server/docgen.ts<br>server/docimage.ts<br>server/docs-pack.ts<br>server/doc-templates.ts<br>server/repositories/doc-templates-data.ts<br>server/repositories/doc-templates-data-sqlite.ts<br>server/repositories/doc-templates-data-dynamodb.ts<br>server/docx-template.ts<br>server/ooxml.ts<br>server/template-check.ts<br>server/convert.ts<br>server/markdown-docx.ts<br>server/guide-accounts.ts<br>web/src/pages/GeneratedDocs.jsx<br>web/src/components/GuideAccounts.jsx | test/generated-docs.test.ts<br>test/markdown-docx.test.ts<br>test/guide-accounts.test.ts<br>test/user-guide-screenshots.test.ts<br>test/web-guide-accounts.test.ts<br>test/web-guide-watch.test.ts<br>test/browser-live-view-waiting.test.ts<br>test/web-live-view-title.test.ts<br>test/create-clone-first.test.ts<br>test/resume-retry.test.ts | create | ❌ never run | — |
| presentations | AI-generated presentations — PPTX creation and preview | server/presentations.ts<br>server/repositories/presentations-data.ts<br>server/repositories/presentations-data-sqlite.ts<br>server/repositories/presentations-data-dynamodb.ts<br>server/presentation-text.ts<br>server/pptx-preview.ts<br>server/pptx-template.ts<br>web/src/pages/Presentations.jsx | test/presentations.test.ts<br>test/resume-retry.test.ts | create | ❌ never run | — |

## 7 — Vault

| Module ID | Description | Source files | Test files | Smoke IDs | Status | Last pass |
|-----------|-------------|-------------|-----------|-----------|--------|-----------|
| vault | Secret vault — project, personal, and portal secrets | server/vault.ts<br>server/vault-generated.ts<br>server/secrets.ts<br>server/repositories/vault-files.ts<br>server/repositories/vault-files-sqlite.ts<br>server/repositories/vault-files-dynamodb.ts<br>web/src/pages/Vault.jsx<br>web/src/lib/vaultFolders.js<br>web/src/styles/components.css | test/vault.test.ts<br>test/vault-folders.test.ts<br>test/vault-files-repo.test.ts | vault | ❌ never run | — |

## 8 — Insights

| Module ID | Description | Source files | Test files | Smoke IDs | Status | Last pass |
|-----------|-------------|-------------|-----------|-----------|--------|-----------|
| insights | Session and cost insights analytics | server/insights.ts<br>server/repositories/stats.ts<br>server/repositories/stats-sqlite.ts<br>server/repositories/stats-dynamodb.ts<br>web/src/components/CostPanel.jsx | test/insights.test.ts | insights | ❌ never run | — |

## 9 — Inbox

| Module ID | Description | Source files | Test files | Smoke IDs | Status | Last pass |
|-----------|-------------|-------------|-----------|-----------|--------|-----------|
| inbox | Agent inbox — approval requests, notifications, and the p6_inbox repository layer | server/inbox.ts<br>server/repositories/inbox.ts<br>server/repositories/inbox-sqlite.ts<br>server/repositories/inbox-dynamodb.ts<br>web/src/pages/Inbox.jsx | test/inbox-repo.test.ts<br>test/inbox-ui.test.ts | inbox | ❌ never run | — |

## 10 — Connections & Repositories

| Module ID | Description | Source files | Test files | Smoke IDs | Status | Last pass |
|-----------|-------------|-------------|-----------|-----------|--------|-----------|
| connections | Git provider connections management | server/git-connections.ts<br>server/repositories/git-connections.ts<br>server/repositories/git-connections-sqlite.ts<br>server/repositories/git-connections-dynamodb.ts<br>web/src/pages/Connections.jsx<br>web/src/pages/ConnectionsPage.jsx<br>web/src/styles/connections.css | test/git-connections.test.ts<br>test/git-connections-repo.test.ts | connections | ❌ never run | — |
| repos | Repository listing, cloning, and clone progress tracking | server/repos.ts<br>server/git-progress.ts<br>server/repositories/git-repos.ts<br>server/repositories/git-repos-sqlite.ts<br>server/repositories/git-repos-dynamodb.ts | test/repos.test.ts<br>test/repos-branches.test.ts<br>test/repos-progress.test.ts<br>test/git-repos-repo.test.ts | repos | ❌ never run | — |

## 11 — Integrations

| Module ID | Description | Source files | Test files | Smoke IDs | Status | Last pass |
|-----------|-------------|-------------|-----------|-----------|--------|-----------|
| integrations | Third-party integrations (Atlassian, etc.) | server/integrations.ts<br>server/repositories/integrations.ts<br>server/repositories/integrations-sqlite.ts<br>server/repositories/integrations-dynamodb.ts<br>web/src/pages/Integrations.jsx | test/integrations-repo.test.ts | integrations | ❌ never run | — |

## 12 — AWS Accounts & Credentials

| Module ID | Description | Source files | Test files | Smoke IDs | Status | Last pass |
|-----------|-------------|-------------|-----------|-----------|--------|-----------|
| aws-accounts | AWS account management and region selection | server/repositories/aws-accounts.ts<br>server/repositories/aws-accounts-sqlite.ts<br>server/repositories/aws-accounts-dynamodb.ts<br>web/src/components/AwsRegionSelect.jsx<br>web/src/lib/awsRegions.js<br>server/project-aws.ts<br>web/src/pages/ProjectAws.jsx | test/aws-accounts-repo.test.ts | aws-accounts | ❌ never run | — |
| credentials | AWS credentials management and parser | server/credentials.ts<br>server/credential-default.ts<br>server/kiro-idc.ts<br>server/claude-plan-oauth.ts<br>server/mcp-oauth.ts<br>server/atlassian-mcp.ts<br>server/claude-plan-check.ts<br>server/claude-login.ts<br>server/repositories/credentials.ts<br>server/repositories/credentials-sqlite.ts<br>server/repositories/credentials-dynamodb.ts<br>web/src/pages/Credentials.jsx<br>web/src/components/SetupChecklist.jsx<br>web/src/components/AwsKeysFields.jsx<br>web/src/lib/aws-paste.js<br>web/src/lib/awsCredParser.js<br>web/src/styles/credentials.css | test/credentials.test.ts<br>test/claude-plan-oauth.test.ts<br>test/mcp-oauth.test.ts<br>test/atlassian-mcp.test.ts<br>test/claude-plan-check.test.ts<br>test/claude-login.test.ts<br>test/kiro-credential-default.test.ts<br>test/bedrock-sign-in.test.ts<br>test/aws-keys-sign-in.test.ts<br>test/setup-checklist-ui.test.ts<br>test/aws-cred-parser.test.ts<br>test/credentials-repo.test.ts | credentials | ❌ never run | — |
| bedrock-sso | Bedrock SSO via AWS Identity Center (IDC) | server/bedrock-sso.ts<br>server/kiro-idc.ts<br>server/kiro-idc-check.ts<br>web/src/components/DeviceCodeBox.jsx | test/bedrock-sso.test.ts | — | ❌ never run | — |

## 13 — Settings & Configuration

| Module ID | Description | Source files | Test files | Smoke IDs | Status | Last pass |
|-----------|-------------|-------------|-----------|-----------|--------|-----------|
| settings | Portal settings — AI provider, tools, permissions, code review, appearance | server/settings.ts<br>server/secrets.ts<br>server/repositories/settings.ts<br>server/repositories/settings-sqlite.ts<br>server/repositories/settings-dynamodb.ts<br>web/src/pages/settings/Appearance.jsx<br>web/src/pages/settings/Providers.jsx<br>web/src/pages/settings/Secrets.jsx<br>web/src/pages/settings/Settings.jsx<br>web/src/pages/settings/Users.jsx<br>web/src/pages/AdminPanel.jsx | test/settings.test.ts<br>test/settings-repo.test.ts | settings | ❌ never run | — |
| config | Portal configuration — deploy target, cloud config, config file editor | server/config.ts<br>web/src/pages/Configuration.jsx<br>web/src/pages/config/ConfigEditor.jsx<br>web/src/pages/config/ConfigFileTree.jsx<br>web/src/pages/config/ConfigStatus.jsx<br>web/src/styles/config.css | test/cloud-config.test.ts | config | ❌ never run | — |
| user-config | Per-user configuration storage and retrieval | server/user-config.ts<br>server/repositories/user-config.ts<br>server/repositories/user-config-sqlite.ts<br>server/repositories/user-config-dynamodb.ts | test/user-config.test.ts<br>test/user-config-repo.test.ts | — | ❌ never run | — |

## 14 — Code Reviews

| Module ID | Description | Source files | Test files | Smoke IDs | Status | Last pass |
|-----------|-------------|-------------|-----------|-----------|--------|-----------|
| reviews | Code review creation, lifecycle, verdict, exports, and CI control plane | server/review.ts<br>server/review-result.ts<br>server/review-lifecycle.ts<br>server/pull-requests.ts<br>server/session-pr.ts<br>server/control-plane.ts<br>server/repositories/reviews.ts<br>server/repositories/reviews-sqlite.ts<br>server/repositories/reviews-dynamodb.ts<br>web/src/pages/Review.jsx<br>web/src/pages/ReviewDashboard.jsx<br>web/src/pages/ReviewDetail.jsx<br>web/src/pages/ReviewsPage.jsx<br>web/src/components/BranchSelect.jsx | test/review.test.ts<br>test/review-result.test.ts<br>test/web-review-findings.test.ts<br>test/reviews-repo.test.ts<br>test/pull-requests.test.ts<br>test/session-pr.test.ts<br>test/review-create.test.ts<br>test/branch-select-ui.test.ts | reviews | ⚠️ ⚠️ backend | de5c62e · 2026-11-18 |

## 15 — Branch Scans

| Module ID | Description | Source files | Test files | Smoke IDs | Status | Last pass |
|-----------|-------------|-------------|-----------|-----------|--------|-----------|
| branch-scans | Branch scan creation and detail views | server/scan.ts<br>server/repositories/scans.ts<br>server/repositories/scans-sqlite.ts<br>server/repositories/scans-dynamodb.ts<br>web/src/pages/BranchScans.jsx<br>web/src/pages/BranchScanDetail.jsx | test/scan.test.ts<br>test/scan-engine.test.ts<br>test/scans-repo.test.ts | branch-scans | ❌ never run | — |

## 16 — Testing Module

| Module ID | Description | Source files | Test files | Smoke IDs | Status | Last pass |
|-----------|-------------|-------------|-----------|-----------|--------|-----------|
| testing-module | Tests module — test project management, script generation, and MCP tools | server/testing/index.ts<br>server/testing/generate.ts<br>server/testing/helpers.ts<br>server/testing/model-provider.ts<br>server/testing/projects.ts<br>server/testing/runner.ts<br>server/testing/scripts.ts<br>server/testing/ssrf.ts<br>server/testing/totp.ts<br>server/testing/types.ts<br>server/testing/vault.ts<br>server/testing/case-sets.ts<br>server/testing/curl.ts<br>server/testing/trace.ts<br>server/repositories/testing-data.ts<br>server/repositories/testing-data-sqlite.ts<br>server/repositories/testing-data-dynamodb.ts<br>server/mcp-routes.ts<br>web/src/pages/tests/TestsPage.jsx<br>web/src/pages/tests/GenerationTracker.jsx<br>web/src/pages/tests/CaseSetList.jsx<br>web/src/pages/tests/CaseSetViewer.jsx<br>web/src/pages/tests/GenerateCasesDialog.jsx<br>web/src/pages/tests/tests-cases.css<br>web/src/lib/curlBuilder.js | test/testing.test.ts<br>test/testing-runs.test.ts<br>test/testing-generate.test.ts<br>test/testing-bedrock.test.ts<br>test/testing-kiro-provider.test.ts<br>test/mcp-tests-scope.test.ts<br>test/testing-case-sets.test.ts<br>test/curl-builder.test.ts<br>test/testing-trace.test.ts<br>test/testing-generation-progress.test.ts<br>test/resume-retry.test.ts<br>test/testing-data-repo.test.ts | testing-module | ❌ never run | — |

## 17 — API Access

| Module ID | Description | Source files | Test files | Smoke IDs | Status | Last pass |
|-----------|-------------|-------------|-----------|-----------|--------|-----------|
| api-access | API access page — scope checkboxes and MCP section (UI; backend covered by api-tokens) | web/src/pages/ApiAccess.jsx<br>web/src/styles/tokens.css | — | api-access, api-tokens | ❌ never run | — |

## 18 — Loop Specs

| Module ID | Description | Source files | Test files | Smoke IDs | Status | Last pass |
|-----------|-------------|-------------|-----------|-----------|--------|-----------|
| loop-specs | Loop specifications for multi-agent orchestration | server/loop-specs.ts<br>server/loop-triggers.ts<br>server/repositories/loop-specs.ts<br>server/repositories/loop-specs-sqlite.ts<br>server/repositories/loop-specs-dynamodb.ts<br>web/src/pages/LoopSpecs.jsx | test/loop-specs.test.ts<br>test/loop-specs-repo.test.ts<br>test/loop-triggers.test.ts | — | ❌ never run | — |

## 19 — Engines & Models

| Module ID | Description | Source files | Test files | Smoke IDs | Status | Last pass |
|-----------|-------------|-------------|-----------|-----------|--------|-----------|
| engines | AI engine and model configuration, listing, and passthrough | server/models.ts<br>server/agent/anthropic-models.ts<br>server/kiro-list-models.ts<br>server/user-config.ts<br>server/repositories/credentials.ts<br>server/repositories/credentials-sqlite.ts<br>server/repositories/credentials-dynamodb.ts<br>server/repositories/user-config.ts<br>server/repositories/user-config-sqlite.ts<br>server/repositories/user-config-dynamodb.ts | test/engines.test.ts<br>test/session-caveman.test.ts<br>test/engine-models.test.ts<br>test/anthropic-models.test.ts<br>test/engine-model-passthrough.test.ts<br>test/model-listing.test.ts<br>test/kiro-acp.test.ts<br>test/kiro-session.test.ts | engines | ❌ never run | — |

## 20 — Kiro Integration

| Module ID | Description | Source files | Test files | Smoke IDs | Status | Last pass |
|-----------|-------------|-------------|-----------|-----------|--------|-----------|
| kiro | Kiro CLI integration — command runner, settings parser, MCP server | server/kiro-cmd.ts<br>server/kiro-settings.ts<br>server/mcp-server.ts<br>server/agent/kiro-agentcore.ts<br>server/agent/browser-guidance.ts<br>server/agent/agentcore-bridge.ts<br>server/agent/claude-agentcore.ts<br>server/agent/runtime-models.ts<br>server/agent/agent-defs.ts<br>server/agent/run-agents.ts<br>server/agent/kiro-config-files.ts<br>kiro-runner/src/kiro-config.ts<br>web/src/lib/agent-pack/index.js<br>web/src/lib/agent-pack/skills.js<br>server/repositories/agentcore-login.ts<br>server/repositories/agentcore-login-sqlite.ts<br>server/repositories/agentcore-login-dynamodb.ts | test/kiro-cmd.test.ts<br>test/kiro-mcp-generate.test.ts<br>test/kiro-models-parser.test.ts<br>test/kiro-settings.test.ts<br>test/kiro-win-env.test.ts<br>test/kiro-agentcore.test.ts<br>test/kiro-subagents.test.ts<br>test/builtin-skills.test.ts<br>test/browser-guidance.test.ts<br>test/agentcore-portal.test.ts<br>test/agentcore-login-repo.test.ts<br>test/agent-defs.test.ts<br>test/agent-pack.test.ts<br>test/agentcore-multi-agent.test.ts<br>test/runtime-models.test.ts | — | ❌ never run | — |

## 21 — App Shell & Theme

| Module ID | Description | Source files | Test files | Smoke IDs | Status | Last pass |
|-----------|-------------|-------------|-----------|-----------|--------|-----------|
| shell | App shell — rail navigation, command palette, shortcuts, header, breadcrumb, dialogs | web/src/components/Rail.jsx<br>web/src/components/CommandPalette.jsx<br>web/src/components/ShortcutsSheet.jsx<br>web/src/components/AppHeader.jsx<br>web/src/components/Breadcrumb.jsx<br>web/src/components/ConfirmDialog.jsx<br>web/src/components/BulkActionBar.jsx<br>web/src/components/Skeleton.jsx<br>web/src/lib/pages-extra.js<br>web/src/lib/useBulkSelect.js<br>web/src/lib/useFocusTrap.js<br>web/src/lib/useOverlayDismiss.js<br>web/src/styles/layout.css<br>web/src/styles/palette.css | test/overlay-dismiss.test.ts | shell | ❌ never run | — |
| theme | Theme system — theme cycling, persistence, and custom CSS templates | server/themes.ts<br>server/repositories/themes.ts<br>server/repositories/themes-sqlite.ts<br>server/repositories/themes-dynamodb.ts<br>server/testing/model-provider.ts<br>web/src/lib/theme.js<br>web/src/lib/shortcuts.js<br>web/src/styles/aethrix.css<br>web/src/styles/clovi.css<br>web/src/styles/nebula.css<br>web/src/styles/aurora-glass.css<br>web/src/styles/cyber-hud.css<br>web/src/styles/twilight.css<br>web/src/styles/terminal.css<br>web/src/styles/kiro-ide.css<br>web/theme-init.js<br>shared/themes/aethrix-night.json<br>shared/themes/classic-teal.json<br>shared/themes/clovi.json<br>shared/themes/nebula.json<br>shared/themes/aurora-glass.json<br>shared/themes/cyber-hud.json<br>shared/themes/twilight.json<br>shared/themes/terminal.json<br>shared/themes/kiro-ide.json<br>web/src/pages/settings/Appearance.jsx<br>web/src/components/Rail.jsx | test/themes.test.ts<br>test/themes-repo.test.ts | theme | ❌ never run | — |

## 22 — Attachments

| Module ID | Description | Source files | Test files | Smoke IDs | Status | Last pass |
|-----------|-------------|-------------|-----------|-----------|--------|-----------|
| attachments | AI attachments — file upload, preview, and picker for session context | server/ai-attachments.ts<br>server/session-attachments.ts<br>server/session-vault-folder.ts<br>server/repositories/ai-attachments.ts<br>server/repositories/ai-attachments-sqlite.ts<br>server/repositories/ai-attachments-dynamodb.ts<br>web/src/components/AttachmentPicker.jsx<br>web/src/components/FilePreviewModal.jsx<br>web/src/styles/file-preview.css<br>server/session-attachments.ts<br>server/direct-upload.ts<br>server/agent/input-file-urls.ts<br>web/src/lib/direct-upload.js<br>web/src/lib/attachment-limits.js<br>web/src/pages/sessions/IdeWorkspace.jsx | test/ai-attachments.test.ts<br>test/direct-upload.test.ts<br>test/direct-upload-web.test.ts<br>test/ai-attachments-repo.test.ts<br>test/chat-attachments.test.ts<br>test/prior-attachments.test.ts | — | ❌ never run | — |

## 23 — Backend-only modules

| Module ID | Description | Source files | Test files | Smoke IDs | Status | Last pass |
|-----------|-------------|-------------|-----------|-----------|--------|-----------|
| security | Security regression tests — SSRF guard, token scope enforcement, child-session cap, approval fingerprinting, run limits, config/hook guard (C), credential scrubbing (D) | server/agent/runner.ts<br>server/agent/approvals.ts<br>server/agent/types.ts<br>server/agent/claude-code.ts<br>server/agent/demo.ts<br>server/agent/kiro.ts<br>server/agent/kiro-agentcore.ts<br>server/agent/guard.ts<br>server/agent/env-scrub.ts<br>server/real-path.ts<br>server/git.ts<br>server/runs.ts<br>server/inbox.ts<br>server/workflows/crud.ts<br>server/settings.ts | test/security-fixes.test.ts<br>test/ssrf.test.ts<br>test/approval-binding.test.ts<br>test/run-limits.test.ts<br>test/config-protection.test.ts<br>test/agent-env-scrub.test.ts<br>test/safe-url.test.ts<br>test/sanitize-preview.test.ts<br>test/security-p0.test.ts<br>test/path-inside.test.ts<br>test/ssrf-defaults.test.ts<br>test/guarded-fetch.test.ts | — | ❌ never run | — |
| storage | File storage abstraction — local filesystem and S3 backends | server/storage/index.ts<br>server/storage/local.ts<br>server/storage/s3.ts<br>server/storage-instance.ts | test/storage.test.ts | — | ❌ never run | — |
| db | SQLite database recovery and migration tests (backend-only; server/db.ts is shared core) | — | test/db-recovery.test.ts<br>test/resume-retry.test.ts | — | ❌ never run | — |
| health | Health-check endpoint | server/health.ts | test/health.test.ts<br>test/startup-ordering.test.ts | — | ❌ never run | — |
| guardrails | Output guardrails runner | server/guardrails.ts | test/guardrails-runner.test.ts | — | ❌ never run | — |
| output-files | Session output file management — collection, versioning, Vault copy, and routes | server/output-files.ts<br>server/repositories/output-files.ts<br>server/repositories/output-files-sqlite.ts<br>server/repositories/output-files-dynamodb.ts<br>web/src/lib/outputFileMatch.js<br>web/src/lib/outputFileUtils.js | test/output-files.test.ts<br>test/output-files-match.test.ts<br>test/output-file-utils.test.ts<br>test/output-files-repo.test.ts<br>test/output-files-vault-button.test.ts | — | ❌ never run | — |

## Other modules (not yet grouped)

| Module ID | Description | Source files | Test files | Smoke IDs | Status | Last pass |
|-----------|-------------|-------------|-----------|-----------|--------|-----------|
| api-simulation | API simulation: import an API specification from a document, host a simulated API with stateful mocks and a call log, business rules, generated test cases, scheduled runs against the simulation and the live API, MCP tools for agents. | server/api-sim/**<br>server/repositories/simulation.ts<br>server/repositories/simulation-sqlite.ts<br>server/repositories/simulation-dynamodb.ts<br>web/src/pages/Simulation.jsx<br>web/src/pages/SimulationDetail.jsx<br>web/src/lib/simulation.js<br>web/src/styles/simulation.css | test/api-sim.test.ts<br>test/api-sim-routes.test.ts<br>test/api-sim-ai-import.test.ts<br>test/api-sim-diff-postman.test.ts<br>test/api-sim-groups.test.ts<br>test/api-sim-mcp.test.ts<br>test/api-sim-reimport.test.ts<br>test/api-sim-rules.test.ts<br>test/api-sim-runs.test.ts<br>test/api-sim-schedule.test.ts<br>test/api-sim-state.test.ts<br>test/api-sim-testgen.test.ts<br>test/web-simulation-lib.test.ts<br>test/api-sim-environments.test.ts | — | ❌ never run | — |
| automations | Versioned visual workflows and durable orchestration | server/automations/**<br>server/repositories/automations.ts<br>server/repositories/automations-dynamodb.ts<br>web/src/pages/Automations.jsx<br>web/src/styles/automations.css<br>infra/lib/automation-bridge.js<br>server/automations/templates.ts<br>server/automations/generate.ts | test/automations.test.ts<br>test/automations-repo.test.ts<br>test/web-automations.test.ts<br>test/automation-bridge.test.ts<br>test/automation-templates.test.ts<br>test/automation-list.test.ts<br>test/automation-run-options.test.ts<br>test/automation-generate.test.ts | — | ❌ never run | — |
| ci-runner | Bounded, deduplicated backend test execution | scripts/test-affected.mjs<br>scripts/test-pool.mjs<br>.github/workflows/ci.yml | test/test-pool.test.ts | — | ❌ never run | — |
| deploy-gate | Deploy workflows wait for CI to pass on the commit they deploy | scripts/wait-for-ci.mjs<br>scripts/deploy-scope.mjs<br>infra/scripts/harness-sources.mjs<br>infra/scripts/apply-upload-bucket-config.mjs<br>.github/workflows/deploy-portal.yml<br>.github/workflows/deploy-agentcore.yml | test/wait-for-ci.test.ts<br>test/deploy-scope.test.ts<br>test/upload-bucket-config.test.ts | — | ❌ never run | — |
| project-checklists | Project deployment and security checklist analysis, editing, reviews, exports and storage | server/project-checklists.ts<br>server/project-checklist-analysis.ts<br>server/repositories/project-checklists.ts<br>server/repositories/project-checklists-dynamodb.ts<br>web/src/pages/hub/ProjectChecklists.jsx<br>web/src/pages/hub/project-checklists.css | test/project-checklists.test.ts<br>test/web-project-checklists.test.ts | — | ❌ never run | — |
| usage | Usage page: dollars (Claude), credits (Kiro) and tokens by person, project and day | server/usage.ts<br>server/repositories/stats.ts<br>server/repositories/stats-sqlite.ts<br>server/repositories/stats-dynamodb.ts<br>web/src/pages/Usage.jsx | test/usage.test.ts<br>test/stats-repo.test.ts<br>test/web-usage-page.test.ts | — | ❌ never run | — |
| code-map | Code map — graphify code graph of each repository: runner build and upload, search, neighbourhood view | server/code-map.ts<br>server/code-graph.ts<br>server/agent/runner-graph-build.ts<br>server/agent/runner-graph.ts<br>server/graph-id.ts<br>web/src/pages/hub/GraphExcludes.jsx<br>web/src/pages/CodeMap.jsx<br>web/src/lib/mindmapLayout.js | test/code-graph.test.ts<br>test/graph-exclude.test.ts<br>test/code-graph-portal.test.ts<br>test/code-map.test.ts<br>test/runner-repos.test.ts | — | ❌ never run | — |
| budget | Budget usage tracking repository layer (budget_usage table) | server/repositories/budget.ts<br>server/repositories/budget-sqlite.ts<br>server/repositories/budget-dynamodb.ts<br>server/agent/litellm.ts<br>server/agent/claude-code.ts<br>server/agent/kiro.ts | test/budget-repo.test.ts<br>test/usage-format.test.ts | — | ❌ never run | — |
| jira | Jira integration: OAuth/API-token auth, ticket browse, session context | server/jira.ts<br>server/jira-text.ts<br>server/jira-adf.ts<br>server/workflows/crud.ts<br>server/workflows/driver.ts<br>server/agent/runner.ts | test/jira.test.ts | — | ❌ never run | — |
| feedback | Feedback from users: send, follow, admin inbox, link to a session and its pull request | server/feedback.ts<br>server/repositories/feedback.ts<br>server/repositories/feedback-sqlite.ts<br>server/repositories/feedback-dynamodb.ts<br>web/src/pages/Feedback.jsx | test/feedback.test.ts | — | ❌ never run | — |
| help | Help page: the in-portal user guide to every feature | web/src/pages/Help.jsx<br>web/src/lib/help-content.js<br>web/src/styles/help.css | test/help-content.test.ts | — | ❌ never run | — |
| tickets | Jira ticket integration — connect, browse, and start sessions from tickets | web/src/pages/Tickets.jsx<br>web/src/components/JiraTicketPicker.jsx<br>web/src/components/TicketPreview.jsx<br>web/src/components/Markdown.jsx<br>web/src/pages/sessions/ticketVars.js<br>web/src/styles/jira.css | — | tickets | ❌ never run | — |
| agent-runner | AgentCore Runtime container for Claude runs: payload validation, shared tool policy and approvals (backend-only; no smoke section) | agent-runner/src/validate.ts<br>agent-runner/src/run.ts<br>agent-runner/src/index.ts<br>server/agent/tool-policy.ts<br>server/agent/agentcore-approvals.ts<br>server/agent/runner-finalize.ts<br>server/agent/runner-finalize-run.ts<br>agent-runner/src/finalize.ts<br>server/agent/runner-browser-capture.ts | test/agent-runner-validation.test.ts<br>test/runner-snapshot-finalize.test.ts<br>test/runner-finalize.test.ts<br>test/kiro-runner-finalize.test.ts<br>test/agentcore-harness.test.ts<br>test/pricing.test.ts<br>test/browser-capture.test.ts<br>test/browser-capture-real.test.ts<br>test/browser-tools-guide.test.ts<br>test/browser-wait-for-sign-in.test.ts | — | ❌ never run | — |
| kiro-runner | Kiro CLI AgentCore Runtime container — payload validation (backend-only; no smoke section) | kiro-runner/src/validate.ts<br>kiro-runner/src/run.ts<br>kiro-runner/src/subagents.ts<br>kiro-runner/src/login.ts<br>kiro-runner/src/index.ts | test/kiro-subagents.test.ts | — | ❌ never run | — |
| tool-packs | Tool-pack installer logic — uv, kiro-cli, and draw.io install, detection, and verification | server/tool-packs.ts<br>server/drawio-pack.ts | test/tool-packs.test.ts | — | ❌ never run | — |
| agent-runner-browser | Tests in agent-runner-browser.test.ts | agent-runner/src/browser-tools.ts | test/agent-runner-browser.test.ts | — | ❌ never run | — |
| aws-env | Tests in aws-env.test.ts | kiro-runner/src/validate.ts<br>agent-runner/src/validate.ts | test/aws-env.test.ts | — | ❌ never run | — |
| background-jobs | Background jobs: local setImmediate, Lambda self-invoke, inline fallback, and dispatch from /internal/events. | server/background-jobs.ts<br>server/scheduled-jobs.ts | test/background-jobs.test.ts<br>test/job-runtime.test.ts | — | ❌ never run | — |
| browser-live-view | Tests in browser-live-view.test.ts | server/browser-live-view.ts | test/browser-live-view.test.ts | — | ❌ never run | — |
| case-runs | Tests in case-runs.test.ts | server/agent/run-secrets.ts<br>server/testing/case-runs.ts | test/case-runs.test.ts | — | ❌ never run | — |
| claude-agentcore | Claude on AgentCore: event mapping, credential selection, errors, cancel. | server/agent/kiro-agentcore.ts<br>server/agent/claude-agentcore.ts<br>server/session-pr.ts<br>server/agent/types.ts | test/claude-agentcore.test.ts | — | ❌ never run | — |
| create-inputs | Tests in create-inputs.test.ts | server/agent/runner-files.ts<br>server/create-ai.ts<br>server/repositories/credentials.ts | test/create-inputs.test.ts | — | ❌ never run | — |
| doc-templates-routes | Doc template routes: upload, list, make default, delete (repository-backed). | server/docgen.ts | test/doc-templates-routes.test.ts | — | ❌ never run | — |
| durable-files | durable-files: files under DATA_DIR are mirrored to the storage backend (S3) only when STORAGE_BACKEND=s3, | server/storage-instance.ts<br>server/storage/index.ts<br>server/durable-files.ts | test/durable-files.test.ts | — | ❌ never run | — |
| google-auth | Tests in google-auth.test.ts | server/google-auth.ts | test/google-auth.test.ts | — | ❌ never run | — |
| mail-page | Mail page day window | server/mail.ts | test/mail.test.ts | — | ❌ never run | — |
| gmail | Gmail connection, run token and outgoing mail helpers | server/gmail.ts | test/gmail.test.ts | — | ❌ never run | — |
| repo-skills | Agent skills in the repository (agent/skills) and the docs and skills sync task | server/agent/skills-guidance.ts<br>web/src/lib/repoSync.js | test/repo-skills.test.ts | — | ❌ never run | — |
| google-workspace | Tests in google-workspace.test.ts | server/google-workspace.ts | test/google-workspace.test.ts | — | ❌ never run | — |
| harness-safety-switches | Safety switches ported from the harness work (Phase 1, PRs 1.2 and 1.3): | server/agent/runner.ts | test/harness-safety-switches.test.ts | — | ❌ never run | — |
| knowledge-answer | Tests in knowledge-answer.test.ts | server/knowledge-answer.ts<br>server/knowledge-kb.ts | test/knowledge-answer.test.ts | — | ❌ never run | — |
| knowledge-embeddings | Tests in knowledge-embeddings.test.ts | server/knowledge-embeddings.ts | test/knowledge-embeddings.test.ts | — | ❌ never run | — |
| learn-routes | Learn routes: docs, quizzes (take + attempts) and learning paths with progress, on the learn repository. | server/repositories/learn.ts | test/learn-routes.test.ts | — | ❌ never run | — |
| flows | Flow recipes: parsing and checking a recipe file, and the state machine that moves a running flow on (sequence, parallel steps, run-until loops, failure, stop). | server/flows/recipe.ts<br>server/flows/state.ts | test/flows.test.ts | — | ❌ never run | — |
| flows-engine | Running a flow on child sessions (flows/engine.ts, catalog.ts, command.ts): steps start when the steps they wait for are done, the /flow chat command, the flow API, stopping. | server/flows/engine.ts<br>server/flows/catalog.ts<br>server/flows/command.ts | test/flows-engine.test.ts | — | ❌ never run | — |
| guide-bundle | A user guide as a bundle: the shot board (placed, not in the text, file missing, not captured), the screenshot manifest, and the single-page HTML guide. | server/guide-bundle.ts | test/guide-bundle.test.ts | — | ❌ never run | — |
| web-realtime | The browser live-update connection: a token renewed before each new channel subscribe, and a refused subscribe retried with a fresh token. | web/src/lib/realtime.js | test/web-realtime.test.ts | — | ❌ never run | — |
| loop-iteration | Loop iteration logic: status parsing, stagnation (harness PR 1.7: loose matching, window of at least 2), the stop | server/loop-iteration.ts | test/loop-iteration.test.ts | — | ❌ never run | — |
| loop-session | Loop sessions: after a run ends, the session either starts the next run or stops with the reason (workflows/loop.ts). | server/repositories/sessions.ts<br>server/workflows/loop.ts | test/loop-session.test.ts | — | ❌ never run | — |
| mcp-core-tools | MCP core tools on the repositories: sessions, transcripts, reviews, scans. | server/repositories/reviews.ts<br>server/repositories/git-repos.ts | test/mcp-core-tools.test.ts | — | ❌ never run | — |
| public-url | Tests in public-url.test.ts | server/public-url.ts | test/public-url.test.ts | — | ❌ never run | — |
| realtime-token | Tests in realtime-token.test.ts | server/realtime.ts | test/realtime-token.test.ts<br>test/realtime-authorizer.test.ts<br>test/realtime-order.test.ts | — | ❌ never run | — |
| runner-checks | Check steps for loop sessions (server/agent/runner-checks.ts): what a check command may be (harness PR 1.2) and how | server/agent/runner-checks.ts | test/runner-checks.test.ts | — | ❌ never run | — |
| runner-files | Files an agent writes in an AgentCore microVM come back to the portal: collect -> chunked events -> receiver. | server/agent/runner-files.ts<br>server/agent/kiro-agentcore.ts<br>server/agent/claude-agentcore.ts<br>server/agent/types.ts | test/runner-files.test.ts<br>test/input-file-downloads.test.ts<br>test/zip-attachments.test.ts | — | ❌ never run | — |
| runner-inspect | Tests in runner-inspect.test.ts | server/agent/runner-inspect.ts | test/runner-inspect.test.ts | — | ❌ never run | — |
| runner-mcp | Tests in runner-mcp.test.ts | server/agent/runner-mcp.ts<br>server/agent/runner-integrations.ts | test/runner-mcp.test.ts | — | ❌ never run | — |
| runner-repos | Tests in runner-repos.test.ts | server/agent/runner-repos.ts | test/runner-repos.test.ts | — | ❌ never run | — |
| runner-memory | The runners' memory guard: commands marked kill-first, the biggest stopped when memory is nearly gone | server/agent/runner-memory.ts | test/runner-memory.test.ts | — | ❌ never run | — |
| runner-snapshot | Tests in runner-snapshot.test.ts | server/agent/runner-snapshot.ts | test/runner-snapshot.test.ts | — | ❌ never run | — |
| scheduled-jobs | Tests in scheduled-jobs.test.ts | server/scheduled-jobs.ts | test/scheduled-jobs.test.ts | — | ❌ never run | — |
| session-files-mirror | Session files are mirrored to the storage backend (S3 on Lambda) and come back after the local disk is lost. | server/storage-instance.ts<br>server/storage/index.ts | test/session-files-mirror.test.ts | — | ❌ never run | — |
| engine-limits | What is left of the plan a session runs on (Codex and Claude 5-hour and weekly windows, Kiro credits), shown in the session status bar. | server/engine-limits.ts<br>web/src/pages/sessions/IdeStatusBar.jsx | test/engine-limits.test.ts | — | ❌ never run | — |
| slash-commands | Slash commands in an engine session: the portal's own (/tools, /rename, /cost, /status, /help), /init and /review, and the owner's commands and skills from Agent setup. | server/workflows/session-commands.ts<br>server/workflows/slash-commands.ts<br>server/session-sign-in.ts<br>test/slash-commands.test.ts<br>test/slash-commands-engines.test.ts | test/slash-commands.test.ts<br>test/slash-commands-engines.test.ts | — | ❌ never run | — |
| testing-trace-steps | Trace helpers (startStep / finishStep / getCaseSetTrace / getGenerationTrace) on both backends. | server/repositories/testing-data-sqlite.ts<br>server/repositories/testing-data.ts<br>server/testing/trace.ts | test/testing-trace-steps.test.ts | — | ❌ never run | — |
| ticket-sort | Tests in ticket-sort.test.ts | web/src/lib/ticketSort.js | test/ticket-sort.test.ts | — | ❌ never run | — |
| codex | Codex sign-in, stdio transport, engine runs, and credential isolation | server/codex-auth.ts<br>server/codex-command.ts<br>server/codex-client.ts<br>server/agent/codex.ts<br>web/src/components/CodexCredentials.jsx<br>server/codex-oauth.ts<br>server/codex-device.ts<br>server/codex-device-protocol.ts<br>codex-runner/src/device-auth.ts<br>server/repositories/codex-store.ts<br>server/agent/codex-session.ts<br>server/agent/codex-agents.ts<br>server/agent/codex-agentcore.ts<br>server/agent/codex-pr-tool.ts<br>codex-runner/src/service.ts<br>codex-runner/src/state.ts<br>server/agent/codex-config.ts<br>server/agent/codex-text.ts | test/codex.test.ts<br>test/codex-oauth.test.ts<br>test/codex-device.test.ts<br>test/codex-runner.test.ts<br>test/codex-agents.test.ts<br>test/codex-pr-tool.test.ts<br>test/codex-store.test.ts<br>test/codex-setup.test.ts | credentials, codex-setup | ❌ never run | — |
| autofix | Auto-fix: findings from failing CI, review findings and failed sessions; per-project policy, guardrails, fix pipeline, push gate and Inbox delivery | server/autofix/delivery.ts<br>server/autofix/fingerprint.ts<br>server/autofix/github-events.ts<br>server/autofix/guardrails.ts<br>server/autofix/intake.ts<br>server/autofix/pipeline.ts<br>server/autofix/policy.ts<br>server/autofix/review-source.ts<br>server/autofix/routes.ts<br>server/autofix/scrub.ts<br>server/autofix/session-intake.ts<br>server/autofix/triage.ts<br>server/autofix/webhook.ts<br>server/repositories/autofix-findings-dynamodb.ts<br>server/repositories/autofix-findings-sqlite.ts<br>server/repositories/autofix-findings.ts<br>server/agent/runner-finalize.ts<br>server/agent/runner-finalize-run.ts<br>web/src/pages/hub/AutoFix.jsx<br>web/src/styles/autofix.css | test/autofix-delivery.test.ts<br>test/autofix-findings-repo.test.ts<br>test/autofix-fingerprint.test.ts<br>test/autofix-github-events.test.ts<br>test/autofix-guardrails.test.ts<br>test/autofix-hooks.test.ts<br>test/autofix-loop.test.ts<br>test/autofix-pipeline.test.ts<br>test/autofix-policy.test.ts<br>test/autofix-routes.test.ts<br>test/autofix-schema.test.ts<br>test/autofix-sources.test.ts<br>test/autofix-triage.test.ts<br>test/autofix-webhook.test.ts<br>test/runner-finalize.test.ts<br>test/kiro-runner-finalize.test.ts | setup | ❌ never run | — |

## Known failures

These test failures are listed as known issues. They are skipped until the
relevant source files change. Add entries to `test/known-failures.json`
deliberately — each entry must name the exact failing test, include a reason,
and be removed once the underlying issue is fixed.

| Module | Part | File | Test name | Reason | Added |
|--------|------|------|-----------|--------|-------|
| workflows | backend | test/workflows.test.ts | __process_timeout__ | test/workflows.test.ts: modified workflow tests include slow agent operations that exceed the runner timeout; process killed after 3 minutes | 2026-10-31 |
| attachments | backend | test/ai-attachments.test.ts | __process_timeout__ | test/ai-attachments.test.ts: generate-based tests spin up a server that keeps the event loop alive past the runner timeout | 2026-10-31 |
| reviews | ui | §reviews | Creating a review then opening it navigates to reviews/code/:rid | Review detail navigation route does not match expected /reviews/code/:rid | 2026-10-31 |
| testing-module | ui | §testing-module | Async generate: dialog closes, indicator appears, done clears it and shows toast | Async generate flow: dialog-close and indicator-appear state transitions do not fire in the expected order | 2026-10-31 |
| dashboard | ui | §dashboard | Agent Network single node sits at SVG centre, not at top-left corner | Agent Network panel was redesigned from SVG radial graph to HTML agent cards; .db-network-svg no longer exists | 2026-11-01 |
| dashboard | ui | §dashboard | Zoom toolbar visible; zoom in and reset view work without errors | Zoom/pan toolbar was removed as part of the Agent Network redesign to card-based layout | 2026-11-01 |

## Shared file blast-radius decisions

These files affect multiple modules when changed.

| Sources | Affects | Rationale |
|---------|---------|-----------|
| server/db.ts, server/http.ts, server/util.ts, server/index.ts, server/events.ts | **all modules** | Every server module depends on the DB, router, util helpers, entry-point registration, or the event bus. The UI smoke tests run against the real server binary, so a change here can break any module's backend tests AND its smoke assertions. No part restriction. |
| package.json, package-lock.json, tsconfig.json, scripts/build.mjs, scripts/preflight.mjs | **all modules** | Dependency or build-config changes can break any module silently — both compiled server code and the web bundle. Affects both backend and UI. |
| test/fixtures.ts, test/fake-sdk.mjs, test/fake-kiro.mjs | **all modules** | Every backend test imports from fixtures.ts. fake-sdk and fake-kiro are used across multiple test suites. These are test helpers only — they don't affect the built server or the smoke suite. |
| test/ui/smoke.ts | **all modules** | The smoke runner itself is shared UI infrastructure. Changes to timing, helpers, section list, or the SMOKE_ONLY mechanism only affect smoke (UI) outcomes, not backend unit tests. |
| server/agent/runner.ts, server/agent/claude-code.ts, server/agent/claude-sessions.ts, server/agent/demo.ts, server/agent/kiro.ts, server/agent/kiro-agentcore.ts, server/agent/recap.ts, server/agent/browser-headless.ts, server/agent/browser-manager.ts, server/agent/litellm.ts, server/agent/pricing.ts, server/agent/types.ts | sessions, workflows, reviews, branch-scans, testing-module, engines, ide | The agent runner executes sessions, drives workflow steps, runs code reviews, branch scans, and test runs. browser-headless.ts rewrites Playwright MCP entries; browser-manager.ts provides the per-session live browser. Server code — affects both backend tests and smoke (via running server behaviour). No part restriction. |
| web/src/App.jsx, web/src/main.jsx, web/src/styles.css, web/src/styles/base.css, web/src/styles/components.css, web/src/lib/api.js, web/src/lib/events.js, web/src/lib/cx.js, web/src/lib/util.js | **all modules** | Every page is rendered through App.jsx and uses api.js, events, and the global stylesheet. Web-only files — they don't affect backend unit tests. Affects only UI parts. |
| web/src/components/Icon.jsx, web/src/components/Skeleton.jsx, web/src/components/Toast.jsx | **all modules** | Used on virtually every page; a breakage is visible across the entire UI. Web-only files — affects only UI parts. |
| web/src/lib/useRunStream.js | sessions, reviews, testing-module | Only features that display real-time agent output use this hook. Web-only file — affects only UI parts. |
| web/src/lib/useOverlayDismiss.js | shell, sessions, ide, testing-module, dashboard, diagrams, generated-docs, presentations, vault, credentials, loop-specs, reviews, branch-scans, settings, theme, attachments | Used by every dialog and modal overlay in the app. Web-only file — affects only UI parts. |
| web/src/lib/sanitize.js | sessions, attachments, knowledge | Used in SessionLive.jsx (sessions) and FilePreviewModal.jsx (attachments, knowledge) to sanitize marked output. Web-only — affects only UI parts. |
| web/src/components/FilePreviewModal.jsx | attachments, sessions, knowledge | Used for previewing uploaded files in sessions, knowledge base documents, and the attachments picker. Web-only file — affects only UI parts. |
| web/src/lib/awsCredParser.js, web/src/lib/awsRegions.js, web/src/components/AwsRegionSelect.jsx | credentials, aws-accounts, bedrock-sso | Specific to AWS credential entry, account management, and Bedrock SSO flows. Web-only files — affects only UI parts. |
| web/src/components/DeviceCodeBox.jsx | bedrock-sso, auth, credentials | Used in Bedrock SSO device-code flow, auth provider setup, and the Kiro IAM Identity Center re-authentication flow in the Credentials page. Web-only file — affects only UI parts. |
| web/src/components/WorkspaceHeader.jsx | workspaces, sessions, ide | Rendered in workspace and session views. Web-only file — affects only UI parts. |
| web/src/lib/router.js | shell, projects, auth, setup | Route changes affect navigation in shell, project listing, post-login redirect, and setup wizard steps. Web-only file — affects only UI parts. |
| web/src/lib/templates/index.js | knowledge, generated-docs, presentations | Document and presentation templates used across knowledge base, generated docs, and presentations. Web-only file — affects only UI parts. |
| shared/themes | theme | Theme palette CSS definitions — web-only. Changes affect only the theme module's UI part. |
| server/repositories/backend.ts, server/repositories/dynamo-client.ts | api-tokens, auth, permissions, audit, delegation | Shared backend selector (usesDynamoDb), DynamoDB client singleton, and attribute-marshaling helpers used by all DynamoDB repository implementations. Backend only — not compiled into the web bundle. |

## Backend-only modules (added beyond UI contract)

These modules have no smoke section but have backend tests:
`security`, `storage`, `db`, `health`, `guardrails`, `output-files`, `user-config`

