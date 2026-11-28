# Control the portal from Telegram

The Telegram bridge lets you work with a portal running on your own PC from a Telegram chat. You
can pick a project, start a session, send it messages, see its status, stop it, and get the
agent's reply when a turn finishes.

It uses Telegram's **long polling**: the portal asks Telegram for new messages, so all traffic goes
out from your PC to `api.telegram.org`. You don't need a public address, port forwarding or a tunnel.
The bridge runs only in a local portal (`npm start` / `npm run dev`), never in the Lambda deployment.

## Set it up in the portal (easiest)

Open **Connect > Telegram** (an admin page; in Simple mode it's under Advanced):

1. Paste the bot token from **@BotFather** (`/newbot`) and press **Test bot token**.
2. Enter your chat ID (from **@userinfobot**). Several IDs are separated by commas.
3. Press **Create access token**. This makes a portal API token with read and write only, for you,
   valid for a year. Pressing it again replaces (and revokes) the old one.
4. Pick the engine for `/new` if you like, leave **On** ticked, and press **Save and restart the bot**.

The page shows whether the bot is running and, if not, why. Changes apply at once without restarting the
portal. Tokens are stored encrypted and only their last four characters are shown again. **Forget settings**
removes them and revokes the bot's API token. Settings saved here take over from `.env`.

## Or set it up in .env (about 5 minutes)

1. **Create the bot.** In Telegram, open a chat with **@BotFather**, send `/newbot`, pick a name and
   a username, and copy the token it gives you (looks like `123456789:AAE…`).
2. **Find your chat ID.** Send any message to **@userinfobot** and copy the number it shows as your ID.
   (You can also start the portal with only the bot token and the allowlist set to `0`, message your
   bot, and read the ID from the portal's log line "ignored a message from chat …".)
3. **Make a portal API token.** In the portal, open **API access** (Advanced mode), create a token with
   **read** and **write**, and copy it (`ap_…`). Leave out **merge** unless you want the bot to be able to
   merge pull requests. The bot acts as you, with that token's rights.
4. **Add them to `.env`** in the portal folder:

   ```
   TELEGRAM_BOT_TOKEN=123456789:AAE...
   TELEGRAM_ALLOWED_CHAT_IDS=123456789
   TELEGRAM_PORTAL_TOKEN=ap_...
   # optional: the engine /new uses (claude-code, kiro, codex, cursor, demo)
   TELEGRAM_DEFAULT_ENGINE=claude-code
   ```

5. **Restart the portal.** The log shows `[telegram] bot @yourbot is on`. If a setting is wrong it says
   which one, and the portal carries on without the bridge.
6. In Telegram, open your bot and send `/help`.

## Commands

| Command | What it does |
|---|---|
| `/projects`, `/project <n>` | List your projects, then pick one by its number (or name) |
| `/newproject <name>` | Create a project and pick it. Add repositories to it in the portal when a session needs code |
| `/sessions`, `/session <n>` | List recent sessions in the project, then pick one |
| `/new <goal>` | Start a session with that goal. `/new codex <goal>` picks the engine. Without one it uses `TELEGRAM_DEFAULT_ENGINE`, else the engine, model and repositories of the project's latest session |
| any text | Sent as a message to the picked session. Slash commands such as `/model` or `/cost` go to the session too |
| `/status` | The session's status and its last reply |
| `/stop` | Stops the running turn. The bot asks first, and only `yes` within a minute stops it |
| `/inbox` | Approvals and questions waiting for you |

When you start a session or send a message, the bot sends the agent's reply once the turn ends
(it checks every few seconds, for up to an hour).

## Security

- **Allowlist.** Only private chats whose ID is in `TELEGRAM_ALLOWED_CHAT_IDS` get an answer. Messages
  from anyone else, and from group chats, are dropped without a reply and logged with their chat ID.
- **The portal's own rules apply.** The bot calls the portal's API with your token, so it can only do
  what that token can: project membership, the write scope and the rest are checked as usual. As with any
  API token, it **cannot approve tool calls or pushes, or turn on "trust all tools"**. Do those in a browser.
- **Audit log.** Every command is recorded as `telegram.command` with the chat ID; stops are also
  recorded as `session.interrupt` with source `telegram`.
- **Secrets stay on your PC.** The bot token and API token are read from `.env` and never sent to the
  chat. The picked project and session per chat are kept in `data/telegram-state.json`.
- **Turning it off.** Untick **On** under Connect > Telegram, or set `TELEGRAM_ENABLED=0` (or remove `TELEGRAM_BOT_TOKEN`) and restart. If a token
  leaks, revoke the API token in the portal and send `/revoke` to @BotFather for the bot token.

## Troubleshooting

- **"not started: … reach api.telegram.org"**: your network blocks Telegram. If you go through an
  HTTP proxy, Node 24 and later use it when you also set `NODE_USE_ENV_PROXY=1` and `HTTPS_PROXY`.
- **"Conflict: can't use getUpdates method while webhook is active"**: the bot has a webhook from
  another tool. Remove it by opening `https://api.telegram.org/bot<token>/deleteWebhook` once.
- **"Conflict: terminated by other getUpdates request"**: the same bot token is used by two running
  portals. Use one bot per portal.
- **The bot never answers**: check that your chat ID is in `TELEGRAM_ALLOWED_CHAT_IDS`; the log names
  every ignored chat.

## WhatsApp

Not built in. WhatsApp's Cloud API sends messages to a public HTTPS webhook, so a local portal would
need a tunnel (for example Cloudflare Tunnel) running all the time, plus a Meta business app and a
verified number. The bridge's commands are separate from the Telegram transport (`server/telegram/bot.ts`),
so a WhatsApp transport can reuse them later.
