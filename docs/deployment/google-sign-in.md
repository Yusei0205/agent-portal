# Sign in with Google (cloud portal)

The login page shows **Continue with Google** once the portal has a Google OAuth client and a public URL.

## Who can sign in

- An **existing, enabled user** whose email matches the verified Google email (admins, invited users).
- An email or domain on the **allow-list** (`googleAllowed`). First sign-in creates a normal, non-admin user.
- Everyone else is rejected with "ask your admin for an invite".
- The first admin must still be created on the setup page. Password login stays available.

## One-time setup

1. In Google Cloud Console (any project): **APIs & Services > OAuth consent screen**: choose External (or Internal for a Workspace), fill the app name and your email. While the app is in *Testing*, add the allowed Google accounts as **test users**.
2. **Credentials > Create credentials > OAuth client ID**, type **Web application**.
   - Authorized redirect URI: `https://<portal host>/api/auth/google/callback` (current portal: `https://d1tah6dqw2fe9f.cloudfront.net/api/auth/google/callback`).
3. Put the client id and secret into the AWS secret `agent-portal/google-oauth` (Secrets Manager, ap-southeast-1) as JSON:
   ```json
   {"clientId": "xxxx.apps.googleusercontent.com", "clientSecret": "GOCSPX-xxxx"}
   ```
   The portal reads it when it needs it. No redeploy is required, but a running Lambda instance may take a few minutes to notice (or redeploy to force it).
4. Deploy with the public URL (and optionally the allow-list):
   ```
   npm run build:web
   cd infra
   npx cdk deploy AgentPortalCloud --profile agentcore -c budgetEmail=<email> -c kiroRuntimeArn=<arn> -c storageBucket=<bucket> \
     -c publicUrl=https://d1tah6dqw2fe9f.cloudfront.net -c googleAllowed="you@gmail.com,@yourcompany.com"
   ```
   Keep passing the same `-c` values on every deploy, otherwise the setting is removed.

## How it works

`GET /api/auth/google/start` sets a short-lived HttpOnly cookie holding a random `state` and `nonce` and redirects to Google. Google returns to `/api/auth/google/callback`; the portal checks `state`, exchanges the code for an ID token over TLS, checks issuer, audience, expiry, nonce and `email_verified`, applies the rules above and starts the normal portal session. The state lives in a cookie (not server memory) so any Lambda instance can finish the flow. Code: `server/google-auth.ts`.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| No Google button | `publicUrl` not passed on deploy, or the secret still has empty values. `GET /api/auth/state` shows `googleEnabled`. |
| Google error `redirect_uri_mismatch` | The redirect URI in Google Cloud must match exactly `<publicUrl>/api/auth/google/callback`. |
| Google error `access_blocked` / "not verified" | Consent screen is in Testing: add the account as a test user. |
| "is not allowed to use this portal" | Email not an existing user and not on `googleAllowed`. Invite the user or extend the allow-list. |
| "Sign-in session expired" | The 10-minute state cookie expired or cookies are blocked. Try again. |
| "Your Google email address is not verified" | Use a Google account with a verified email. |

## Google Workspace for agents (Drive, Docs, Sheets, Slides)

Integrations → Connected services → **Google Workspace** lets each person connect their own Google account. Sessions that person starts then get a `google` tool set: `search_drive`, `get_file_info`, `read_doc`, `list_sheet_tabs`, `read_sheet`, `read_slides` (always), and `create_doc`, `append_to_doc`, `update_sheet_cells`, `append_sheet_rows` (only when the person ticks **Let agents edit my files**).

One-time setup in Google Cloud (same project as the sign-in client):

1. **Enable the APIs**: Google Drive API, Google Docs API, Google Sheets API, Google Slides API.
2. **OAuth consent screen → Data access**: add the scopes `.../auth/drive`, `.../auth/documents`, `.../auth/spreadsheets`, `.../auth/presentations`. If the app is in Testing, add each person under Test users; refresh tokens of a Testing app expire after 7 days, so publish it (Internal for a Workspace domain) for lasting use.
3. No new redirect URI: the connection returns to `<publicUrl>/api/auth/google/callback`, and the portal tells it apart from a sign-in by the `ws.` prefix of the state.

How it stays safe: the refresh token is stored encrypted (`google-workspace:<user id>`) and never leaves the portal. The session only holds a signed token that names the person and expires after 8 hours; the portal calls Google as that person. Disconnecting revokes the token at Google. Code: `server/google-workspace.ts`, tests: `test/google-workspace.test.ts`.

| Symptom | Cause |
|---|---|
| "Connect Google" greyed out, "Not set up" | The Google client secret or `publicUrl` is missing (same as the sign-in button). |
| Google says "access blocked" / app not verified | Consent screen is in Testing and the person is not a test user. |
| "Google did not return a long-lived sign-in" | The person approved before; remove the portal under their Google account's third-party access and connect again. |
| "Not every permission was ticked" | The person unticked a permission on Google's screen; connect again and allow all four. |
| Tool says "Google no longer accepts the saved connection" | Token revoked or expired (Testing app after 7 days). Disconnect and connect again. |
| Edit tools missing in a session | "Let agents edit my files" is off; sessions started after turning it on get them. |

## Gmail for agents

Integrations → Connected services → **Gmail** lets an agent search and read the signed-in person's mail, and, only if they tick "Let agents draft and send email as me", save drafts and send. It uses the same Google client as sign-in, with its own consent (scopes `gmail.readonly` and `gmail.compose`; it never asks for full mailbox access).

One-time setup in the Google Cloud project that owns the client: enable the **Gmail API**, and add the two Gmail scopes to the OAuth consent screen. While the app is in "Testing", add each person as a test user. Restricted Gmail scopes need Google verification before anyone outside your organisation can use them.
