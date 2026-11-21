# Cat assistant: context per project

Date: 2026-11-21. Status: draft, approach chosen by the owner ("Yes proceed" to options 1 and 2).
Builds on: `2026-11-21-cat-assistant-design.md` (B2, answers only).

## Intent

Today the cat forgets everything when its panel closes or the page reloads, and it does not know what the project's agents have
learned. The owner wants the cat to keep context for each project: pick up the conversation where it was left in that project, and
know the project's approved facts (how its tests run, its conventions).

## Approaches

1. **Conversation per project in the browser + read approved project memory (chosen).** No new server storage; owners keep control of
   memory through the existing approval list.
2. "Remember this" notes stored on the server for the cat. Rejected for now: reverses "nothing stored", and stored text that later goes
   into a prompt needs injection hardening and its own review screen.
3. A skill. Rejected: skills are instruction files for session agents in a project folder; the cat is a single model call and a skill
   holds how-to, not memory.

## Design

**A. Conversation kept per project (web only)**
- The panel's messages are saved in browser storage, one entry per signed-in user and project:
  `portal.cat.chat.<userId>.<projectId or "portal">` (outside a project, one shared "portal" conversation).
- Saved: the newest 20 messages (the panel's existing cap) with role, text, links, error flag; never the greeting or a pending
  reply. Loaded when the panel opens; if the route's project changes while the panel is open, it switches to that project's
  conversation. An entry not used for 14 days is dropped when read.
- The history sent with a question is unchanged (last 8 turns, from what is on screen), so a reopened conversation continues.
- A **Clear chat** button in the panel header empties the current project's conversation.
- Pure helpers in `web/src/lib/cat-assistant.js` (key, serialise, load with expiry), node-tested; storage calls wrapped in try/catch so a
  private window just starts fresh.

**B. The cat reads approved project memory (server)**
- New `projectMemoryNotes(projectId, query)` in `server/agentcore-memory.ts`, sharing code with `buildProjectMemoryBlock`: returns the
  approved fact texts (status `approved`, facts namespace only) relevant to the question, `[]` when memory is unavailable
  (`PORTAL_MEMORY_ID` unset), switched off for the project, slow (3 s timeout) or failing. Same 2,500-character cap.
- `POST /api/assistant/chat` calls it for a project question after the membership check, alongside knowledge retrieval, and passes
  the notes to `buildPrompt`, which adds an `[Approved project notes]` part inside the existing REFERENCE MATERIAL block, defanged
  like the other parts. When the prompt is too long, notes are trimmed after knowledge and before the guide.
- No change to who can see what: only members of the project reach this, and only owner-approved facts are used.

## Non-goals
- No conversation stored on the server; no syncing between browsers or devices.
- The cat does not write to project memory; no "remember this".
- No change to memory's approval flow or its off-by-default setting.

## Constraints
- No new dependency. Tests: node tests for the web helpers and the prompt/route, a smoke case that a conversation survives closing and
  reopening the panel and is separate per project. User guide updated (cat section and project memory section).

## Builder's calls
- Storage key shape, 14-day expiry, the Clear chat button, and trimming order.
