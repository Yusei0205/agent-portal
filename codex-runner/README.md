# Codex AgentCore runner

Build from the repository root:

```sh
node codex-runner/build.mjs
docker build --platform linux/arm64 -f codex-runner/Dockerfile -t agent-portal-codex-runner:local .
```

The service listens on 8080. `/ping` reports Healthy or HealthyBusy. `/invocations` streams Codex
turns and model catalogs, repository preparation, inspection, finalization, workspace flush,
approval answers, and cancellation. One workflow binds to each worker, with one active job.
AgentCore authenticates invocations and isolates sessions. Do not expose the container publicly.

The Lambda portal owns OAuth and renewable credentials. The runner receives a short-lived token,
configures the Responses provider, routes native approvals through portal policy, and saves state
before confirming success. MCP connections use the shared stdio proxy. Conversation snapshots
exclude authentication, configuration, logs, and MCP secrets.

See [deployment and verification](../docs/codex-deployment.md) for registration and CDK settings.
Tests use protocol fixtures and do not spend model quota.
