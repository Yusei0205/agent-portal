# Codex deployment

The portal now has a dedicated Codex AgentCore runner behind the existing Lambda portal. Local
builds and fixture tests do not establish live provider authorization or AWS runtime compatibility.

| Deployment | Authentication | Persistence |
| --- | --- | --- |
| Windows or persistent Docker | Per-user native CLI device sign-in | Persist DATA_DIR; Codex handles refresh |
| Lambda + AgentCore (default) | Registered Sign in with ChatGPT, authorization code + PKCE | Encrypted connections and callback state in DynamoDB; workspace/thread snapshots in S3 |
| Lambda + AgentCore (experimental device mode) | Native Codex device-code sign-in | Encrypted per-user credentials and pending attempts in DynamoDB; workspace/thread snapshots in S3 |

## GitHub pull requests from Codex

Attach the repository through the project's repository settings and select its Git connection.
Cloud Codex uses the `portal_pr.create_pull_request` tool to queue publication through that
connection; `gh auth status` in the agent shell does not describe the portal's GitHub access.
The tool requires the attached repository name and the intended base branch (for example,
`main_v3`). The portal validates that base against the remote, waits for the completed turn and
saved snapshots, then pushes a new branch and opens the PR. The session's PR card shows the
result, including any real repository permission error. No GitHub token is installed in the
Codex shell. Tool approvals and project guardrails still apply.

## Experimental device-code sign-in

OpenAI's [app-server authentication documentation](https://learn.chatgpt.com/docs/app-server#auth-endpoints)
explicitly excludes hosted services from native authentication. This mode is experimental and is
not a supported substitute for approved hosted OAuth. It is disabled by default. Set the GitHub
Actions variable `CODEX_AUTH_MODE=device` or pass CDK context `-c codexAuthMode=device` to opt in;
the deployed Lambda receives `PORTAL_CODEX_AUTH_MODE=device`. Its credential card is labeled experimental.

No registered OAuth client, client secret, or callback URL is needed. Deploy the runner, then open
Connect > Agent sign-ins > Codex > Sign in with ChatGPT. Open the displayed OpenAI URL and enter the
one-time code. Enable device-code login in ChatGPT Settings > Security or your workspace permissions
if it is disabled. The portal polls automatically; refreshing the page resumes the pending attempt.

The auth-only runner session owns the native login process. DynamoDB stores the encrypted pending
session and credentials per portal user; no Lambda process must remain alive. Login expires after
ten minutes. Cancellation and sign-out invalidate the stored generation, so a delayed completion or
renewal cannot reconnect a signed-out user. Renewable credentials are sealed on the internal runner
stream and never returned to the browser, agent workspace, S3 conversation snapshots, or logs.

Only short-lived external ChatGPT tokens are supplied to workspace runners via the native
`chatgptAuthTokens` protocol. A separate auth-only runner renews credentials under a distributed
lease and saves rotated credentials with compare-and-swap. The bridge answers native renewal
requests during a turn; if renewal exceeds the native protocol's roughly ten-second window,
resume the session to retry. No model usage is incurred by starting device sign-in.

GitHub Actions deploys the Codex runner before the portal. `CODEX_AUTH_MODE` defaults to `oauth`;
device mode does not require `CODEX_OAUTH_CLIENT_ID`. The portal requires its existing S3 storage,
DynamoDB users table, and stable encryption key. Keep the deployment role's existing CDK bootstrap
permissions; the runner ARN comes from CDK's output file without adding direct DescribeStacks access.

## Hosted OAuth authentication (default)

Use `PORTAL_CODEX_AUTH_MODE=oauth` (or the GitHub Actions variable `CODEX_AUTH_MODE=oauth`) with a
registered hosted client.

Obtain a registered OpenAI client and register the exact callback:
`https://<portal-host>/api/codex/oauth/callback`. The registration must permit ChatGPT plan inference
scopes `resource.invoke chatgpt.tokens.use.direct`, plus `openid profile email offline_access`.
Identity-only sign-in does not grant inference. The portal rejects that grant. Use a static client
for the hosted portal; `dynamic_agent_client` and CLI-managed login are not used for cloud sign-in.
If registration is unavailable for your use case, cloud plan authentication remains blocked.

The portal validates PKCE, state, nonce, identity signature, issuer, audience, account identity, and
scopes. Refresh credentials stay encrypted in the portal users table using the portal's stable
secret-key/KMS setup. Refresh uses an owner-bound distributed lease and conditional writes.
Sign-out removes credential material and retains a generation counter to reject stale callbacks
and refreshes. Callback state is encrypted, owner-bound, expires after ten minutes, and is consumed
atomically. Configure DynamoDB TTL on `expiresAtEpoch` for automatic expired-attempt cleanup if not
already enabled; expiration is also checked when consuming state.

## Build

From the repository root:

```sh
npm ci
node codex-runner/build.mjs
docker build --platform linux/arm64 -f codex-runner/Dockerfile -t agent-portal-codex-runner:local .
docker run --rm --platform linux/arm64 agent-portal-codex-runner:local codex --version
```

The non-root Node 22 image pins CLI 0.166.0 and exposes AgentCore `/ping` and `/invocations` on 8080.
Model/workspace sessions receive only short-lived tokens. Device accounts use native external
ChatGPT authentication; registered OAuth accounts use the documented custom Responses provider.
Approval answers and cancellation use separate control invocations. The runtime role has image-pull
and logging access; S3 access uses scoped presigned URLs.

Repository workspaces use the existing cross-engine snapshot contract. Separate Codex snapshots
include only `sessions/`, `archived_sessions/`, and `state_<n>.sqlite` plus WAL. They exclude
`auth.json`, configuration, logs, and MCP connection secrets. Successful cloud completion requires
confirmation of saved conversation state; missing resume state fails explicitly.

## Deploy with the existing CDK app

From `infra/`, using your normal CDK CLI and AWS profile:

```sh
npm ci
npm run build
cdk deploy AgentPortalCodexRunner -c codexRunner=1 --profile <profile>
```

Copy the `CodexRuntimeArn` output. Redeploy the existing portal stack with its existing context
values, adding:

```sh
cdk deploy AgentPortalCloud --profile <profile> \
  -c budgetEmail=<existing-budget-email> \
  -c codexRuntimeArn=<CodexRuntimeArn> \
  -c codexAuthMode=oauth \
  -c codexOAuthClientId=<registered-client-id> \
  -c codexOAuthRedirectUri=https://<portal-host>/api/codex/oauth/callback
```

Preserve existing Kiro/Claude runtime ARNs, storage, public URL, and other deployment context.
For optional hosted OAuth, also pass `-c codexAuthMode=oauth`,
`-c codexOAuthClientId=<registered-client-id>`, and
`-c codexOAuthRedirectUri=https://<portal-host>/api/codex/oauth/callback`.
For a confidential registration using `client_secret_basic`, also pass
`-c codexOAuthSecretArn=<SecretsManager-secret-ARN>`. The secret value is the client secret as plain
text. Do not place client secrets in CDK context, images, or frontend settings.

Equivalent portal environment settings:

```dotenv
PORTAL_CODEX_AGENTCORE_RUNTIME_ARN=<runtime-ARN>
PORTAL_CODEX_AUTH_MODE=oauth
PORTAL_CODEX_OAUTH_CLIENT_ID=<registered-client-id>
PORTAL_CODEX_OAUTH_REDIRECT_URI=https://<portal-host>/api/codex/oauth/callback
# Confidential registrations only:
# PORTAL_CODEX_OAUTH_CLIENT_AUTH=client_secret_basic
# PORTAL_CODEX_OAUTH_CLIENT_SECRET_ARN=<secret-ARN>
```

The portal CDK stack sets confidential auth when a secret ARN is supplied and grants invoke/stop
permissions for the specified runtime and read access to that secret. Public registrations default
to token endpoint auth `none`. Use the existing DynamoDB users table and S3 backend. Native host
login import is disabled in cloud.

## Verification

```sh
npm run typecheck
node node_modules/typescript/bin/tsc -p codex-runner/tsconfig.json --noEmit
node --import tsx --test test/codex.test.ts test/codex-device.test.ts test/codex-oauth.test.ts test/codex-runner.test.ts
npm run build
```

Before rollout, verify real authorization and inference with two users; refresh after expiration;
approvals and cancellation; cold-worker thread restoration; repository preparation and engine
switching; disconnect during refresh; and output persistence. Model catalogs do not prove account
entitlement. Fixtures do not verify provider registration, AgentCore sandbox compatibility, or live
inference access.

## Local diagnostics

The original generic error combined discovery, startup, account, and storage failures. Native
Windows desktop and npm installations are now discovered without a command shell, and distinct
safe errors explain failures. Override discovery with `PORTAL_CODEX_BIN`. Run
`node scripts/codex-runtime-smoke.mjs` to initialize the real app-server with a fresh signed-out
home. This does not inspect personal credentials or make model calls.

Official references:

- [Hosted-service authentication boundary](https://learn.chatgpt.com/docs/app-server#auth-endpoints)
- [Registered website sign-in](https://developers.openai.com/siwc/website)
- [Client registration](https://developers.openai.com/siwc/request-client-id)
- [Codex ChatGPT-plan provider](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)
- [Renewal and revocation](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)

## Portal AI and Agent setup

Select Settings > Portal AI provider > OpenAI Codex to use each requesting user's ChatGPT connection
for portal AI generation. This setting never shares the administrator's credentials. The connection
check lists the account's model catalog; a successful inference request verifies model access.
Generation uses short isolated sessions, with tool approvals denied. Image attachments are currently
rejected explicitly rather than discarded.

Agent setup > Codex provides AGENTS.md, selected reasoning preferences in config.toml, native
agents/*.toml definitions and skills. Add agent pack installs the same seven specialist roles and
shared skills offered for Kiro/Claude, using Codex formats. Choose a lead agent in the session dialog.
The portal transfers validated setup to cloud workers and applies it before starting/resuming a
thread. Zip import/export, per-user customizations and team defaults use the existing configuration
storage. Authentication, providers, hooks, MCP transport and sandbox permissions are not editable
through the Codex setup files. Skill document files are supported; credential/state files are excluded.

Codex agent and skill formats follow the [official configuration documentation](https://learn.chatgpt.com/docs/agent-configuration/subagents).
