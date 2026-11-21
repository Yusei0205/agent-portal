# Workflow template library

Open a project, choose **Workflows → Template library**.

## System and user templates

**System templates** ship with the portal. Their defaults are shared, read-only product content. **Customize for project** opens the workflow canvas for a project-specific override: change instructions, steps, connections, model/agent choices, repository selection and limits, then choose **Save project override**. Other projects continue to use their own defaults or overrides.

**Reset to default** restores the latest shipped name, description and graph for this project. It removes the effect of the project's customization and preserves a revision marker to reject stale saves. It does not edit workflows already created from that template, published versions or runs. Customizations remain pinned to their original default version until explicitly reset; the library can identify when a newer shipped default is available.

**User templates** are reusable templates created by the project's users. Choose **New user template**, or open a workflow and choose **Save as template** to copy its current draft. These templates are shared with project members and have their own editable names, descriptions and graphs. They can be deleted from the library; existing workflows retain their own copies. Deleted templates cannot be used to create new workflows.

The New workflow picker separates system and user templates. **Use template** opens a preview/name step; **Create workflow** takes a snapshot of the selected template. Publishing and running remain separate explicit actions. Saving a reusable template neither starts a run nor changes a published workflow.

Project viewers may read templates. Editors/owners and authorized portal admins may create, edit, reset or delete them. Existing API token scope checks and session-token restrictions apply. Concurrent edits use the repository's revision compare-and-swap. Valid executable graphs and project-owned repositories are required when saving a reusable template. The library supports up to 100 active user templates per project.

## Curated system catalog

The original SDLC, Jira Development and Jira Testing templates retain their identifiers and behavior. Ten focused starters have been added:

| Template | Main stages | Expected input |
| --- | --- | --- |
| Bug fix with regression test | Diagnose → fix → verify → human review | Reproduction steps and expected behavior |
| Feature implementation | Acceptance/design → implement → verify → human review | Objective, constraints and acceptance criteria |
| Code review and risk assessment | Scope diff → review → evidence/report → human review | PR, refs or files |
| Test coverage and edge cases | Test matrix → add tests → execute/report → human review | Module, API or behavior |
| Repository security review | Trust boundaries → scoped review/scans → remediation plan → human review | Code area and permitted scan scope |
| Dependency update and compatibility | Impact/migration plan → update → verify → human review | Packages, target versions and constraints |
| Behavior-preserving refactor | Invariants → refactor → compare/check → human review | Scope and maintainability problem |
| Technical documentation and onboarding | Code research → write → validate → human review | Audience and documentation scope |
| CI failure diagnosis and repair | Diagnose logs → repair cause → verify → human review | Failed run/job/log and commit |
| Release readiness and rollout plan | Collect evidence → rollout/rollback plan → readiness notes → human review | Release refs, environment and criteria |

The new starters generate evidence and do not automatically publish, merge or deploy. Release readiness prepares a plan; it does not execute a deployment. The existing Jira workflows still require the relevant connections and keep their existing behavior. Engines, sign-ins, tools, repositories and task-specific check commands must fit the project. A template is a starting point, not a claim that a task was tested or completed.

## Research basis (reviewed 2026-11-19)

This is a curated SDLC catalog, not a statistically ranked list of the most-used workflows. The research establishes recurring task patterns; it does not provide comparable usage counts across agent platforms.

- [GitHub Copilot task guidance](https://docs.github.com/en/enterprise-cloud%40latest/copilot/tutorials/cloud-agent/get-the-best-results) identifies bug fixes, UI changes, test coverage, documentation, accessibility and technical debt as useful task categories. This informed the focused fix, feature, test, refactor and documentation starters.
- [GitHub Copilot agents](https://docs.github.com/en/copilot/concepts/agent-capabilities/about-agents/about-github-copilot-agents) describes repository research, planning, editing, tests and adapting to failures. This informed the diagnose/implement/verify structure.
- [GitHub's starter-workflow catalog](https://github.com/actions/starter-workflows) covers CI, deployment, code review and automation categories. This informed CI triage, review and release preparation.
- [Dependabot security updates](https://docs.github.com/en/code-security/concepts/supply-chain-security/dependabot-security-updates) documents dependency remediation through update pull requests. This informed dependency assessment and compatibility verification; the portal template is not a replacement for Dependabot.
- [GitHub deployment guidance](https://docs.github.com/en/actions/get-started/continuous-deployment) describes build/test evidence and environment approvals, and distinguishes agentic release preparation from deterministic production deployment. This informed the readiness/rollout starter.

## Context when starting a run

The **Runs** form supports file uploads, drag/drop and images pasted into **Run request**. Requirements and technical designs may be attached as DOCX/PDF or other file types accepted by the existing session attachment picker. The deployment's file/total limits are displayed. Uploads must finish before a run can start; switching between Design and Runs preserves them.

The optional **Jira issue context** uses a searchable dropdown from the project's configured Jira connection. Search by key or summary, filter Jira projects, switch Mine/All, inspect details, select an issue, or remove the selection. An unconnected project shows a setup link and a refresh action. The run API also accepts one issue key or HTTPS `/browse/KEY` link for programmatic callers; it does not fetch that URL as an arbitrary remote destination. Explicit Jira context must load successfully before execution starts. Issue text and the attachments that fit are saved as a run snapshot. Files that cannot be delivered are reported in the ticket context or delivery warnings.

Every agent step receives the run's saved files and explicit Jira snapshot, including after an approval wait or fresh worker invocation. Refer to each source's role in the run request, for example: “Use requirements.docx as the acceptance criteria and technical-design.pdf as the architecture constraints; compare the pasted screen with Jira ABC-123.” The step is instructed to cite filenames/sections, treat document content as reference data, and report inaccessible or conflicting sources. Binary document interpretation still depends on the selected engine's available tools; delivery tests do not prove a model understood a document or image.

The selected history entry lists **Saved context for this run**. Changing a template or deleting a pending upload does not rewrite a run's file snapshot. Existing Jira templates that use `{{jira.ticket}}` retain their request-text lookup when no explicit Jira snapshot was supplied.

## Storage and API

Templates use `TEMPLATE#<id>` records in the existing project-scoped automation repository, on both SQLite and DynamoDB. No schema/table migration is needed. Code remains the source of system defaults; only project overrides, reset markers and user templates are persisted.

- `GET /api/projects/:id/automations/templates`: effective system and user templates.
- `POST /api/projects/:id/automations/templates`: create a user template.
- `PUT /api/projects/:id/automations/templates/:tid`: save a revision-checked override or user template.
- `POST /api/projects/:id/automations/templates/:tid/reset`: restore a system template, revision checked.
- `DELETE /api/projects/:id/automations/templates/:tid`: archive a user template, revision checked.

The existing automation list response includes effective templates. Workflow creation accepts `templateId` and optional `templateRevision`; a stale observed template revision returns 409. Definitions created from a template store its ID, source and project revision as provenance. The copied graph and immutable published graph remain authoritative for execution.
