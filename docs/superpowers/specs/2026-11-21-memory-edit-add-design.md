# Project memory: edit a note and add a note

Date: 2026-11-21. Status: approved by the owner ("Proceed") and built.
Builds on: `server/agentcore-memory.ts` (approve / reject / delete) and `2026-11-21-cat-project-context-design.md` (the cat reads approved notes).

## Intent

A note AgentCore extracted can be almost right ("tests run with npm test" when it is now `pnpm vitest`), and some facts never come up
in a session. Today the owner can only reject or delete. They want to correct a note and write a fact themselves so the agents and the
cat answer correctly.

## Approaches

1. **Edit and add through AgentCore's own record API (chosen):** `BatchUpdateMemoryRecords` changes a record's text in place;
   `BatchCreateMemoryRecords` writes a new record into the project's facts namespace. Notes stay in one place, retrieval and the approval
   list keep working unchanged.
2. Keep owner corrections in the portal's own settings and merge them into prompts. Rejected: two stores to keep in step, and the
   corrected fact would not be found by AgentCore's relevance search.

## Design

- **Edit:** `PUT /api/projects/:id/memory/records/:rid` with `{ text }` (owner or portal admin; the record must be in this project, as for
  approve). Only `fact` notes can be edited (summaries are per-session history). Text is trimmed, 1–1,000 characters, secrets masked with
  `redactSecrets`. The record keeps its id; its status becomes `approved` (the owner wrote it). `{ status }` keeps working as today; a body
  with both is refused (400).
- **Add:** `POST /api/projects/:id/memory/records` with `{ text }` (owner or admin), same text rules; written to `/project/<id>/facts`,
  status `approved`. Works whether or not "Learn from this project's sessions" is on (the switch controls learning from sessions and use;
  an added note is used once memory is on). Response `{ id, text, status: 'approved' }`; 502 when AgentCore reports the record failed.
- **Origin:** a setting `agentcore.memory.by.<rid>` records who edited or added the note (user id); the list returns `edited: true` for
  such notes and the panel tags them "edited by an owner". Builder's call.
- **UI (AgentCore page, Project memory panel):** an "Add a note" box above the table (textarea + Add), and an Edit button per fact row that
  turns the cell into a textarea with Save and Cancel. Managers only; members see the list as today.
- **Permissions:** the portal's role gets `bedrock-agentcore:BatchCreateMemoryRecords` and `BatchUpdateMemoryRecords` on the memory
  (infra/lib/portal-stack.ts); deployed by the Deploy portal workflow's `cdk deploy`.

## Non-goals

- The cat does not write notes; no editing of summaries; no per-note history.
- Opening the panel to non-admin owners (they can call the API today but cannot open the AgentCore page) stays a separate change.

## Known limit

AgentCore's own extraction may later add a new fact that contradicts an edited one; it arrives as pending and is not used until approved.
