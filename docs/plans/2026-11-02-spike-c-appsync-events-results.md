# Spike C — AppSync Events Results

**Branch:** `main_v3`  
**Date:** 2026-11-02  
**Goal:** Prove that AWS AppSync Events can replace SSE fan-out for agent-portal live updates.

---

## Verdict

| Criteria | Result |
|---|---|
| Stack deploys cleanly | ✅ |
| IAM publish from script works | ✅ |
| Lambda auth — cross-project subscribe DENIED | ✅ |
| Lambda auth — own-project subscribe ALLOWED | ✅ |
| Global channel accessible to any valid token | ✅ |
| 500-event burst delivered without errors | ✅ |
| Large payloads (up to 20 KB) accepted | ✅ |
| Reconnect works, setup < 150 ms | ✅ |
| Cost for this spike test run | ~$0.001 |
| **Overall verdict** | **PASS — recommend for S6** |

---

## Resources created

| Resource | ARN / ID |
|---|---|
| CloudFormation stack | `arn:aws:cloudformation:ap-southeast-1:366019841051:stack/AgentPortalSpikeC/07a96df0-d609-11f1-8bd5-06ffec68e6cf` |
| AppSync Events API ID | `x2mfltazyvgcpf55gj35sxudna` |
| HTTP endpoint | `https://am5pzyt7cjffdgzpq6jyuvli5e.appsync-api.ap-southeast-1.amazonaws.com` |
| Realtime (WebSocket) endpoint | `wss://am5pzyt7cjffdgzpq6jyuvli5e.appsync-realtime-api.ap-southeast-1.amazonaws.com/event/realtime` |
| Lambda authorizer | `arn:aws:lambda:ap-southeast-1:366019841051:function:agent-portal-spike-c-authorizer` |
| CloudWatch Log Group | `/aws/appsync/spike-c` (3-day retention) |
| IAM log role | `agent-portal-spike-c-appsync-log-role` |

All resources tagged `project=agent-portal`, `purpose=spike-c`.

---

## Channel namespaces

Three namespaces, matching `server/events.ts` scopes:

| Namespace | Channel pattern | Portal equivalent |
|---|---|---|
| `run` | `/run/<runId>` | `subscribeRun(runId, fn)` / `publishRunEvent()` |
| `project` | `/project/<projectId>` | `subscribe(projectId, res)` / `emit(projectId, event)` |
| `global` | `/global/portal` | `subscribeGlobalOnly(res)` / `emitGlobal(event)` |

---

## Auth model

| Operation | Auth | Notes |
|---|---|---|
| Publish (HTTP POST `/event`) | `AWS_IAM` (SigV4) | Server/Lambda only; requires `appsync:EventPublish` on API ARN |
| WebSocket connect | `AWS_LAMBDA` | Browser sends base64(JSON token) |
| Subscribe | `AWS_LAMBDA` | Same token re-checked per channel |

### Lambda authorizer logic

Token format for the spike: `base64(JSON { "projectId": "project-a" })` or `base64(JSON { "scope": "global" })`.

| Operation | Token | Channel | Decision |
|---|---|---|---|
| `EVENT_CONNECT` | any valid | — | allow |
| `EVENT_PUBLISH` | any | — | **deny** (IAM only) |
| `EVENT_SUBSCRIBE` | any valid | `/global/*` | allow |
| `EVENT_SUBSCRIBE` | any valid | `/run/*` | allow |
| `EVENT_SUBSCRIBE` | `{ projectId: "A" }` | `/project/A` | **allow** |
| `EVENT_SUBSCRIBE` | `{ projectId: "A" }` | `/project/B` | **deny** ✅ verified |

### Cross-project deny test output (verbatim)

```
[1] Cross-project subscribe DENY test...
    Connected  (setup: 231 ms)
    ✅ PASS: cross-project subscribe correctly denied
       Error: You are not authorized to make this call.
    ✅ PASS: subscribing to own project allowed
```

### For S6 (production)

Replace the base64 JSON token with a signed JWT (HMAC-SHA256 with the portal secret key). The Lambda authorizer verifies the signature and extracts the `projectId` claim. Use `authorizerResultTtlInSeconds: 300` (5-minute cache) to reduce Lambda invocations per client.

---

## Performance measurements

### Connection setup time

| Measurement | Time |
|---|---|
| Initial connection (cold WebSocket) | 231 ms |
| Second connection (warm socket path) | 88–91 ms |
| Reconnect (after intentional close) | 107 ms |

All measurements from ap-southeast-1 to ap-southeast-1 (same region as API).

### Publish latency (IAM HTTP POST)

| Measurement | Time |
|---|---|
| Single event, warm path | 32–54 ms |
| Single event, first request (cold credentials) | 243–482 ms |
| Burst batch (5 events), steady state | ~30–60 ms per batch |

### End-to-end latency (publish → receive at subscriber)

Measured via `publishedAt` timestamp embedded in event payload vs. `Date.now()` at receive.  
Sample: 521 events (500 run events + 10 project + 5 global + smoke events).

| Metric | run channel | project channel | global channel | ALL |
|---|---|---|---|---|
| p50 | **74 ms** | 58 ms | 76 ms | **74 ms** |
| p95 | **166 ms** | 139 ms | 143 ms | **165 ms** |
| min | 48 ms | 53 ms | 59 ms | 48 ms |
| max | 316 ms | 139 ms | 143 ms | 316 ms |
| avg | 96 ms | 67 ms | 94 ms | 95 ms |
| n | 506 | 10 | 5 | 521 |

**p50 ≈ 74 ms, p95 ≈ 165 ms** at personal-use scale from the same region. This is acceptable for live agent-run output (agent tokens typically arrive every 100–500 ms anyway).

### Large-payload behaviour

AppSync Events bills payloads per 5 KB chunk. All sizes up to 20 KB accepted without errors.

| Payload size | HTTP round-trip | Billed ops (publish) | Notes |
|---|---|---|---|
| 4,096 bytes | 209 ms | 1 | ≤ 5 KB = 1 op |
| 5,120 bytes | 32 ms | 1 | exactly 5 KB = 1 op |
| 6,000 bytes | 44 ms | 2 | > 5 KB = 2 ops |
| 10,240 bytes | 54 ms | 2 | ≤ 10 KB = 2 ops |
| 20,480 bytes | 147 ms | 4 | ≤ 20 KB = 4 ops |

Implication: run-event `payload` text is typically < 1 KB, so agent-run output costs 1 op per event. Only if a run event includes very long code blocks (> 5 KB per event) does it cost 2 ops. 

### Batch size limit (discovered)

The publish endpoint enforces **max 5 events per HTTP request**. Batches larger than 5 return HTTP 400 `"Input exceeded 5 event limit"`. The publisher script was corrected to use batches of 5.

### Throughput (from burst test)

500 events in 100 HTTP requests (5 each) in 6,303 ms = **79 events/second** with no subscriber.  
At this throughput, even a run with 200 events/minute (very busy agent) would consume < 1% of capacity.

### Reconnect behaviour

- After intentional close, reconnect established in 107 ms.
- AppSync Events is **pure pub/sub** — no message persistence.
- **Events published while disconnected are not replayed on reconnect.**
- The portal S6 client must poll `GET /api/runs/:id/events` (existing endpoint) as a fallback to catch events missed during a reconnect. The polling period on the `events` param (`after_id`) ensures idempotent replay.

---

## Operation count and cost for this spike run

AppSync Events pricing (ap-southeast-1): **$1.00 per million operations** + **$0.08 per million connection-minutes**.  
Source: [aws.amazon.com/appsync/pricing](https://aws.amazon.com/appsync/pricing/) — verified 2026-11-02.  
Operations counted: inbound published, outbound delivered, connect, subscribe, ping.

| Category | Count |
|---|---|
| Events published (run + project + global + smoke) | ~517 |
| Events delivered (1 subscriber) | ~521 |
| Connect/subscribe/reconnect ops | ~15 |
| Large-payload extra ops (> 5 KB billing) | 5 |
| **Total operations** | **~1,058** |
| **Total cost** | **~$0.001058** |
| Connection minutes (2 connections × ~90 s) | 3 minutes |
| Connection cost | $0.00000024 |
| **Grand total spike cost** | **< $0.002** |

---

## Estimated cost at portal production scale (S6)

Assumptions: 20 active runs/day, 100 events per run, 1 subscriber per run, 2-minute run duration.

| Category | Count/month | Cost/month |
|---|---|---|
| Run events published | 20 × 100 × 30 = 60,000 | $0.060 |
| Run events delivered (1 sub/run) | 60,000 | $0.060 |
| Project events published (est. 50/day) | 1,500 | $0.0015 |
| Project events delivered (3 subscribers avg) | 4,500 | $0.0045 |
| Global events (est. 10/day) | 300 | $0.0003 |
| Connect/subscribe ops | ~300 | $0.0003 |
| Connection minutes (3 min avg × 20 × 30) | 1,800 | $0.000144 |
| **Total** | | **~$0.13/month** |

AppSync Events live-update cost at personal-use scale: **~$0.13/month** — well within the $50/month budget.

---

## Recommended event batching for S6 (to cut message count)

At $0.13/month, batching is not required for cost reasons at personal-use scale.  
Implement simple batching only if usage grows:
- **API Lambda** buffers events within a 200 ms window and publishes them in one HTTP request (up to 5 events per batch, the AppSync limit).
- **Client** processes events in order regardless of whether they arrive batched or not.
- Keep the event shape identical to the current SSE shape so `useRunStream.js` and `events.js` clients need minimal changes.

**Current portal event shapes are directly compatible with AppSync Events** — publish the same JSON that the SSE server currently writes to `res.write()`.

---

## S6 implementation design

### Server side (API Lambda or callback Lambda)

```typescript
// Publishing run events (same shape as server/events.ts publishRunEvent)
await appSyncPublish(`/run/${runId}`, [{
  type: 'event',
  event: { id, run_id, type, payload, created_at },
}]);

// Publishing project events (same shape as server/events.ts emit)
await appSyncPublish(`/project/${projectId}`, [{
  type: eventType,
  ...eventData,
}]);

// Publishing global events (same shape as server/events.ts emitGlobal)
await appSyncPublish('/global/portal', [{ type: 'theme.changed', etag }]);
```

Publishing uses AWS SigV4 (`appsync:EventPublish`). The API Lambda execution role needs this permission on the AppSync API ARN.

### Browser/client side

Replace `EventSource` with a WebSocket client:
1. On session start, request a short-lived portal token from the API (e.g. `/api/events/token` returning a signed JWT valid for 1 hour).
2. Connect to the AppSync realtime endpoint with the token.
3. Subscribe to `/run/<runId>`, `/project/<projectId>`, `/global/portal`.
4. On reconnect, re-subscribe and poll `GET /api/runs/:id/events?after_id=<lastSeenId>` to replay missed events.

The existing `useRunStream.js` hook can be adapted: replace `EventSource` with a WebSocket client using the same frame format. The event shape `{ type: 'event', event: { ... } }` remains unchanged.

### Lambda authorizer for production

```python
import json, base64, hmac, hashlib, os

def lambda_handler(event, context):
    token = event.get('authorizationToken', '')
    op = (event.get('requestContext') or {}).get('operation', '')
    ch = (event.get('requestContext') or {}).get('channel', '')

    # Verify HMAC signature
    try:
        payload_b64, sig = token.rsplit('.', 1)
        expected = hmac.new(os.environ['PORTAL_SECRET'].encode(), payload_b64.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(sig, expected):
            return {'isAuthorized': False}
        claims = json.loads(base64.urlsafe_b64decode(payload_b64 + '=='))
    except Exception:
        return {'isAuthorized': False}

    if op == 'EVENT_CONNECT':
        return {'isAuthorized': True}
    if op == 'EVENT_PUBLISH':
        return {'isAuthorized': False}  # IAM only
    if op == 'EVENT_SUBSCRIBE':
        if ch.startswith('/global/') or ch.startswith('/run/'):
            return {'isAuthorized': True}
        import re
        m = re.match(r'^/project/([^/]+)', ch)
        if m:
            return {'isAuthorized': claims.get('projectId') == m.group(1)}
    return {'isAuthorized': False}
```

---

## Protocol findings (important for S6 implementation)

| Finding | Detail |
|---|---|
| Subscribe ack message type | AppSync Events sends **`subscribe_success`**, NOT `subscribe_ack` (GraphQL protocol). Client must handle `subscribe_success`. |
| Batch limit | Max **5 events per HTTP publish request**. Batching beyond 5 returns HTTP 400 `"Input exceeded 5 event limit"`. |
| Payload billing | Charged per 5 KB: an 8 KB event = 2 operations. |
| Keep-alive | AppSync sends `{"type":"ka"}` keep-alive messages on idle connections — client must ignore these. |
| No persistence | Events published while a client is disconnected are lost. Client must poll fallback API after reconnect. |
| Connection format | Sub-protocol format: `["aws-appsync-event-ws", "header-<base64url({"Authorization":"<token>","host":"<httpDomain>"})>"]` |
| Authorizer TTL | `authorizerResultTtlInSeconds: 0` disables caching (required for spike). For production, use 300 (5 min) to reduce Lambda cost. |
| Authorizer latency | Cold start: 165 ms init + 19 ms exec. Warm: ~1–2 ms. With 5-minute TTL cache, near-zero per-subscribe cost. |

---

## Blockers for S6

| Issue | Severity | Resolution |
|---|---|---|
| No S6 issues — AppSync Events is ready | — | — |
| S6 depends on S1 (async DB layer) for API Lambda | Dependency | Do S1 first or issue portal tokens from a shim endpoint |
| Token signing needs `PORTAL_SECRET` in Lambda env | Minor | SSM Parameter Store (already planned) |
| Client-side WebSocket needs `@aws-amplify/api` or custom impl | Minor | Use raw WebSocket as demonstrated; Amplify optional |
| Missed events on reconnect need polling fallback | Design requirement | Existing `GET /api/runs/:id/events?after_id=N` already handles this |

---

## Teardown commands

The stack is left deployed (idle cost: ~$0/month, no running connections).

```sh
# Destroy the Spike C stack (AppSync API, Lambda authorizer, log group)
cd infra
npx cdk destroy AgentPortalSpikeC --profile agentcore

# Note: Spike A stack is unaffected.
# Note: No ECR repo was created for Spike C — nothing else to clean up.
```

---

## Files created

| Path | Purpose |
|---|---|
| `infra/lib/spike-c-stack.ts` | CDK stack: AppSync Events API, Lambda authorizer, 3 channel namespaces |
| `infra/bin/app.ts` | Updated: adds `AgentPortalSpikeCStack` |
| `infra/scripts/spike-c-setup.mjs` | Reads CDK outputs → writes `spike-c-config.json` |
| `infra/scripts/spike-c-publish.mjs` | IAM SigV4 publisher: burst test, large payload test, cost estimate |
| `infra/scripts/spike-c-subscribe.mjs` | Lambda-auth WebSocket subscriber: DENY test, latency test, reconnect test |
| `infra/README.md` | Updated: Spike C deploy/destroy instructions |
| `docs/plans/2026-11-02-spike-c-appsync-events-results.md` | This file |

---

## Checklist against requirements

| Requirement | Status |
|---|---|
| Separate CDK stack `AgentPortalSpikeC` | ✅ |
| AppSync Events API with channel namespaces run/project/global | ✅ |
| IAM auth for publishing (server-side) | ✅ |
| Lambda authorizer for browser subscribe | ✅ |
| Cross-project subscribe denial demonstrated | ✅ PASS |
| Test client: WebSocket subscriber | ✅ |
| Test client: IAM publisher with burst | ✅ |
| 500-event burst with some > 5 KB | ✅ |
| Publish-to-receive latency p50/p95 measured | ✅ p50=74ms, p95=165ms |
| Connection setup time measured | ✅ 88–231ms |
| Behaviour for payloads > 5 KB | ✅ works, billed as 2+ ops |
| Batch size limit discovered | ✅ max 5 events per request |
| Reconnect behaviour tested | ✅ 107ms reconnect, no replay |
| Operation count computed | ✅ ~1,058 ops for this spike |
| Cost using current pricing | ✅ < $0.002 for spike, ~$0.13/month production |
| Results doc with pass/fail, numbers | ✅ this file |
| Recommended event batching for S6 | ✅ |
| Auth design for S6 | ✅ |
| Teardown commands | ✅ |
| Tag all resources | ✅ project=agent-portal, purpose=spike-c |
| Stack left deployed | ✅ |
| No changes to server/ or web/src/ | ✅ |
| Spike A stack and ECR repo unaffected | ✅ |
| infra/README.md updated | ✅ |
