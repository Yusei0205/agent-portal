# User guides with screenshots

Create › Documents › **User guide** can write a guide by using the running system: the agent opens it in the AgentCore cloud browser, does each task, and saves
screenshots with numbered red boxes on the buttons and fields the reader must use. The steps in the guide refer to those numbers.

## What a person does

1. Create › Documents › New document › type **User guide** › tick **Open the system in the cloud browser**.
2. Give the **address of the system**. The browser runs in AWS and reaches the public internet only, so a localhost, intranet, VPN-only or private address is refused.
3. Optional: **Manage test accounts** (a role, username and password each), tick the ones the guide may sign in with, and name any extra host the sign-in uses
   (`login.example.com`). Without accounts the guide covers only what opens without a sign-in.
4. Create. The result is a Word file with the pictures in it, and a ZIP (`format=zip`) with `document.md`, `document.docx` and `screenshots/`.

Needs a Kiro or Claude model (only those have the cloud browser) and `-c agentcoreBrowser=true` on the portal deploy (`PORTAL_AGENTCORE_BROWSER=1`).
The request is refused with the reason when either is missing.

## Test accounts

`server/guide-accounts.ts`, routes `GET|PUT /api/projects/:id/guide-accounts` and `POST .../import` (editors and above).

- One row per role: role, username, password, notes; at most 20 per project. Stored encrypted (`secrets.ts`, key `guide-accounts.<projectId>`). No route returns a password,
  an empty password on save keeps the stored one, and errors never repeat one. Changes are audited (`guide_accounts.update`, `guide_accounts.import`) without secrets.
- CSV import: columns `role`, `username`, `password` (and `notes`); common names are understood (`user type`, `email`, `login`, `pwd`, ...), with or without a header, commas,
  semicolons or tabs, quotes, up to 200 rows. A bad row is skipped and reported with its line and reason. Mode `add` updates a role that exists, `replace` replaces the list.
- A guide run stores only the **role names and hosts** it may use (`guide-run.<workflowId>`, and `sources.guide` of the document so a refresh or retry is the same). The accounts
  are read from the project's list when the run starts and sent to the runner in the invoke payload (`browserAccounts`, `browserHosts`), like MCP header secrets.

## The browser tools

`server/agent/runner-browser-capture.ts` (shared into both runner images; tests in `test/browser-capture.test.ts` with a fake page and `test/browser-capture-real.test.ts`
with real Chromium) and `agent-runner/src/browser-tools.ts`.

- **`capture`** `{ file: "screenshots/NN-name.png", highlights: [{ selector | text, label? }], full_page? }`. Draws a red box and a number (1, 2, 3 in the order given) on
  each element, takes the PNG, removes the boxes, saves the file under `screenshots/` in the run folder (a `.png` inside `screenshots/` only) and returns where it is and what
  each number marks, plus the picture. Every highlight must be on the page or nothing is saved, so a number never points at a missing box; one outside the visible area is reported.
  The first highlighted element is scrolled into view. The file comes back to the portal with the run's other files (PNG is an allowed type).
- **`sign_in`** `{ role?, username_selector?, password_selector?, submit_selector? }`. Only offered when the run has accounts. Finds the sign-in form (or a two-step form),
  types the account of that role and submits. The model never sees a username or password: they are in the runner, and any error text has them removed (Playwright's call
  log repeats what was typed). It refuses unless the current page's host is the system's host (or a subdomain, or a host the person listed), so a page reached through
  an untrusted link cannot ask for credentials.
- Kiro: the tools run in a child process of kiro-cli (`kiro-runner/src/browser-mcp.ts`), which receives the run folder and the accounts in its environment. The Claude runner
  passes them in memory. As with any value in a run's environment, a shell command the agent runs could read the Kiro child's environment: use test accounts only.

## Word file

`server/markdown-docx.ts` turns the agent's Markdown into the Word file (`buildDocx` in `docgen.ts`): headings, paragraphs, bullet and numbered lists (each numbered list starts
at 1), tables, code, quotes, bold/italic/code/links, and images. An image is read only from the document's own folder (no `..`, no links out, PNG or JPEG by content, at most
15 MB, 200 per file) and scaled to the page width; one that cannot be used becomes a visible "[Image not included: ...]" line and a warning on the version instead of failing the
file. Reviews exported as Word use the same converter.

## Limits

- At most 40 screenshots a guide (asked of the agent in the prompt), 50 files and 10 MB each, 40 MB in all come back from a run (`RUNNER_FILE_LIMITS`).
- A run is one shot: it cannot stop to ask for a verification code, so a system that needs one-time codes cannot be signed in to.
- The agent is told not to press anything that deletes, pays or sends. That is guidance, not enforcement: use test accounts with test data.
