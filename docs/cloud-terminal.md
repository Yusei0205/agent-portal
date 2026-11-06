# Cloud session terminals

Cloud terminals connect directly to the session's AgentCore runtime over a presigned WebSocket.
Lambda authorizes the connection through `POST /api/terminal/connect`; it does not proxy the socket
or run the shell. Local deployments keep the existing `/api/terminal/ws` connection.

The session owner needs project editor/owner access; portal administrators can also connect.
API tokens cannot open a terminal. The administrator's terminal enable/disable setting still applies.

The portal signs a one-use, one-minute grant with an Ed25519 key derived from its existing master
key. Runners verify it using the public key from the configured HTTPS portal issuer. A local HTTP
call inside an agent container cannot mint a terminal grant. No private signing key or portal master
key is supplied to a runner or browser. The AWS WebSocket URL is also valid for one minute and is
bound to the same runtime session.

Deploy both workflows: **Deploy portal** and **Deploy AgentCore runners**. The CDK policies grant
`bedrock-agentcore:InvokeAgentRuntimeWithWebSocketStream` only for configured runtimes. Set the
repository variable `PUBLIC_URL` to the portal's HTTPS origin when using a custom domain; the same
origin is deployed as `PORTAL_TERMINAL_ISSUER_URL` on Codex, Kiro, and Claude runners.

The shell restores the session's saved repositories and starts in the repository directory when
one repository is attached. Repository changes are saved when the terminal closes. Saving is
serialized with agent snapshots. The shell has a separate home directory and a filtered environment.
PTY support includes input, resizing, Ctrl+C, and interactive programs; a pipe fallback is available.

An inactive terminal closes after ten minutes; a connection lasts at most one hour. Protocol
heartbeats do not count as user activity. Reconnect opens a new authorized connection. The UI stops
automatic reconnect attempts after three failures and reports authentication/restoration errors.
