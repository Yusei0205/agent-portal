# Path B — Known bugs to fix later

Found in review, deferred so the build can move faster. Fix before real use.

## Knowledge search (DynamoDB mode, server/repositories/knowledge-dynamodb.ts)

1. Lazy cleanup in `searchDocs` calls `removeDocIndex(docId)` when it sees one stale posting. That deletes the doc's current postings too, so after a concurrent re-index the doc can become unsearchable.
2. Two concurrent `indexDoc` calls can leave orphan postings that `deleteDoc` never removes (removal uses DOCTERMS, which only lists the last writer's terms). Use GSI-DocId to find all postings of a doc.
3. Tokenizer drops everything outside `[a-z0-9]`: accented, Cyrillic and CJK text is not searchable. SQLite FTS5 handles these.
4. A term with more than 100 postings returns incomplete results (no ordering by strength).
5. Stale-posting cleanup is fire-and-forget; Lambda can freeze it.

## Dashboard / insights (DynamoDB mode)

6. Agent-edge rollup (EDGESTATS) is written best-effort outside a transaction; a failed write drops that edge from the graph.
7. Approximations: p50/p95 null, toolCalls/toolErrors 0, provider null, admin cost-by-user ignores project filter.

## Sessions (DynamoDB mode)

8. Transcript route reads the whole session (up to 10,000 events) for each page.
9. Event payloads over 380 KB are truncated (S3 overflow planned).
10. emitRunEvent publishes with id=0 after a persistent write failure (event-loss marker is best-effort).

## Test tooling

11. `test:affected` skips modules whose code hash already passed, even when DYNAMODB_ENDPOINT is set. Run DynamoDB contract test files directly.
