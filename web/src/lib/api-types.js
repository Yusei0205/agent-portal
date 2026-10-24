// @ts-check
// Shapes of the main API responses, as JSDoc typedefs. The web app is plain JSX, so nothing here runs: it exists so
// editors can show the fields and `// @ts-check` files can use them. Keep them in step with the server:
//   Project          server/projects.ts (listProjectsFor)
//   WorkflowView     server/workflows/views.ts (view)
//   RunSummary/Run   server/agent/runner.ts (runSummary) and server/runs.ts (GET /api/runs/:id)
//   InboxItem        server/loop-engine.ts (InboxItem)
//
// Use them as `import('./api-types.js').Project` in a JSDoc comment, for example:
//   /** @type {import('../lib/api-types.js').Project[]} */
//
// The module exports nothing at run time, so importing it costs no bundle size.

/** @typedef {'viewer' | 'editor' | 'owner'} Access */

/**
 * A project in the list the signed-in person can see.
 * @typedef {object} Project
 * @property {string} id
 * @property {string} slug
 * @property {string} name
 * @property {string} description
 * @property {string} notes
 * @property {string} created_by
 * @property {string} created_at
 * @property {number} archived 1 when archived, else 0
 * @property {string} default_lead_agent Lead agent new sessions start with ('' = the main agent decides)
 * @property {string} default_model Model new sessions start with ('' = sonnet): a tier or an exact model ID
 * @property {Access} access The signed-in person's access to this project
 * @property {number} docs Uploaded documents
 * @property {number} repos Attached repositories
 * @property {number} open_questions Questions waiting for a person
 * @property {number} pending_approvals Approvals waiting for a person
 * @property {number} members Project members
 */

/** @typedef {'queued' | 'running' | 'done' | 'paused' | 'blocked' | 'failed' | 'stopped'} SessionStatus */

/** @typedef {'chat' | 'test' | 'review' | 'qa' | 'learn' | 'quiz' | 'verify' | 'connection'} RunKind */

/** @typedef {'queued' | 'running' | 'waiting' | 'done' | 'failed' | 'stopped' | string} RunStatus */

/**
 * A repository attached to a session.
 * @typedef {object} SessionRepo
 * @property {string} repoId
 * @property {string} name
 * @property {string} branch
 */

/**
 * A push the agents asked for that waits for a person.
 * @typedef {object} PendingPush
 * @property {string} [message]
 * @property {boolean} [pr]
 * @property {string} [base]
 * @property {string} [branch]
 */

/**
 * A session, as the list and the workspace show it (the `workflow` of GET /api/workflows/:id).
 * @typedef {object} WorkflowView
 * @property {string} id
 * @property {string} project_id
 * @property {string} title
 * @property {string} goal
 * @property {SessionStatus} status
 * @property {string | null} stop_reason
 * @property {string | null} last_run_status Status of the latest run
 * @property {number} pending_inputs Questions or approvals the latest run waits for
 * @property {number} context_count Items in the session context
 * @property {string | null} repo_id
 * @property {string | null} branch
 * @property {SessionRepo[]} repos
 * @property {{ id: string, name: string } | null} workspace
 * @property {{ id: string, title: string, status: SessionStatus } | null} parent
 * @property {{ id: string, title: string, status: SessionStatus, summary: string }[]} children
 * @property {number} depth
 * @property {boolean} waiting_children
 * @property {'never' | 'ask' | 'auto'} push_mode
 * @property {PendingPush | null} pending_push
 * @property {{ reason: string, since: string, claudeReady: boolean } | null} engine_switch
 * @property {string[]} integrations
 * @property {{ id: string, name: string, kind: string, allow_writes: number }[]} integration_list
 * @property {string} model
 * @property {number | null} budget_usd
 * @property {number | null} budget_credits
 * @property {number | null} spent_credits
 * @property {number} spent_usd
 * @property {string} engine '' = the project's default engine
 * @property {string} provider Provider the session runs on (for example 'anthropic', 'bedrock', 'kiro', 'demo')
 * @property {number} max_iterations
 * @property {boolean} single_run
 * @property {string} permission_mode
 * @property {string | null} verify_command
 * @property {string | null} rules
 * @property {number} iteration
 * @property {number} burst_start
 * @property {string | null} last_run_id
 * @property {string | null} work_branch
 * @property {string | null} lead_agent
 * @property {string | null} jira_key
 * @property {string | null} jira_summary
 * @property {string | null} jira_url
 * @property {string | null} summary
 * @property {string} created_at
 * @property {string} updated_at
 * @property {boolean} playground
 * @property {boolean} trust_tools
 * @property {string | null} loop_spec_id
 * @property {boolean} planning_gate
 * @property {string} queue_reason
 * @property {string | null} queued_at
 */

/**
 * An entry in a session's history.
 * @typedef {object} WorkflowEvent
 * @property {number} id
 * @property {string} kind
 * @property {string | null} run_id
 * @property {string} body
 * @property {Record<string, unknown>} data
 * @property {boolean} consumed
 * @property {string} created_at
 */

/**
 * A run in a session's run list.
 * @typedef {object} RunListEntry
 * @property {string} id
 * @property {string} title
 * @property {RunStatus} status
 * @property {number} cost_usd
 * @property {string} created_at
 * @property {string | null} finished_at
 */

/**
 * The response of GET /api/workflows/:id.
 * @typedef {object} WorkflowResponse
 * @property {WorkflowView} workflow
 * @property {WorkflowEvent[]} events
 * @property {RunListEntry[]} runs
 * @property {boolean} driving True while the portal is running the session's loop
 */

/**
 * One agent run: a session iteration or a background task.
 * @typedef {object} RunSummary
 * @property {string} id
 * @property {string} project_id
 * @property {string | null} workflow_id
 * @property {RunKind} kind
 * @property {string} title
 * @property {RunStatus} status
 * @property {number} cost_usd
 * @property {number} input_tokens
 * @property {number} output_tokens
 * @property {string | null} model
 * @property {string | null} provider
 * @property {string} created_at
 * @property {string | null} finished_at
 * @property {string | null} created_by
 * @property {Record<string, unknown>} meta
 */

/**
 * A run with the fields GET /api/runs/:id adds.
 * @typedef {RunSummary & {
 *   prompt: string,
 *   result: string | null,
 *   error: string | null,
 *   worktree: string | null,
 *   branch: string | null,
 *   repo_id: string | null,
 *   permission_mode: string | null,
 *   session_id: string | null,
 *   resume_of: string | null,
 *   started_at: string | null,
 * }} Run
 */

/**
 * One event of a run's transcript.
 * @typedef {object} RunEvent
 * @property {number} seq
 * @property {string} ts
 * @property {string} type
 * @property {string | null} parent_tool_use_id
 * @property {Record<string, unknown>} data
 */

/** @typedef {'waiting' | 'push_ready' | 'plan_pending' | 'escalation' | 'engine_switch' | 'done' | 'running' | 'queued'} InboxKind */

/**
 * One row of the Inbox (GET /api/inbox).
 * @typedef {object} InboxItem
 * @property {InboxKind} kind
 * @property {string} workflowId
 * @property {string} projectId
 * @property {string} projectName
 * @property {string} sessionTitle
 * @property {string} detail
 * @property {string | null} prUrl
 * @property {string | null} [workBranch] Work branch of a done item without a PR
 * @property {string | null} [repoId] First repository of a done item
 * @property {string} createdAt
 * @property {boolean} isOverdue
 */

/**
 * The response of GET /api/inbox.
 * @typedef {object} InboxResponse
 * @property {InboxItem[]} items
 * @property {number} needs_you How many items need a person
 */

/**
 * The signed-in person, as the app holds it.
 * @typedef {object} User
 * @property {string} id
 * @property {string} email
 * @property {string} name
 * @property {number} is_admin 1 for an administrator, else 0
 */

/** @typedef {'system_context' | 'components' | 'data_flow'} DiagramKind */

/**
 * A repository and commit a diagram version was drawn from.
 * @typedef {object} DiagramSource
 * @property {string} repoId
 * @property {string} name
 * @property {string} slug
 * @property {string} branch
 * @property {string} sha
 */

/**
 * A diagram, as the list shows it (GET /api/projects/:pid/diagrams) and the detail extends it with `mermaid`.
 * @typedef {object} DiagramSummary
 * @property {string} id
 * @property {string} project_id
 * @property {DiagramKind} kind
 * @property {string} kind_label
 * @property {string} title
 * @property {string} slug
 * @property {string} focus
 * @property {{ id: string, name: string, slug: string, removed: boolean }[]} repos
 * @property {'generating' | 'ready' | 'error'} status
 * @property {string | null} error With status "ready": the last refresh failed and the previous version was kept
 * @property {number} version Latest version, 0 before the first one
 * @property {number} stale 1 when a repository moved on since the latest version
 * @property {boolean} generating
 * @property {string | null} workflow_id The session drawing it, while generating
 * @property {string} path Where the latest version is kept in the project repository
 * @property {string} description
 * @property {string[]} citations Source files the description cites
 * @property {DiagramSource[]} sources
 * @property {string | null} generated_at
 * @property {string | null} created_by_name
 * @property {string} created_at
 * @property {string} updated_at
 * @property {string} [mermaid] Only in the detail response
 */

/**
 * One stored version of a diagram (the version list leaves `mermaid` out).
 * @typedef {object} DiagramVersion
 * @property {number} version
 * @property {string} description
 * @property {string[]} citations
 * @property {DiagramSource[]} sources
 * @property {string | null} workflow_id
 * @property {string | null} run_id
 * @property {string | null} created_by_name
 * @property {string} created_at
 * @property {number} chars
 * @property {string} [mermaid]
 */

/**
 * Whether PNG export works on this server, and why not.
 * @typedef {object} DiagramExportCapability
 * @property {boolean} png
 * @property {string | null} pngReason
 */

/**
 * GET /api/projects/:pid/diagrams. Live updates arrive as the `diagrams.updated` project event.
 * @typedef {object} DiagramListResponse
 * @property {DiagramSummary[]} diagrams
 * @property {{ id: DiagramKind, label: string }[]} kinds
 * @property {DiagramExportCapability} export
 * @property {{ mermaidChars: number, repos: number, focusChars: number, perProject: number }} limits
 */

/**
 * GET /api/projects/:pid/diagrams/:id.
 * @typedef {object} DiagramDetailResponse
 * @property {DiagramSummary} diagram
 * @property {DiagramVersion[]} versions Newest first
 * @property {DiagramExportCapability} export
 */

export {};
