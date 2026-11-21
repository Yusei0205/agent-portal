# Knowledge built from a project's repositories

Date: 2026-11-21. Status: approved by the owner ("Yes proceed no 2"; generated documents are used straight away, no review step).

## Intent

Some projects have no documents to upload, so Knowledge (and with it Kyu, Ask and Search) has nothing to answer from. The portal can
already write documents from code (Create › Documents runs an agent over the chosen repositories), but the result stays in Create.
The owner wants a project's knowledge to be built from its repositories in one step and kept current.

## Approaches

1. "Add to Knowledge" on a generated document (copy kept in sync on refresh).
2. **That, plus "Build from repositories" on the Knowledge page (chosen):** one action starts a standard set of documents from the chosen
   repositories, each kept in Knowledge.
3. Index raw source files in Knowledge. Rejected: poor answers to "how do I" questions, heavy indexing.

## Design

- **Link.** A generated document carries `sources.knowledge = { on: boolean, docId?: string }` in its `sources_json`. When `on`, every
  finished version (first run, Refresh, Retry) is written into Knowledge: the first time a Knowledge document is created
  (`<name>.md`, Markdown, status ready, indexed like an upload, search backends updated); later versions overwrite that same
  document's Markdown and re-index it (no duplicates). A failure here never fails the generation; it is logged.
- **Build from repositories.** `POST /api/projects/:id/knowledge/build { repoIds: string[] (1+), types?: string[] }` (editors and up, as
  for generated documents). Default types: System overview, Architecture, API reference, Runbook. Creates one generated document per type
  with `repoIds` as its sources and `knowledge.on = true`, named `<Type label> · <repo names>` (cut to the name limit), with the
  person's default sign-in, and starts each run. Response: the created documents. The per-project generated-document limit applies.
- **Add to Knowledge on one document.** `PUT /api/projects/:id/generated-docs/:docId/knowledge { on }` (editors). `on: true` sets the link
  and, if a version exists, writes it now. `on: false` clears the link and deletes the Knowledge copy.
- **Knowledge list.** `GET /api/projects/:id/knowledge` adds `generated: { id, name, status, stale }` to documents that came from a
  generated document. Deleting such a Knowledge document clears the link (a later Refresh does not bring it back).
- **UI.** Knowledge › Documents: a **Build from repositories** button opens a dialog (repositories to read, document types, Start);
  generated documents show a "Generated from code" tag, and a **Rebuild** button (the generated document's Refresh) and a link to it
  in Create. Create › Documents: each document gets **Add to Knowledge** / **In Knowledge ✓** (toggle).
- **Docs.** The user guide section "Generating documentation or knowledge from your repositories" describes both.

## Non-goals

- No review step; no automatic rebuild when code changes (Rebuild is manual; the existing "stale" flag still shows).
- No raw source indexing.

## Builder's calls

- Default four types (the user guide type needs a running system, so it is not in the default set).
- `on: false` deletes the copy (keeps Knowledge free of documents nobody maintains).
