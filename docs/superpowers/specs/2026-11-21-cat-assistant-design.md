# Cat assistant: answers in the cat's chat panel (phase B2, answers only)

Date: 2026-11-21. Status: draft for approval. Builds on `2026-11-21-cat-companion-design.md` (phase A and the shortcuts panel B1 are built).

## Intent

The cat's chat panel today only matches typed words to pages. People want to ask it a question in plain words ("why did my last session fail?",
"how do I turn on Auto-fix?", "what needs me?") and get an answer. Success: a short, correct, grounded answer in a few seconds, with buttons
to jump to the right page, at no cost to the portal and with no way for the chat to change anything.

## Goals

- **Ask and answer.** The panel input sends the question to a new endpoint; the reply appears in the panel as an assistant message. Typed text
  that is clearly a page or action name ("inbox") still navigates immediately, with no model call (the existing matcher decides first).
- **Grounded.** The model gets only: (1) the portal user guide, as retrieved passages for the question; (2) the open project's knowledge, through
  the existing `retrieve(project, question, limit)`; (3) a small live summary of the project: counts of running, failed and blocked sessions,
  the Inbox count, and the latest status of each monitored pipeline. It is told to answer only from these and to say "I don't know" otherwise.
- **Pay with the person's own sign-in.** The call uses `callTextModel` with the person's own credential (their default Claude Code, else Kiro,
  else Cursor, or the ChatGPT account), as other features do. Nothing is billed to the portal. A person with no sign-in sees "Connect a sign-in
  in Agent sign-ins to chat with me" with a link; the shortcut chips keep working.
- **Read-only.** The assistant cannot start, stop, retry or change anything. Its replies may carry suggested links (buttons that navigate to a
  portal page or open the New session dialog), which the person clicks.
- **Safe and bounded.** At most 8 questions per person per minute and 100 per day (counted per person, in memory plus a daily counter in the
  existing settings store, see "Builder's calls"); question up to 1,000 characters; prompt capped (passages and summary trimmed) and
  `textPromptLimit` respected; reply capped at 700 tokens.
- **Private.** No chat history is stored on the server. The panel keeps the conversation in memory only; closing the tab clears it. The last
  4 exchanges are sent along as context. The question and reply are not logged; only a counter and an error code are.

## Non-goals

- No actions (start, retry, approve, edit): that is a later option ("answers plus actions") on top of this.
- No sessions or workflows are created for a chat; nothing appears in the session list.
- No streaming in this version (the reply appears whole, with a typing indicator).
- No answers about other projects, other people's sessions, secrets, tokens or the Vault; no web search; no file access.
- No new dependency; no change to how sessions run.

## Anti-goals

- A confident wrong answer: an answer with no basis in the supplied material is a failure. The assistant says it does not know and offers links.
- Leaking: the live summary must never include prompts, session transcripts, file names from the Vault, tokens, or anything the person could not already see
  on the page they are on. Project data is only sent for a project the person is a member of (checked with `requireMember`).
- Instructions hidden in knowledge documents or session titles steering the model: all retrieved text is marked as untrusted reference material in the prompt,
  the model has no tools, and the worst a bad passage can do is a wrong or misleading answer (which is why links are checked, see below).
- Cost surprises: none for the portal, but a runaway loop in the panel must not burn the person's own quota (rate limits above; one request at a time).

## Constraints

- Server: a route `POST /api/assistant/chat` registered like the other routes (`requireAuth`, `requireMember` when a project is given), body
  `{ question, projectId?, history? }`, answer `{ reply, links, via }` or `{ error, code }` with codes `no_sign_in`, `rate_limited`, `too_long`, `failed`.
- Links: the model may only suggest links from a fixed list the server builds (Inbox, Sessions, Workflows, Auto-fix, Pipelines, Knowledge, Usage, Vault,
  Setup, New session) for the current project; any other target is dropped. The panel renders them as the same buttons as the shortcut chips.
- Web: `CatChatPanel.jsx` calls the endpoint through the existing API helper; shows a typing indicator, the reply, link buttons, and clear error
  messages; keeps focus behaviour and the phone sheet unchanged. Theme tokens only.
- Tests: node tests with `setCallTextModelOverride` (no real model call): prompt building (what goes in, what never does), link filtering,
  rate limiting, no-sign-in, untrusted-text marking, knowledge failure fallback; route tests (auth, membership, validation); smoke tests with the route mocked.
- Works on Lambda: one request, one response, finishing inside the gateway timeout (model call timeout 25 s, then `failed`).

## Approaches

1. **Answers only, one request/one reply (chosen by the user).** Smallest, safe, no actions, personal sign-in.
2. Answers plus confirmed actions: more useful, needs a confirm flow and audit; a possible next step.
3. Each chat as a normal session: strongest, but slow to start and clutters the session list; wrong for quick questions.

## Builder's calls (check these)

- Reply is non-streaming (Lambda); revisit if the model call is often slow.
- User guide passages come from `docs/user-guide.md` split by heading and ranked by simple keyword overlap (no embeddings), bundled with the server build.
- Rate limits: per-minute limit in memory; daily limit as a counter row per person per UTC day in the settings store (`assistant.count.<userId>.<yyyy-mm-dd>`),
  best effort (a lost update only allows a few extra questions).
- The live summary is built from existing repositories (workflows by status, inbox count, latest pipeline runs), never from transcripts.
- Panel keeps at most 20 messages in memory; history sent is the last 4 exchanges, each trimmed to 600 characters.
- The cat's reply is shown as plain text (no HTML or Markdown rendering), with line breaks kept.

## Open (not for this build)

- Streaming replies; remembering chats; answering across projects; actions.
