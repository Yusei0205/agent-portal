# Container Provider Checklist

Manual verification steps for every provider and integration the portal supports when running
in Docker. Work through each section in order; each item lists **what to do**, **what you
should see**, and **the common failure with its fix**.

> **Tip:** run the pre-flight check before testing real providers:
> ```
> docker compose run --rm portal node dist/preflight.mjs
> ```

---

## 1. Anthropic API key

**What to do**

1. Open **Settings › Model provider**, choose **Anthropic API** and paste your key.
2. Click **Test connection**.
3. Start any agent run on a project (e.g. "Design and build the refund approval flow…").

**What you should see**

- Test connection returns a green ✓ and a cost estimate.
- The run starts, asks questions, writes files, and finishes with status `completed`.

**Common failure and fix**

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Add your Anthropic API key in Settings first` | Key not saved (value was empty) | Re-paste the key and save |
| `401 Unauthorized` from Anthropic | Wrong or revoked key | Issue a new key at console.anthropic.com |
| Run never starts, status stays `queued` | Budget cap reached | **Settings › Budget** — raise or clear the monthly cap |

---

## 2. Amazon Bedrock — access keys

**What to do**

1. In **Settings › Model provider**, choose **Amazon Bedrock**.
2. Under **How to sign in**, choose **Access keys** and enter your `AWS_ACCESS_KEY_ID`,
   `AWS_SECRET_ACCESS_KEY`, and region (e.g. `us-east-1`).
3. Click **Test connection**.

**What you should see**

- Test returns your AWS account ID and the IAM ARN.

**Common failure and fix**

| Symptom | Cause | Fix |
|---------|-------|-----|
| `AWS did not accept these credentials` | Wrong region or key pair | Check the key exists in the IAM console and the region matches where you enabled Bedrock |
| `InvalidSignatureException` | Clock skew | The container clock must be within 5 minutes of UTC; use `--cap-add SYS_TIME` or NTP |
| `AccessDeniedException` — model not found | Model not enabled in Bedrock console | Go to Bedrock › Model access and enable the Claude model family |

**Container risk:** the AWS keys are stored encrypted in the portal DB.
They are passed to agent processes only through `agentEnv()`, which strips them from the
environment before anything else runs (`STRIP` regex in `settings.ts`).
No risk of them leaking into the portal's own process environment.

---

## 3. Amazon Bedrock — named profile via compose.aws.yml

**What to do**

1. Configure an AWS profile on the host machine in `~/.aws/config` (e.g. `[profile refund-dev]`).
2. Start the stack with both compose files:
   ```
   docker compose -f compose.yml -f compose.aws.yml up -d
   ```
3. In **Settings › Model provider → Amazon Bedrock → How to sign in**, choose
   **Named AWS profile** and enter the profile name (e.g. `refund-dev`).
4. Click **Test connection**.

**What you should see**

- Test returns the IAM identity for that profile.

**Common failure and fix**

| Symptom | Cause | Fix |
|---------|-------|-----|
| `NoCredentialsError` or `Profile not found` | `~/.aws` not mounted, or wrong profile name | Ensure `compose.aws.yml` is included in the `docker compose` command; check the profile name matches `~/.aws/config` exactly |
| `HOME` pointing to `/data/home` breaks profile lookup | `HOME=/data/home` in the container; AWS CLI reads `$HOME/.aws` by default | This is handled: `agentEnv()` passes `AWS_CONFIG_FILE` and `AWS_SHARED_CREDENTIALS_FILE` when they exist in `process.env`, and `compose.aws.yml` mounts the host's `~/.aws` to `/data/home/.aws` so the container's `HOME` path works correctly |
| SSO-style profile with cached token fails | The token cache at `~/.aws/sso/cache` is not writable | Use the writable variant described in `compose.aws.yml` comments (change `read_only: true` to `read_only: false`) |

**Container risk (PATH):** the container's `PATH` prepends `/data/tools/bin` and
`/data/home/.local/bin` (set in the Dockerfile and in `agentEnv()`). If `aws` was installed
to a non-standard location it would not be found. The `aws` CLI is installed system-wide
in the Dockerfile so this is safe in the official image.

---

## 4. Amazon Bedrock — SSO device flow

**What to do**

1. In **Settings › Model provider → Amazon Bedrock → How to sign in**, choose
   **AWS IAM Identity Center (SSO)**, fill in the SSO start URL, SSO region, account ID
   and role name.
2. Click **Start SSO sign-in**. Open the verification URL shown and enter the user code.
3. After approving in the browser, click **Check status** — it should say "Authorised".
4. Click **Test connection**.

**What you should see**

- Test returns the IAM identity of the SSO role.

**Common failure and fix**

| Symptom | Cause | Fix |
|---------|-------|-----|
| `AuthorizationPendingException` never resolves | Browser approval not completed | Open the URL from the UI and enter the user code before it expires (15 min default) |
| `ExpiredTokenException` on the next start | The SSO token stored in the DB has expired | Re-run the device flow from step 2 |
| Refresh token fails after a few hours | The portal stores the access + refresh token encrypted in the portal DB (not in `~/.aws/sso/cache`). The refresh is automatic, but if the IAM Identity Center session expires the whole token is unusable | Re-run the device flow |
| SSO works but agents still fail | `agentEnv()` calls `ssoCredentials()` which returns short-term `AWS_ACCESS_KEY_ID / SECRET / SESSION_TOKEN` keys. If those keys expired between the test and the run start, the run fails | Click **Test connection** again to force a fresh credential fetch; credentials are cached in memory for up to 55 minutes by default |

**Container risk (SSO cache):** the portal does **not** write to `~/.aws/sso/cache`.
The SSO access token is stored encrypted in the portal DB on the data volume and is never
written to disk in plain text.
If you use a named AWS profile that itself needs SSO (`aws sso login`), you need a writable
`~/.aws` mount (see the `compose.aws.yml` comment about writable bind mounts).

---

## 5. CodeCommit — HTTPS (`https://git-codecommit…`)

**What to do**

1. Create an AWS connection on **Settings › AWS accounts** (or use the project's own AWS
   account) with the correct IAM credentials that have CodeCommit access.
2. On the **Repositories** page of a project, add a repository with the HTTPS URL
   `https://git-codecommit.<region>.amazonaws.com/v1/repos/<name>` and choose the AWS
   connection.
3. Wait for status **Ready**.
4. Click **Test connection** on the AWS accounts page to confirm the identity.

**What you should see**

- Repository status changes from `cloning` to `ready`.
- Branches list shows at least `main`.

**Common failure and fix**

| Symptom | Cause | Fix |
|---------|-------|-----|
| `git clone failed: The requested URL returned error: 403` | IAM policy does not include `codecommit:GitPull` | Add `codecommit:GitPull` and `codecommit:GetBranch` to the IAM policy |
| `git credential-helper` error | `aws` CLI not found at runtime | The official image ships `aws` under `/usr/local/bin`; PATH is set correctly; run `docker exec <container> which aws` to verify |
| Clone works, push fails | `codecommit:GitPush` missing in IAM | Add it |

**Container risk:** `repoGitEnv()` in `repos.ts` uses `GIT_CONFIG_KEY_*` / `GIT_CONFIG_VALUE_*`
env vars to set `credential.helper = !aws codecommit credential-helper $@` for the git subprocess.
This is safe as long as `aws` is on PATH, which the Dockerfile ensures.

---

## 6. CodeCommit — `codecommit::` (git-remote-codecommit)

**What to do**

1. Use the URL form `codecommit::<region>://<repo>` when adding the repository.
2. The AWS connection must supply credentials (ambient, profile, or keys).
3. Wait for status **Ready**.

**What you should see**

- Identical to the HTTPS path.

**Common failure and fix**

| Symptom | Cause | Fix |
|---------|-------|-----|
| `git clone failed: unable to find remote helper 'codecommit'` | `git-remote-codecommit` is not installed | Run `pip3 install git-remote-codecommit` or use the Dockerfile (it installs it) |
| `ModuleNotFoundError: No module named 'botocore'` | Python environment missing `awscli` dependencies | Run `pip3 install awscli git-remote-codecommit` |

**Container risk:** `git-remote-codecommit` is installed system-wide by the Dockerfile's
`pip3 install` step. `HOME=/data/home` is set, so `~/.gitconfig` resolves to
`/data/home/.gitconfig` — this is correct. The AWS credential look-up happens via the
environment variables that `agentEnv()` places in the agent's process.

---

## 7. GitHub PR review and Post to GitHub

**What to do**

1. In **Settings › Secrets**, add your GitHub personal access token under
   `github.token` (needs `repo` scope).
2. On the **Repositories** page of a project, connect a GitHub repository using a
   GitHub connection (personal access token).
3. Open **Code review**, choose the feature branch and **main**, and click **Review**.
4. After review finishes, click **Post to GitHub** and confirm it posts comments to the PR.

**What you should see**

- Review finishes with findings.
- The GitHub PR shows inline review comments from the portal.

**Common failure and fix**

| Symptom | Cause | Fix |
|---------|-------|-----|
| `GitHub said 401` | Token expired or wrong permissions | Regenerate the token with `repo` scope and update Settings |
| `GitHub said 422 Unprocessable Entity` | PR comment positions are off | The diff from the portal may not match GitHub's file positions; this happens when the repo has very large non-text files. Dismiss findings and review manually |
| Post to GitHub button missing | Repository is not GitHub provider | Only repositories connected via a GitHub connection show the button |

---

## 8. Kiro engine — install and login

**What to do**

1. Open **Settings › Tools**. The Kiro CLI row should show **Not installed**.
2. Click **Install** and watch the log stream. It downloads the installer from
   `https://cli.kiro.dev/install` and runs it with `HOME=/data/home`.
3. After install, the row shows **Installed**. Click the copy icon next to the login hint:
   ```
   docker compose exec portal kiro-cli login --use-device-flow
   ```
4. Paste the command into your terminal, open the verification URL and approve.
5. Confirm the Kiro CLI row shows **Logged in** (the next test connection will verify it).
6. In **Settings › Model provider**, choose **Kiro** and click **Test connection**.

**What you should see**

- Test connection returns a green ✓.
- Agent runs start and stream events from the Kiro engine.

**Common failure and fix**

| Symptom | Cause | Fix |
|---------|-------|-----|
| Install fails with `bash: not found` | The container is not Debian-based | The official image is `node:22-bookworm-slim` which includes bash; custom base images must include it |
| `kiro-cli: command not found` after install | Installer put the binary somewhere not on `PATH` | Check `/data/home/.local/bin` and `/data/tools/bin`; the portal's `PATH` includes both |
| Login hangs or `expired token` | Device flow timed out | Re-run `docker compose exec portal kiro-cli login --use-device-flow` |
| API key approach | Set a Kiro API key in **Settings › Secrets** under `kiro.api_key`; `agentEnv()` will pass it as `KIRO_API_KEY` to agent processes, bypassing the interactive login |

**Container risk (HOME):** the Kiro installer is run with `HOME=/data/home` (hard-coded
in `installKiro()` in `tool-packs.ts`). The Kiro binary is placed in
`/data/home/.local/bin`, which is on PATH. The data volume must be the same across container
restarts for the sign-in to persist — do not recreate the volume.

---

## 9. Final end-to-end Bedrock run

**What to do**

1. Verify Bedrock is configured and **Test connection** is green.
2. Connect a real git repository with at least a `main` branch.
3. On **Agent runs**, start a new run:
   - Prompt: `Design and build the refund approval flow`
   - Repository: the connected repo, branch `main`
   - Approval mode: **Ask before changes**
4. When the agent asks clarifying questions, answer them.
5. When a **Write** approval appears, click **Allow**.
6. After the run finishes, click **Push changes** and push to a new branch
   (e.g. `agent/refund-approval`).

**What you should see**

- The run tree shows the main agent and two or more subagents.
- Cost is non-zero (token usage is real).
- The branch appears in the remote repository.

**Common failure and fix**

| Symptom | Cause | Fix |
|---------|-------|-----|
| Run completes instantly with no events | Still in demo mode | Check **Settings › Model provider** — switch to Bedrock and test |
| `400 Choose the Claude or the Kiro engine` | The project has a custom provider set that conflicts | Open **Project and team › AWS / Provider** and set it to **Inherit from Settings** |
| `403 Only admins can give a project an AWS SSO account` | You are not an admin | Use the admin account, or ask an admin to connect the project |
| Git `dubious ownership` error during clone | The container's git version is ≥ 2.35.2 and the volume was created by a different uid | Run `git config --global --add safe.directory '*'` inside the container once: `docker compose exec portal git config --global --add safe.directory '*'`. This writes to `/data/home/.gitconfig` which persists on the volume |
| Run failed: `Blocked by Agent Portal: do not run git push` | Agent tried to push directly instead of via the portal | This is by design; the portal intercepts git pushes. If the branch never appears in the remote, check the **Push changes** button in the run UI |

---

## Container-specific risks identified by code review

The following items were found by reading the source code. None are clear bugs (the code
handles them correctly for the common case), but each is worth verifying in a container
deployment.

| Risk | Code location | Severity | Notes |
|------|--------------|----------|-------|
| `HOME=/data/home` must persist on the data volume | `Dockerfile` `ENV HOME=…`, `agentEnv()` in `settings.ts` | **Low** | Works correctly as long as the named volume is not deleted. On a fresh volume the `ENTRYPOINT` re-creates the directories before the server starts. |
| `git safe.directory` when volume created by root | `server/git.ts` `git()` | **Medium** | If the `/data` volume was initialized by root (e.g. the first start ran as root), git will refuse to operate in those directories for the `portal` user. Fix: add `safe.directory = *` to `/data/home/.gitconfig` or run the container as root. |
| AWS credential-helper PATH | `server/repos.ts` `repoGitEnv()`, `server/git-connections.ts` `connectionGitEnv()` | **Low** | `credential.helper = !aws codecommit credential-helper $@` uses the bare `aws` command. It is resolved against `PATH` in the git subprocess env, which is built by `agentEnv()` and includes `/data/tools/bin:/data/home/.local/bin:…/usr/bin`. The Dockerfile installs `aws` at `/usr/local/bin/aws`, so it will be found. |
| SSO token cache not at `~/.aws/sso/cache` | `server/sso.ts` | **Low** | The portal does NOT use the standard AWS CLI SSO cache. It stores the access token encrypted in the portal DB. This means `aws sso login` on the host does not help the portal's SSO flow — the portal has its own device flow via **Settings**. This is intentional and documented. |
| CRLF in `.env` on Windows | `compose.yml` `env_file` | **Low** | If `.env` was edited on Windows it may have `\r\n` line endings. The portal reads env vars via Node's `--env-file-if-exists`, which handles this. Docker Compose also handles it. But if you inject secrets via `\r`-terminated values, encrypted storage will store the trailing `\r` as part of the secret. Fix: use `dos2unix .env` or ensure your editor saves as LF. |
| `aws` binary path inside shim scripts | `server/project-aws.ts` `AWS_SHIM` | **Low** | The AWS shim script (`data/bin/aws`) does a PATH walk to find the real `aws` binary. It skips itself by file identity. This is correct. Risk: if `aws` is installed to a non-standard location not on PATH, it will not be found. The Dockerfile installs it at `/usr/local/bin/aws`. |
| kiro-cli install path on non-x86 | `server/tool-packs.ts` `installKiro()` | **Low** | The Kiro installer is a shell script that auto-detects the architecture. On `arm64` or non-standard libc platforms the install may fail. Use an `arm64` image or pre-install kiro-cli in a custom Dockerfile. |
| `uv` SHA-256 checksums in code | `server/tool-packs.ts` `UV_SHA256` | **Medium** | The SHA-256 checksums for `uv 0.7.4` in the source code are placeholders (they do not match the real release). An admin clicking "Install uv" will see a checksum error. The correct checksums must be fetched from the GitHub releases page and updated in `tool-packs.ts` before the install feature is used in production. |

---

## Quick reference: compose commands

```bash
# Basic start
docker compose up -d

# With host AWS credentials (named profiles, SSO)
docker compose -f compose.yml -f compose.aws.yml up -d

# With the browser MCP (needed for web-browsing integrations)
docker compose --profile browser up -d

# Pre-flight check
docker compose run --rm portal node dist/preflight.mjs

# Run the smoke test
npm run test:container

# Kiro login (inside the container)
docker compose exec portal kiro-cli login --use-device-flow

# View logs
docker compose logs -f portal
```
