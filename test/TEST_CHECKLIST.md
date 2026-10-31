# Agent Portal — Test Checklist

> **Auto-generated** by `npm run test:checklist` on 2026-10-31.
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
| auth | Authentication, login, session cookies | server/auth.ts<br>web/src/pages/Auth.jsx | test/auth.test.ts | auth | ✅ ✅ backend, ✅ ui | c482229-dirty · 2026-10-31 |
| setup | First-run setup wizard | web/src/pages/setup/SetupWizard.jsx<br>web/src/pages/setup/AdminAccount.jsx<br>web/src/pages/setup/CloudSecurity.jsx<br>web/src/pages/setup/CloudStorage.jsx<br>web/src/pages/setup/ConfirmStep.jsx<br>web/src/pages/setup/DeployTarget.jsx<br>web/src/pages/setup/ModelProvider.jsx<br>web/src/pages/hub/ProjectHub.jsx<br>web/src/components/WizardProgress.jsx<br>web/src/styles/setup-wizard.css | — | setup | ✅ ✅ ui | c482229-dirty · 2026-10-31 |
| api-tokens | API token management and token scope enforcement | server/api-tokens.ts | test/api-tokens.test.ts<br>test/token-scopes.test.ts | api-tokens | ✅ ✅ backend, ✅ ui | c482229-dirty · 2026-10-31 |
| permissions | Role-based access control, permission checks | server/permissions.ts<br>server/governance/users.ts | test/permissions.test.ts | permissions | ✅ ✅ backend, ✅ ui | c482229-dirty · 2026-10-31 |
| audit | Audit log recording and retrieval | server/audit.ts | test/audit-fixes.test.ts<br>test/audit-fixes-3.test.ts | audit | ✅ ✅ backend, ✅ ui | c482229-dirty · 2026-10-31 |
| delegation | Delegate tokens for sub-agent authentication | server/delegation.ts | test/delegate-token.test.ts<br>test/delegation.test.ts | delegation | ✅ ✅ backend, ✅ ui | c482229-dirty · 2026-10-31 |

## 2 — Projects & Workspaces

| Module ID | Description | Source files | Test files | Smoke IDs | Status | Last pass |
|-----------|-------------|-------------|-----------|-----------|--------|-----------|
| projects | Project CRUD and listing | server/projects.ts<br>web/src/pages/Projects.jsx | test/projects.test.ts | projects | ✅ ✅ backend, ✅ ui | c482229-dirty · 2026-10-31 |
| workspaces | Workspace management per project | server/workspaces.ts<br>web/src/pages/Workspaces.jsx<br>web/src/components/WorkspaceHeader.jsx<br>web/src/styles/workspace.css | — | workspaces | ✅ ✅ ui | c482229-dirty · 2026-10-31 |

## 3 — Sessions, Workflows & IDE

| Module ID | Description | Source files | Test files | Smoke IDs | Status | Last pass |
|-----------|-------------|-------------|-----------|-----------|--------|-----------|
| sessions | Session lifecycle, context, files, and live run streaming | server/session-lifecycle.ts<br>server/session-context.ts<br>server/session-files.ts<br>server/runs.ts<br>server/portal-events.ts<br>server/superpowers-skills.ts<br>web/src/pages/sessions/SessionList.jsx<br>web/src/pages/sessions/SessionLive.jsx<br>web/src/pages/sessions/SessionsShell.jsx<br>web/src/pages/sessions/SessionWorkspace.jsx<br>web/src/pages/sessions/SessionChanges.jsx<br>web/src/pages/sessions/NewSessionDialog.jsx<br>web/src/lib/useRunStream.js<br>web/src/styles/sessions.css | test/session-lifecycle.test.ts<br>test/session-context.test.ts<br>test/session-files.test.ts | sessions | ✅ ✅ backend, ✅ ui | c482229-dirty · 2026-10-31 |
| workflows | Workflow engine, controls, and driver | server/workflows/crud.ts<br>server/workflows/controls.ts<br>server/workflows/driver.ts<br>server/workflows/working-copies.ts<br>server/tool-packs.ts | test/workflows.test.ts<br>test/session-sse.test.ts | sessions | ⚑ ⚑ backend, ✅ ui | c482229-dirty · 2026-10-31 |
| ide | In-browser IDE workspace — editor, explorer, terminal, source control | server/terminal.ts<br>web/src/pages/sessions/IdeAgents.jsx<br>web/src/pages/sessions/IdeBrowser.jsx<br>web/src/pages/sessions/IdeEditor.jsx<br>web/src/pages/sessions/IdeExplorer.jsx<br>web/src/pages/sessions/IdeHeader.jsx<br>web/src/pages/sessions/IdeSessionPanel.jsx<br>web/src/pages/sessions/IdeSourceControl.jsx<br>web/src/pages/sessions/IdeStatusBar.jsx<br>web/src/pages/sessions/IdeTerminal.jsx<br>web/src/pages/sessions/IdeWorkspace.jsx<br>web/src/pages/sessions/codemirror-editor.jsx<br>web/src/pages/sessions/xterm-terminal.jsx<br>web/src/styles/ide.css | — | ide | ✅ ✅ ui | c482229-dirty · 2026-10-31 |

## 4 — Dashboard

| Module ID | Description | Source files | Test files | Smoke IDs | Status | Last pass |
|-----------|-------------|-------------|-----------|-----------|--------|-----------|
| dashboard | Agent performance dashboard KPIs and drill-downs | server/dashboard.ts<br>web/src/pages/Dashboard.jsx<br>web/src/styles/dashboard.css | test/dashboard.test.ts | dashboard | ✅ ✅ backend, ✅ ui | c482229-dirty · 2026-10-31 |

## 5 — Knowledge

| Module ID | Description | Source files | Test files | Smoke IDs | Status | Last pass |
|-----------|-------------|-------------|-----------|-----------|--------|-----------|
| knowledge | Knowledge base documents, search, ask, decisions, and learning content | server/knowledge.ts<br>server/learn.ts<br>web/src/pages/Knowledge.jsx<br>web/src/pages/Learn.jsx<br>web/src/lib/templates/index.js | test/knowledge.test.ts | knowledge | ✅ ✅ backend, ✅ ui | c482229-dirty · 2026-10-31 |

## 6 — Create (Diagrams / Documents / Decks)

| Module ID | Description | Source files | Test files | Smoke IDs | Status | Last pass |
|-----------|-------------|-------------|-----------|-----------|--------|-----------|
| create | Create hub page (container for Diagrams / Documents / Decks tabs) | web/src/pages/Create.jsx | — | create | ✅ ✅ ui | c482229-dirty · 2026-10-31 |
| diagrams | Diagram creation and rendering — draw.io, mermaid, and icon packs | server/diagrams.ts<br>server/drawio.ts<br>server/drawio-cloud.ts<br>server/drawio-pack.ts<br>server/drawio-render.ts<br>server/drawio-text.ts<br>server/diagram-icons.ts<br>server/diagram-text.ts<br>web/src/pages/Diagrams.jsx<br>web/src/components/DiagramStyle.jsx<br>web/src/components/MermaidViewer.jsx | test/diagrams.test.ts | create | ✅ ✅ backend, ✅ ui | c482229-dirty · 2026-10-31 |
| generated-docs | AI-generated documents — Word/PDF/HTML generation pipeline | server/generated-docs.ts<br>server/generated-doc-text.ts<br>server/docgen.ts<br>server/docimage.ts<br>server/docs-pack.ts<br>server/doc-templates.ts<br>server/docx-template.ts<br>server/ooxml.ts<br>server/template-check.ts<br>server/convert.ts<br>web/src/pages/GeneratedDocs.jsx | test/generated-docs.test.ts | create | ✅ ✅ backend, ✅ ui | c482229-dirty · 2026-10-31 |
| presentations | AI-generated presentations — PPTX creation and preview | server/presentations.ts<br>server/presentation-text.ts<br>server/pptx-preview.ts<br>server/pptx-template.ts<br>web/src/pages/Presentations.jsx | test/presentations.test.ts | create | ✅ ✅ backend, ✅ ui | c482229-dirty · 2026-10-31 |

## 7 — Vault

| Module ID | Description | Source files | Test files | Smoke IDs | Status | Last pass |
|-----------|-------------|-------------|-----------|-----------|--------|-----------|
| vault | Secret vault — project, personal, and portal secrets | server/vault.ts<br>server/vault-generated.ts<br>server/secrets.ts<br>web/src/pages/Vault.jsx | test/vault.test.ts | vault | ✅ ✅ backend, ✅ ui | c482229-dirty · 2026-10-31 |

## 8 — Insights

| Module ID | Description | Source files | Test files | Smoke IDs | Status | Last pass |
|-----------|-------------|-------------|-----------|-----------|--------|-----------|
| insights | Session and cost insights analytics | server/insights.ts<br>web/src/pages/Insights.jsx | test/insights.test.ts | insights | ✅ ✅ backend, ✅ ui | c482229-dirty · 2026-10-31 |

## 9 — Inbox

| Module ID | Description | Source files | Test files | Smoke IDs | Status | Last pass |
|-----------|-------------|-------------|-----------|-----------|--------|-----------|
| inbox | Agent inbox for incoming tasks and messages | server/inbox.ts<br>web/src/pages/Inbox.jsx | — | inbox | ✅ ✅ ui | c482229-dirty · 2026-10-31 |

## 10 — Connections & Repositories

| Module ID | Description | Source files | Test files | Smoke IDs | Status | Last pass |
|-----------|-------------|-------------|-----------|-----------|--------|-----------|
| connections | Git provider connections management | server/git-connections.ts<br>web/src/pages/Connections.jsx<br>web/src/pages/ConnectionsPage.jsx<br>web/src/styles/connections.css | test/git-connections.test.ts | connections | ✅ ✅ backend, ✅ ui | c482229-dirty · 2026-10-31 |
| repos | Repository listing, cloning, and clone progress tracking | server/repos.ts<br>server/git-progress.ts | test/repos.test.ts<br>test/repos-progress.test.ts | repos | ⚑ ⚑ backend, ✅ ui | c482229-dirty · 2026-10-31 |

## 11 — Integrations

| Module ID | Description | Source files | Test files | Smoke IDs | Status | Last pass |
|-----------|-------------|-------------|-----------|-----------|--------|-----------|
| integrations | Third-party integrations (Atlassian, etc.) | server/integrations.ts<br>web/src/pages/Integrations.jsx | — | integrations | ✅ ✅ ui | c482229-dirty · 2026-10-31 |

## 12 — AWS Accounts & Credentials

| Module ID | Description | Source files | Test files | Smoke IDs | Status | Last pass |
|-----------|-------------|-------------|-----------|-----------|--------|-----------|
| aws-accounts | AWS account management and region selection | server/aws-accounts.ts<br>web/src/pages/AwsAccounts.jsx<br>web/src/components/AwsRegionSelect.jsx<br>web/src/lib/awsRegions.js | — | aws-accounts | ✅ ✅ ui | c482229-dirty · 2026-10-31 |
| credentials | AWS credentials management and parser | server/credentials.ts<br>server/kiro-idc.ts<br>web/src/pages/Credentials.jsx<br>web/src/lib/awsCredParser.js<br>web/src/styles/credentials.css | test/credentials.test.ts<br>test/aws-cred-parser.test.ts | credentials | ✅ ✅ backend, ✅ ui | c482229-dirty · 2026-10-31 |
| bedrock-sso | Bedrock SSO via AWS Identity Center (IDC) | server/bedrock-sso.ts<br>server/kiro-idc.ts<br>server/kiro-idc-check.ts<br>web/src/components/DeviceCodeBox.jsx | test/bedrock-sso.test.ts | — | ✅ ✅ backend | c482229-dirty · 2026-10-31 |

## 13 — Settings & Configuration

| Module ID | Description | Source files | Test files | Smoke IDs | Status | Last pass |
|-----------|-------------|-------------|-----------|-----------|--------|-----------|
| settings | Portal settings — AI provider, tools, permissions, code review, appearance | server/settings.ts<br>web/src/pages/settings/Appearance.jsx<br>web/src/pages/settings/Providers.jsx<br>web/src/pages/settings/Secrets.jsx<br>web/src/pages/settings/Settings.jsx<br>web/src/pages/settings/Users.jsx<br>web/src/pages/AdminPanel.jsx | test/settings.test.ts | settings | ✅ ✅ backend, ✅ ui | c482229-dirty · 2026-10-31 |
| config | Portal configuration — deploy target, cloud config, config file editor | server/config.ts<br>web/src/pages/Configuration.jsx<br>web/src/pages/config/ConfigEditor.jsx<br>web/src/pages/config/ConfigFileTree.jsx<br>web/src/pages/config/ConfigStatus.jsx<br>web/src/styles/config.css | test/cloud-config.test.ts | config | ✅ ✅ backend, ✅ ui | c482229-dirty · 2026-10-31 |
| user-config | Per-user configuration storage and retrieval | server/user-config.ts | test/user-config.test.ts | — | ✅ ✅ backend | c482229-dirty · 2026-10-31 |

## 14 — Code Reviews

| Module ID | Description | Source files | Test files | Smoke IDs | Status | Last pass |
|-----------|-------------|-------------|-----------|-----------|--------|-----------|
| reviews | Code review creation, lifecycle, verdict, exports, and CI control plane | server/review.ts<br>server/review-lifecycle.ts<br>server/control-plane.ts<br>web/src/pages/Review.jsx<br>web/src/pages/ReviewDashboard.jsx<br>web/src/pages/ReviewDetail.jsx<br>web/src/pages/ReviewsPage.jsx | test/review.test.ts | reviews | ✅ ✅ backend, ✅ ui | c482229-dirty · 2026-10-31 |

## 15 — Branch Scans

| Module ID | Description | Source files | Test files | Smoke IDs | Status | Last pass |
|-----------|-------------|-------------|-----------|-----------|--------|-----------|
| branch-scans | Branch scan creation and detail views | server/scan.ts<br>web/src/pages/BranchScans.jsx<br>web/src/pages/BranchScanDetail.jsx | test/scan.test.ts | branch-scans | ✅ ✅ backend, ✅ ui | c482229-dirty · 2026-10-31 |

## 16 — Testing Module

| Module ID | Description | Source files | Test files | Smoke IDs | Status | Last pass |
|-----------|-------------|-------------|-----------|-----------|--------|-----------|
| testing-module | Tests module — test project management, script generation, and MCP tools | server/testing/index.ts<br>server/testing/generate.ts<br>server/testing/helpers.ts<br>server/testing/model-provider.ts<br>server/testing/projects.ts<br>server/testing/runner.ts<br>server/testing/scripts.ts<br>server/testing/ssrf.ts<br>server/testing/totp.ts<br>server/testing/types.ts<br>server/testing/vault.ts<br>server/mcp-routes.ts<br>web/src/pages/tests/TestsPage.jsx | test/testing.test.ts<br>test/testing-runs.test.ts<br>test/testing-generate.test.ts<br>test/testing-bedrock.test.ts<br>test/testing-kiro-provider.test.ts<br>test/mcp-tests-scope.test.ts | testing-module | ⚑ ✅ backend, ⚑ ui | c482229-dirty · 2026-10-31 |

## 17 — API Access

| Module ID | Description | Source files | Test files | Smoke IDs | Status | Last pass |
|-----------|-------------|-------------|-----------|-----------|--------|-----------|
| api-access | API access page — scope checkboxes and MCP section (UI; backend covered by api-tokens) | web/src/pages/ApiAccess.jsx<br>web/src/styles/tokens.css | — | api-access, api-tokens | ✅ ✅ ui | c482229-dirty · 2026-10-31 |

## 18 — Loop Specs

| Module ID | Description | Source files | Test files | Smoke IDs | Status | Last pass |
|-----------|-------------|-------------|-----------|-----------|--------|-----------|
| loop-specs | Loop specifications for multi-agent orchestration | server/loop-specs.ts<br>web/src/pages/LoopSpecs.jsx | test/loop-specs.test.ts | — | ✅ ✅ backend | c482229-dirty · 2026-10-31 |

## 19 — Engines & Models

| Module ID | Description | Source files | Test files | Smoke IDs | Status | Last pass |
|-----------|-------------|-------------|-----------|-----------|--------|-----------|
| engines | AI engine and model configuration, listing, and passthrough | server/models.ts<br>server/kiro-list-models.ts | test/engines.test.ts<br>test/engine-models.test.ts<br>test/engine-model-passthrough.test.ts<br>test/model-listing.test.ts | engines | ✅ ✅ backend, ✅ ui | c482229-dirty · 2026-10-31 |

## 20 — Kiro Integration

| Module ID | Description | Source files | Test files | Smoke IDs | Status | Last pass |
|-----------|-------------|-------------|-----------|-----------|--------|-----------|
| kiro | Kiro CLI integration — command runner, settings parser, MCP server | server/kiro-cmd.ts<br>server/kiro-settings.ts<br>server/mcp-server.ts | test/kiro-cmd.test.ts<br>test/kiro-mcp-generate.test.ts<br>test/kiro-models-parser.test.ts<br>test/kiro-settings.test.ts<br>test/kiro-win-env.test.ts | — | ✅ ✅ backend | c482229-dirty · 2026-10-31 |

## 21 — App Shell & Theme

| Module ID | Description | Source files | Test files | Smoke IDs | Status | Last pass |
|-----------|-------------|-------------|-----------|-----------|--------|-----------|
| shell | App shell — rail navigation, command palette, shortcuts, header, breadcrumb, dialogs | web/src/components/Rail.jsx<br>web/src/components/CommandPalette.jsx<br>web/src/components/ShortcutsSheet.jsx<br>web/src/components/AppHeader.jsx<br>web/src/components/Breadcrumb.jsx<br>web/src/components/ConfirmDialog.jsx<br>web/src/components/BulkActionBar.jsx<br>web/src/components/Skeleton.jsx<br>web/src/lib/pages-extra.js<br>web/src/lib/useBulkSelect.js<br>web/src/lib/useFocusTrap.js<br>web/src/styles/layout.css<br>web/src/styles/palette.css | — | shell | ✅ ✅ ui | c482229-dirty · 2026-10-31 |
| theme | Theme system — theme cycling, persistence, and custom CSS templates | server/themes.ts<br>web/src/lib/theme.js<br>web/src/lib/shortcuts.js<br>web/src/styles/aethrix.css<br>web/theme-init.js | test/themes.test.ts | theme | ✅ ✅ backend, ✅ ui | c482229-dirty · 2026-10-31 |

## 22 — Attachments

| Module ID | Description | Source files | Test files | Smoke IDs | Status | Last pass |
|-----------|-------------|-------------|-----------|-----------|--------|-----------|
| attachments | AI attachments — file upload, preview, and picker for session context | server/ai-attachments.ts<br>web/src/components/AttachmentPicker.jsx<br>web/src/components/FilePreviewModal.jsx<br>web/src/styles/file-preview.css | test/ai-attachments.test.ts | — | ⚑ ⚑ backend | c482229-dirty · 2026-10-31 |

## 23 — Backend-only modules

| Module ID | Description | Source files | Test files | Smoke IDs | Status | Last pass |
|-----------|-------------|-------------|-----------|-----------|--------|-----------|
| security | Security regression tests — SSRF guard, token scope enforcement, child-session cap (backend-only; sources are shared core files) | — | test/security-fixes.test.ts<br>test/ssrf.test.ts | — | ✅ ✅ backend | c482229-dirty · 2026-10-31 |
| storage | File storage abstraction — local filesystem and S3 backends | server/storage/index.ts<br>server/storage/local.ts<br>server/storage/s3.ts<br>server/storage-instance.ts | test/storage.test.ts | — | ✅ ✅ backend | c482229-dirty · 2026-10-31 |
| db | SQLite database recovery and migration tests (backend-only; server/db.ts is shared core) | — | test/db-recovery.test.ts | — | ✅ ✅ backend | c482229-dirty · 2026-10-31 |
| health | Health-check endpoint | server/health.ts | test/health.test.ts | — | ✅ ✅ backend | c482229-dirty · 2026-10-31 |
| guardrails | Output guardrails runner | server/guardrails.ts | test/guardrails-runner.test.ts | — | ✅ ✅ backend | c482229-dirty · 2026-10-31 |
| output-files | Session output file management | server/output-files.ts | test/output-files.test.ts | — | ✅ ✅ backend | c482229-dirty · 2026-10-31 |

## Known failures

These test failures are listed as known issues. They are skipped until the
relevant source files change. Add entries to `test/known-failures.json`
deliberately — each entry must name the exact failing test, include a reason,
and be removed once the underlying issue is fixed.

| Module | Part | File | Test name | Reason | Added |
|--------|------|------|-----------|--------|-------|
| workflows | backend | test/workflows.test.ts | __process_timeout__ | test/workflows.test.ts: modified workflow tests include slow agent operations that exceed the runner timeout; process killed after 3 minutes | 2026-10-31 |
| repos | backend | test/repos.test.ts | __process_timeout__ | repos.test.ts: createTestServer() background git clone subprocess keeps the event loop alive after tests complete; process killed after 3 minutes | 2026-10-31 |
| repos | backend | test/repos.test.ts | Repositories API > POST .../sync changes status to "cloning" | Background performSync from POST /repos sets syncInFlight before the sync-status test fires, returning 409 instead of 202 | 2026-10-31 |
| repos | backend | test/repos-progress.test.ts | __process_timeout__ | repos-progress.test.ts: createTestServer() in before() hook hangs; background git clone subprocess never terminates | 2026-10-31 |
| attachments | backend | test/ai-attachments.test.ts | __process_timeout__ | test/ai-attachments.test.ts: generate-based tests spin up a server that keeps the event loop alive past the runner timeout | 2026-10-31 |
| repos | ui | §repos | Repo with in-progress clone renders [role=progressbar] | Clone progress indicator not rendering in repos list during an active clone | 2026-10-31 |
| reviews | ui | §reviews | Creating a review then opening it navigates to reviews/code/:rid | Review detail navigation route does not match expected /reviews/code/:rid | 2026-10-31 |
| testing-module | ui | §testing-module | Async generate: dialog closes, indicator appears, done clears it and shows toast | Async generate flow: dialog-close and indicator-appear state transitions do not fire in the expected order | 2026-10-31 |

## Shared file blast-radius decisions

These files affect multiple modules when changed.

| Sources | Affects | Rationale |
|---------|---------|-----------|
| server/db.ts, server/http.ts, server/util.ts, server/index.ts, server/events.ts | **all modules** | Every server module depends on the DB, router, util helpers, entry-point registration, or the event bus. The UI smoke tests run against the real server binary, so a change here can break any module's backend tests AND its smoke assertions. No part restriction. |
| package.json, package-lock.json, tsconfig.json, scripts/build.mjs, scripts/preflight.mjs | **all modules** | Dependency or build-config changes can break any module silently — both compiled server code and the web bundle. Affects both backend and UI. |
| test/fixtures.ts, test/fake-sdk.mjs, test/fake-kiro.mjs | **all modules** | Every backend test imports from fixtures.ts. fake-sdk and fake-kiro are used across multiple test suites. These are test helpers only — they don't affect the built server or the smoke suite. |
| test/ui/smoke.ts | **all modules** | The smoke runner itself is shared UI infrastructure. Changes to timing, helpers, section list, or the SMOKE_ONLY mechanism only affect smoke (UI) outcomes, not backend unit tests. |
| server/agent/runner.ts, server/agent/claude-code.ts, server/agent/demo.ts, server/agent/kiro.ts, server/agent/litellm.ts, server/agent/pricing.ts, server/agent/types.ts | sessions, workflows, reviews, branch-scans, testing-module | The agent runner executes sessions, drives workflow steps, runs code reviews, branch scans, and test runs. Server code — affects both backend tests and smoke (via running server behaviour). No part restriction. |
| web/src/App.jsx, web/src/main.jsx, web/src/styles.css, web/src/styles/base.css, web/src/styles/components.css, web/src/lib/api.js, web/src/lib/events.js, web/src/lib/cx.js, web/src/lib/util.js | **all modules** | Every page is rendered through App.jsx and uses api.js, events, and the global stylesheet. Web-only files — they don't affect backend unit tests. Affects only UI parts. |
| web/src/components/Icon.jsx, web/src/components/Skeleton.jsx, web/src/components/Toast.jsx | **all modules** | Used on virtually every page; a breakage is visible across the entire UI. Web-only files — affects only UI parts. |
| web/src/lib/useRunStream.js | sessions, reviews, testing-module | Only features that display real-time agent output use this hook. Web-only file — affects only UI parts. |
| web/src/components/FilePreviewModal.jsx | attachments, sessions, knowledge | Used for previewing uploaded files in sessions, knowledge base documents, and the attachments picker. Web-only file — affects only UI parts. |
| web/src/lib/awsCredParser.js, web/src/lib/awsRegions.js, web/src/components/AwsRegionSelect.jsx | credentials, aws-accounts, bedrock-sso | Specific to AWS credential entry, account management, and Bedrock SSO flows. Web-only files — affects only UI parts. |
| web/src/components/DeviceCodeBox.jsx | bedrock-sso, auth, credentials | Used in Bedrock SSO device-code flow, auth provider setup, and the Kiro IAM Identity Center re-authentication flow in the Credentials page. Web-only file — affects only UI parts. |
| web/src/components/WorkspaceHeader.jsx | workspaces, sessions, ide | Rendered in workspace and session views. Web-only file — affects only UI parts. |
| web/src/lib/router.js | shell, projects, auth, setup | Route changes affect navigation in shell, project listing, post-login redirect, and setup wizard steps. Web-only file — affects only UI parts. |
| web/src/lib/templates/index.js | knowledge, generated-docs, presentations | Document and presentation templates used across knowledge base, generated docs, and presentations. Web-only file — affects only UI parts. |
| shared/themes | theme | Theme palette CSS definitions — web-only. Changes affect only the theme module's UI part. |

## Backend-only modules (added beyond UI contract)

These modules have no smoke section but have backend tests:
`security`, `storage`, `db`, `health`, `guardrails`, `output-files`, `user-config`

