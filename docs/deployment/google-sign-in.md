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
