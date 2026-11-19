# Cursor deployment

Cursor runs the Cursor CLI (`agent -p --output-format stream-json`). The person signs in with a **Cursor API key**
(Credentials > Cursor, created at https://cursor.com/dashboard/api). It is stored encrypted like a Kiro key.

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

## How approvals work

Print mode has no per-call approval. A **trusted** session runs with `--force`. An untrusted one runs with `--trust` only:
file edits run, shell commands that are not allow-listed are rejected and shown as blocked. The project `.cursor/cli.json`
`Read(...)`/`Write(...)` deny rules are **not enforced** by the CLI (verified), so they are not relied on.

## Known limits

- The API key is in the CLI's environment, so a trusted agent's shell could read it. Use a key you can revoke, and prefer an untrusted session.
- MCP integrations are not passed to Cursor in the cloud runner (their sign-in headers would be readable by the agent).
- No pull-request tool in the runner yet (the Codex `portal_pr` tool is Codex-specific); changed repositories are still reported.
- Usage is tokens only (no dollar cost).
