# Cursor deployment

Cursor runs the Cursor CLI (`agent -p --output-format stream-json`). A person signs in under Credentials > Cursor with either:

- a **Cursor API key** (created at https://cursor.com/dashboard/api; the supported route for automation), or
- a **Cursor sign-in** ("Sign in with Cursor"): the same browser login `agent login` runs, done by the portal. The person opens a Cursor
  link and approves; the portal polls `POST https://api2.cursor.sh/auth/poll {uuid, verifier}` (404 until approved, then 200 with the
  tokens; `PORTAL_CURSOR_API_URL` / `PORTAL_CURSOR_WEBSITE_URL` override the two hosts). These are the endpoints the CLI itself uses, not
  a documented API. Signing in again is one click on the credential card. Or an **advanced login token**: the same token, pasted as the
  contents of `auth.json` (or just its `accessToken`) from the person's own `agent login`. Either way only the
  access token is stored (encrypted), as `CURSOR_AUTH_TOKEN`; the refresh token is dropped. It is a 60-day session token:
  the credential card shows the days left, a run says plainly when it has expired, and the person pastes a new one. `auth.json` is
  `%APPDATA%Cursorauth.json` (Windows), `~/.cursor/auth.json` (macOS) or `~/.config/cursor/auth.json` (Linux). Experimental: check
  your Cursor terms before using a personal login on a shared server.

Both are stored encrypted like a Kiro key.

`agent login` cannot finish inside the runner (it needs an OS keyring to store its token, and ignores a restored `auth.json` on
Linux), so a login token is injected per turn as an environment variable, never restored as a file.

| Deployment | How it runs | Persistence |
| --- | --- | --- |
| Lambda + AgentCore (first target) | `cursor-runner/` image in its own AgentCore runtime; the key is sent per turn and redacted from every event | Chat store (`~/.cursor/chats`) and workspace snapshots in S3 |
| Windows or Docker | The portal spawns `agent` itself (`PORTAL_CURSOR_BIN`) | The CLI's own `~/.cursor` |

## Cloud runner

1. Deploy the runner: `cdk deploy AgentPortalCursorRunner -c cursorRunner=1 -c publicUrl=...` (CI does this when `cursor-runner/**`
   or a file in its bundle changes). The image downloads a pinned CLI tarball (`CURSOR_VERSION`, arm64 or x64).
2. Set the repository variable `CURSOR_RUNTIME_ARN` to the `CursorRuntimeArn` output. Every portal deploy passes
   `-c cursorRuntimeArn=...`; leaving it out removes `PORTAL_CURSOR_AGENTCORE_RUNTIME_ARN` from the Lambda.
3. Cloud Cursor needs the S3 storage bucket (workspace and chat snapshots) and the person's API key.

## Portal provider (Settings > Model provider > Cursor)

An admin can choose Cursor as the portal provider and set one portal Cursor API key (stored encrypted, never returned). It is used by
Cursor sessions whose owner has no key or login of their own (a personal key or login always wins), and by portal AI generation
(documents, test cases, reviews) when Cursor is the provider or a person's only sign-in. Generation sends one prompt and gets one
answer: nothing is trusted, so no shell command runs, and image attachments are not accepted. In the cloud it runs in the Cursor
runner's `cursor-text` mode.

## How approvals work

Print mode has no per-call approval. A **trusted** session runs with `--force`. An untrusted one runs with `--trust` only:
file edits run, shell commands that are not allow-listed are rejected and shown as blocked. The project `.cursor/cli.json`
`Read(...)`/`Write(...)` deny rules are **not enforced** by the CLI (verified), so they are not relied on.

## Known limits

- The API key is in the CLI's environment, so a trusted agent's shell could read it. Use a key you can revoke, and prefer an untrusted session.
- MCP integrations are not passed to Cursor in the cloud runner (their sign-in headers would be readable by the agent).
- No pull-request tool in the runner yet (the Codex `portal_pr` tool is Codex-specific); changed repositories are still reported.
- Usage is tokens only (no dollar cost).
