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

/** @typedef {'waiting' | 'push_ready' | 'plan_pending' | 'escalation' | 'engine_switch' | 'review_ready' | 'done' | 'running' | 'queued'} InboxKind */

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

/** @typedef {'pptx' | 'docx'} TemplateKind */
/** @typedef {'project' | 'portal'} TemplateScope */

/**
 * What the server found out about an uploaded template. PowerPoint templates also carry layout details.
 * @typedef {object} TemplateInfo
 * @property {TemplateKind} kind
 * @property {string[]} warnings Plain-language problems, for example a missing layout role
 * @property {number} [slideWidthIn]
 * @property {number} [slideHeightIn]
 * @property {{ major: string, minor: string }} [fonts]
 * @property {Record<string, string>} [colors]
 * @property {{ name: string, type: string }[]} [layouts]
 * @property {Record<string, string | null>} [mapping] Which layout plays each role (title, section, content, titleOnly, side)
 */

/**
 * A template (GET /api/projects/:pid/templates and GET /api/templates). The API never shows a file path.
 * @typedef {object} DocTemplate
 * @property {string} id
 * @property {TemplateKind} kind
 * @property {string} name
 * @property {TemplateScope} scope
 * @property {string | null} project_id
 * @property {string} filename
 * @property {number} size Bytes
 * @property {boolean} is_default The default of its scope and kind
 * @property {boolean} effective The one that applies to the project (project default, else portal default)
 * @property {TemplateInfo} info
 * @property {string | null} uploaded_by_name
 * @property {string} created_at
 * @property {string} updated_at
 */

/**
 * The template that applies for a kind, or null (the built-in look).
 * @typedef {{ id: string, name: string, scope: TemplateScope, kind: TemplateKind } | null} EffectiveTemplate
 */

/**
 * The template list; also the answer of every template change.
 * @typedef {object} TemplateListResponse
 * @property {DocTemplate[]} templates A project's own, then the portal ones
 * @property {{ pptx: EffectiveTemplate, docx: EffectiveTemplate }} effective
 * @property {{ bytes: number, perProject: number, portal: number, extensions: string[] }} limits
 */

/** @typedef {'topic' | 'document' | 'session' | 'diagram'} PresentationSourceKind */

/**
 * A presentation (GET /api/projects/:pid/presentations). Live updates arrive as the `presentations.updated` project event.
 * @typedef {object} PresentationSummary
 * @property {string} id
 * @property {string} project_id
 * @property {string} title
 * @property {{ kind: PresentationSourceKind, ref: string, label: string }} source
 * @property {string} audience
 * @property {number} slide_target
 * @property {{ requested_id: string | null, requested_name: string | null, used: string | null }} template
 * @property {'generating' | 'ready' | 'error'} status
 * @property {string | null} error
 * @property {boolean} generating
 * @property {boolean} queued
 * @property {string | null} workflow_id The session making it
 * @property {string | null} run_id
 * @property {number | null} slide_count
 * @property {number | null} bytes
 * @property {string[]} warnings From make-doc, for example a template that could not be applied
 * @property {{ download: string, preview: string } | null} links Only when ready
 * @property {string | null} created_by_name
 * @property {string} created_at
 * @property {string} updated_at
 * @property {PresentationSlide[]} [outline] Only in the detail response
 */

/**
 * One slide of the deck outline.
 * @typedef {object} PresentationSlide
 * @property {number} index 1-based
 * @property {string} title
 * @property {string} layout
 * @property {string} notes
 * @property {number} bullets
 * @property {boolean} hasPicture
 * @property {boolean} hasTable
 */

/**
 * Whether slide previews can be PNG on this server, and why not.
 * @typedef {object} PreviewCapability
 * @property {boolean} png
 * @property {string | null} pngReason
 */

/**
 * GET /api/projects/:pid/presentations.
 * @typedef {object} PresentationListResponse
 * @property {PresentationSummary[]} presentations Newest first
 * @property {PresentationSourceKind[]} sources
 * @property {{ id: string, name: string, scope: TemplateScope } | null} template The default that applies when none is chosen
 * @property {PreviewCapability} preview
 * @property {{ topicChars: number, audienceChars: number, titleChars: number, slidesMin: number, slidesMax: number, slidesDefault: number, perProject: number }} limits
 */

/**
 * GET /api/projects/:pid/presentations/:id.
 * @typedef {object} PresentationDetailResponse
 * @property {PresentationSummary} presentation
 * @property {WorkflowView | null} workflow
 * @property {PreviewCapability} preview
 */

/**
 * GET /api/projects/:pid/presentations/:id/preview.
 * @typedef {object} PresentationPreview
 * @property {'png' | 'svg'} format
 * @property {boolean} approximate Always true: the portal draws the slides itself
 * @property {string} note
 * @property {boolean} png_available
 * @property {string | null} png_reason Why there is no PNG
 * @property {{ index: number, title: string, layout: string, notes: string, url: string, svg_url: string, png_url?: string }[]} slides
 */

/** @typedef {'overview' | 'architecture' | 'api' | 'runbook' | 'user-guide'} GeneratedDocType */

/**
 * A checked citation of one document version (detail responses only).
 * @typedef {object} DocCitation
 * @property {string} text As written in the document
 * @property {string} path
 * @property {number | null} line
 * @property {string | null} repo
 * @property {boolean} ok Whether the file (and line) exists in the snapshot the document was written from
 * @property {string | null} reason Why it does not resolve
 */

/**
 * What one version was written from.
 * @typedef {object} DocSources
 * @property {{ id: string, name: string, slug: string, branch: string, commit: string | null }[]} repos
 * @property {{ documents: number, names: string[] } | null} knowledge null when knowledge was not used
 * @property {boolean} decisions
 * @property {{ id: string, slug: string, title: string, version: number | null }[]} diagrams
 */

/**
 * One version of a generated document. The detail form adds `markdown` and `citations.items`.
 * @typedef {object} GeneratedDocVersion
 * @property {number} version
 * @property {string} title
 * @property {number} bytes
 * @property {boolean} has_word False when the Word file could not be built
 * @property {string | null} template_used
 * @property {string[]} warnings
 * @property {{ total: number, unresolved: number, items?: DocCitation[] }} citations
 * @property {DocSources} sources
 * @property {string | null} workflow_id
 * @property {string | null} created_by_name
 * @property {string} created_at
 * @property {{ markdown: string, word?: string }} links
 * @property {string} [markdown]
 */

/**
 * A generated document (GET /api/projects/:pid/generated-docs). Live updates arrive as the `generated-docs.updated` project event.
 * @typedef {object} GeneratedDocSummary
 * @property {string} id
 * @property {string} project_id
 * @property {GeneratedDocType} type
 * @property {string} type_label
 * @property {string} title
 * @property {string} audience
 * @property {{ id: string, name: string, slug: string, removed: boolean }[]} repos
 * @property {boolean} include_knowledge
 * @property {boolean} include_decisions
 * @property {{ id: string, title: string, slug: string, removed: boolean, used_version: number | null, current_version: number | null }[]} diagrams
 * @property {{ requested_id: string | null, requested_name: string | null, used: string | null }} template
 * @property {'generating' | 'ready' | 'error'} status A failed rewrite keeps `ready` and sets `error`
 * @property {string | null} error
 * @property {boolean} generating
 * @property {boolean} queued
 * @property {string | null} workflow_id The session writing it
 * @property {number} version 0 until the first version exists
 * @property {boolean} stale
 * @property {string[]} stale_reasons Plain-language reasons
 * @property {string[]} warnings Of the current version
 * @property {{ total: number, unresolved: number }} citations
 * @property {number} bytes
 * @property {boolean} has_word
 * @property {string | null} generated_at
 * @property {{ markdown: string, word?: string } | null} links
 * @property {string | null} created_by_name
 * @property {string} created_at
 * @property {string} updated_at
 * @property {string} [markdown] Only in the detail response
 * @property {GeneratedDocVersion | null} [current] Only in the detail response
 * @property {GeneratedDocVersion[]} [versions] Only in the detail response, newest first
 */

/**
 * Whether diagrams can be drawn into the Word file on this server.
 * @typedef {object} WordCapability
 * @property {boolean} diagrams
 * @property {string | null} diagramsReason Why diagrams stay code blocks in Word
 */

/**
 * GET /api/projects/:pid/generated-docs.
 * @typedef {object} GeneratedDocListResponse
 * @property {GeneratedDocSummary[]} documents Newest first
 * @property {{ id: GeneratedDocType, label: string }[]} types
 * @property {{ id: string, name: string, scope: TemplateScope } | null} template The Word template that applies when none is chosen
 * @property {WordCapability} word
 * @property {{ titleChars: number, audienceChars: number, repos: number, diagrams: number, perProject: number }} limits
 */

/**
 * GET /api/projects/:pid/generated-docs/:id.
 * @typedef {object} GeneratedDocDetailResponse
 * @property {GeneratedDocSummary} document
 * @property {WorkflowView | null} workflow
 * @property {WordCapability} word
 */

/**
 * POST /api/projects/:pid/generated-docs/refresh-stale.
 * @typedef {object} GeneratedDocRefreshResponse
 * @property {number} stale
 * @property {{ docId: string, title: string, workflowId: string }[]} started
 * @property {{ docId: string, title: string, reason: string }[]} skipped
 */

export {};
