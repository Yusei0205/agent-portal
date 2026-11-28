/**
 * Ready-made document types a project can add with one click (Create › New document › + New type…, and Knowledge › Build from
 * repositories). Each becomes the project's own type (POST /api/projects/:id/doc-types) and can be edited like one typed by hand.
 * Names stay within 60 characters and contents within 2,000 (server/generated-doc-text.ts CUSTOM_TYPE_LIMITS).
 */
export const DOC_TYPE_PRESETS = [
  {
    key: 'technical-design',
    label: 'Technical design document',
    guide: 'A technical design document. Sections: Problem and goals; Scope and non-goals; Requirements, including non-functional ones (performance, availability, security); Proposed design (components, data flow, a sequence diagram of each main use case); Data model changes; Interfaces and contracts; Alternatives considered and why they were rejected; Risks and mitigations; Rollout and migration plan; Open questions.',
  },
  {
    key: 'deployment-guide',
    label: 'Deployment guide',
    guide: 'A deployment and infrastructure guide. Sections: Environments and how they differ; Resource inventory (a table of every infrastructure resource: name, type, purpose, size or tier, region); Resource relationships (what calls what, network paths, IAM roles and permissions, dependencies) with a diagram; Deployment pipeline step by step; Configuration and secrets (by name only); Backup (schedule, retention and the restore procedure for each data store); Disaster recovery (RTO and RPO, and the steps); Rollback; Costs to watch; Open questions.',
  },
  {
    key: 'onboarding',
    label: 'Developer onboarding guide',
    guide: 'A guide for a developer joining the project. Sections: Prerequisites and tools with versions; Clone, configure and run locally (copyable steps); Run the tests and linters; Repository layout (what lives where); Coding conventions, branching and pull request rules; Debugging; Common setup problems and their fixes; Who owns what; Where to read next.',
  },
  {
    key: 'configuration',
    label: 'Configuration reference',
    guide: 'A reference of every setting the system reads. One table per area with, for each environment variable, feature flag or configuration file key: name, purpose, type, default, allowed values, which environments set it, and whether it is a secret (name only, never the value). Then: how configuration is loaded and overridden, and Open questions.',
  },
  {
    key: 'data-model',
    label: 'Data model and dictionary',
    guide: 'A data model and data dictionary. For every database, table or collection: its purpose, then a table of its fields (meaning, type, constraints, example values). Then: relationships between entities with an ER diagram, indexes, data retention and deletion, personal or sensitive data and how it is protected, migrations, and Open questions.',
  },
  {
    key: 'integration',
    label: 'Integration specification',
    guide: 'An integration specification of every external system the project talks to. For each: purpose, direction, protocol, endpoints or queues, authentication, request and response formats (fields in tables), error handling and retries, timeouts and rate limits, a sequence diagram of the main exchanges, and the owning team if the code says. End with Open questions.',
  },
  {
    key: 'testing',
    label: 'Testing strategy',
    guide: 'A testing strategy. Sections: Test levels (unit, integration, end-to-end) and what each covers; How to run each (copyable commands); Test data and fixtures; How external services are mocked or stubbed; Coverage expectations; What CI runs and when; How to add a new test; Known gaps and Open questions.',
  },
  {
    key: 'security',
    label: 'Security overview',
    guide: 'A security overview. Sections: Authentication and authorization model (roles and what they may do); Data protection in transit and at rest; Secrets management (names and stores only); Trust boundaries and the main threats with their mitigations; Input validation and common vulnerability defences; Dependency and vulnerability handling; Audit logging; Known gaps; Open questions.',
  },
  {
    key: 'adr-log',
    label: 'Architecture decision records',
    guide: 'An architecture decision record log: one entry per significant decision visible in the code, configuration, documents and history. For each: title, date if known, status (accepted or superseded), context, the decision, alternatives considered, and consequences. Order them oldest first and finish with decisions that look open.',
  },
];

/** The presets a project has not saved yet (matched by name, ignoring case). */
export function unsavedPresets(saved) {
  const names = new Set((saved ?? []).map((t) => String(t.label).toLowerCase()));
  return DOC_TYPE_PRESETS.filter((p) => !names.has(p.label.toLowerCase()));
}
