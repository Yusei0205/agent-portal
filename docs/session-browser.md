# The cloud browser of a session

A Kiro or Claude session that has the AgentCore browser (`-c agentcoreBrowser=true`, `PORTAL_AGENTCORE_BROWSER=1`) uses one cloud browser for the whole session.

- **Stays open between turns.** When a turn ends the runner only disconnects (`AgentCoreBrowser.keepOpen`); the browser keeps running, with a lifetime of one hour from when it was
  started (`BROWSER_LIFETIME_MS` in `server/browser-session.ts`, set as the AgentCore session timeout). Guide runs (one-shot documents) still close theirs when they end.
- **The next turn reconnects.** The runner announces every browser session it starts or reconnects to as a `browser-session` event. The portal passes the newest one to the next
  turn (`browserKeepOpen`, `browserResumeSession` in the invoke payload); the runner checks it is `READY` (GetBrowserSession) and attaches to the same tab, or starts a new browser
  when it has ended.
- **Watch and take over any time.** `GET /api/workflows/:wid/browser/live-view` offers the Live View whenever AgentCore says the browser is `READY`, not only while a run is going.
- **Closing it.** The **Close browser** button in the Browser tab (`POST /api/workflows/:wid/browser/close`, editors) stops it at once; deleting the session stops it too; otherwise it ends
  when its hour is up. The portal's role needs `bedrock-agentcore:GetBrowserSession` and `StopBrowserSession`.
- **Cost.** A browser that is left open is billed while it is open: that is why the lifetime is one hour and why it can be closed.
- **Waiting for a person.** `wait_for_sign_in` (offered in every browser session) keeps the agent's turn open while the person signs in through Live View; see `user-guides-with-screenshots.md`.
