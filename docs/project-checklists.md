# Project deployment and security checklists

Open **Setup → Checklists** in a project. Generate an initial checklist, or add
deployment targets first. A project can have multiple named AWS, Azure, GCP and
custom service targets, including more than one target of the same provider.

The portal inspects every added repository's local reference clone, independent
of language. It inventories files and languages, detects cloud configuration
references, and extracts Terraform resource identifiers. Shared deployment and
security review prompts apply to every repository, including unknown languages.
Configuration key names referenced by common environment APIs are included with
source line references, without copying their values.
Each target also gets provider configuration and security requirements. This is
static heuristic analysis, not a vulnerability scanner or deployment validator.
No repository commands run and source contents or secret values are not stored
in the checklist. Evidence consists of repository-relative paths and line numbers
where available. Add review documents, URLs or other evidence references manually.

Successful repository clone/sync operations refresh the checklist automatically.
**Regenerate** refreshes the inventory and appends new requirements. Existing rows
win in full, preserving categories, resource names, requirements, evidence, notes,
manual rows and review statuses. Removed rows stay suppressed. Historical rows
remain if a repository/resource disappears; reviewers can remove them or mark them
not applicable. Renaming a provider or changing its type does not rewrite existing
requirements; review those rows manually or add a new target.

The analysis skips dependency/build folders, symlinks, secret files and binary
contents. Limits are 12,000 filesystem entries, 24 directory levels, 128 KB per
file and 4 MB of contents per repository. The UI reports incomplete/unavailable
analysis. In cloud reference-check mode, repositories may have no local clone;
source analysis requires syncing a clone onto the analysis server. The checklist
still includes explicit manual review requirements in that case.

Project editors/owners and admins can generate and edit; project viewers can read
and export. Save changes to persist the document. Regenerate saves pending edits
first. Concurrent modifications return HTTP 409 rather than overwriting reviews;
copy pending edits before reloading a newer version. Review attribution is assigned
by the server. Export JSON or Markdown downloads the saved document, including
provider labels, evidence, review statuses and attribution.

Documents use existing SQLite key/value storage or a project-specific partition
in the DynamoDB `portal-config` table. Atomic conditional writes protect revisions
across instances. Documents are limited to 280 KB, 20 targets and 600 rows.

## API

- `GET /api/projects/:id/checklists`: saved document or `null`.
- `POST /api/projects/:id/checklists/generate`: `{ revision }`; creates or regenerates.
- `PUT /api/projects/:id/checklists`: `{ revision, targets, items }`; saves edits.
- `GET /api/projects/:id/checklists/export?format=json|markdown`: saved export.

The first write uses revision `0`; every successful write increments it. Deletion
suppression, analysis and attribution are maintained by the server.
