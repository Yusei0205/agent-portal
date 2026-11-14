# GitHub Actions: CI and deploys

Every push to `main_v3` is tested and, when it passes, deployed to AWS. Nobody has to run `cdk deploy` by hand.

| Workflow | Starts on | Does |
|---|---|---|
| `ci.yml` | every pull request and push to `main_v3` | type check, backend tests, build, dependency advisories; repository contract tests on DynamoDB Local (about 4 minutes) |
| `deploy-agentcore.yml` | a push that changes the Claude/Kiro runner images | runner tests and builds, then `infra/scripts/deploy-harness.mjs`: arm64 images built in CodeBuild, AgentCore runtimes updated |
| `deploy-portal.yml` | a push that changes the portal, the Codex runner or the infrastructure | builds the web files, then deploys the Codex runner (when its image changed) and `AgentPortalCloud` |

Both deploy workflows wait for CI on the same commit and deploy only when it passed. They run in the GitHub environment `aws-prod`
(required reviewers there make every deploy wait for an approval) and sign in to AWS with OIDC, no stored keys.

## Order and scope

- **Runners before the portal.** `scripts/deploy-scope.mjs` compares the push with the commit before it. When a file that goes into the Claude/Kiro runner images
  changed, the portal deploy waits for the `deploy-agentcore.yml` run of the same commit, so the portal never goes live before the runners it depends on.
- **The list of runner files is in one place:** `infra/scripts/harness-sources.mjs`. `deploy-harness.mjs` stages exactly those files, and `RUNNER_PATHS` in
  `scripts/deploy-scope.mjs` starts a runner deploy when one of them changes. `deploy-agentcore.yml` must list the same paths (GitHub needs them written out);
  `test/deploy-scope.test.ts` fails when the two differ. A new module for the runner images is added to `harness-sources.mjs` only.
- **The Codex runner is rebuilt only when it changed.** Its image is the esbuild bundle of `codex-runner/src/index.ts` and `mcp-proxy.ts`, so the files it is made of are read
  from that bundle (plus its Dockerfile, the lockfile and its stack). A push that changes none of them keeps the running Codex runner and links it to the portal.
- **The long-job runtime stays.** The portal deploy passes `-c jobRuntime=true -c jobRuntimeAgentRuns=true` (repository variables `JOB_RUNTIME` and `JOB_RUNTIME_AGENT_RUNS`
  turn them off on purpose). A `cdk deploy` without them deletes the job runtime, and agent runs and long jobs fall back to the Lambda's 15-minute limit.

## Why it is fast

- **No emulation.** The portal deploy runs on `ubuntu-24.04-arm`. The portal function, the job runtime and the Codex runner are all arm64 images, so every image is built natively.
  On an x86 runner the arm64 images were built under QEMU, several times slower.
- **CI and the build overlap.** The deploy job installs and builds the web files while CI runs, then waits for CI right before it signs in to AWS.
- **Nothing is built twice.** Pushes no longer run a second type check and build in the portal workflow (CI already does); pull requests still do.

## When something goes wrong

- *"No CI run started on `<sha>`"*: CI did not start for that commit. Run it by hand (Actions › CI › Run workflow), then re-run the deploy's failed jobs.
- *The deploy waited for the runner deploy and failed*: the runner deploy of that commit failed. Fix it and re-run its failed jobs, then re-run the portal deploy's.
- *`cdk deploy` says another deploy is running* (`Cannot delete ChangeSet`, `UPDATE_IN_PROGRESS`): a deploy from another machine or run is on the stack. Wait for it,
  then re-run. Do not deploy by hand while a workflow is deploying the same stack; a manual deploy needs the same `-c` values as the workflow, including the two job-runtime flags.
- The portal function is an **arm64** image (`infra/lib/portal-stack.ts`). A manual deploy from an x86 machine builds it under emulation and is slow.
