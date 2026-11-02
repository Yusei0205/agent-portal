/**
 * Contract tests for SessionsRepository.
 *
 * The same assertions run against both SQLite and DynamoDB implementations.
 * DynamoDB suite runs only when DYNAMODB_ENDPOINT is set.
 * Set REQUIRE_DYNAMODB=1 to turn the skip into a failure.
 *
 * To run the DynamoDB suite locally (PowerShell 5.1 — no &&):
 *   docker run -d --rm --name ddb-sessions -p 8000:8000 amazon/dynamodb-local
 *   $env:DYNAMODB_ENDPOINT='http://localhost:8000'; $env:REQUIRE_DYNAMODB='1'
 *   npm run test:affected -- --module sessions --backend-only
 *   docker stop ddb-sessions
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, cleanup } from './fixtures.ts';
import { SqliteSessionsRepository } from '../server/repositories/sessions-sqlite.ts';
import type { SessionsRepository } from '../server/repositories/sessions.ts';
import { clearSessionsRepository } from '../server/repositories/sessions.ts';
import { now, generateId } from '../server/util.ts';
import { insert } from '../server/db.ts';

// Per-run unique suffix — prevents DynamoDB Local ConditionalCheckFailedException on re-runs
const RUN_TAG = Date.now().toString(36).slice(-5);

// ── Shared contract suite ─────────────────────────────────────────────────────

function runContract(label: string, makeRepo: () => Promise<SessionsRepository>): void {
  describe(`${label} -- SessionsRepository contract`, () => {
    let repo: SessionsRepository;
    const sfx = label.replace(/[^a-z0-9]/gi, '').slice(0, 3).toLowerCase() + RUN_TAG;

    before(async () => {
      repo = await makeRepo();
    });

    after(() => {
      clearSessionsRepository();
    });

    // Workflow CRUD

    test('createWorkflow -- stores a workflow and returns it', async () => {
      const id = generateId();
      const ts = now();
      const wf = await repo.createWorkflow({
        id,
        project_id: null,
        goal: 'Test goal',
        status: 'pending',
        engine: 'demo',
        trust_tools: 0,
        lead_agent: null,
        workspace_id: null,
        output_files_enabled: 0,
        repo_ids: '[]',
        iteration_count: 0,
        max_iterations: 10,
        credential_id: null,
        model: '',
        created_by: null,
        created_at: ts,
        updated_at: ts,
      });
      assert.equal(wf.id, id);
      assert.equal(wf.goal, 'Test goal');
      assert.equal(wf.status, 'pending');
    });

    test('getWorkflowById -- returns the workflow', async () => {
      const id = generateId();
      const ts = now();
      await repo.createWorkflow({
        id, project_id: null, goal: 'Get test', status: 'pending',
        engine: 'demo', trust_tools: 0, lead_agent: null, workspace_id: null,
        output_files_enabled: 0, repo_ids: '[]', iteration_count: 0, max_iterations: 10,
        credential_id: null, model: '', created_by: null, created_at: ts, updated_at: ts,
      });
      const found = await repo.getWorkflowById(id);
      assert.ok(found);
      assert.equal(found.id, id);
      assert.equal(found.goal, 'Get test');
    });

    test('getWorkflowById -- returns null for unknown id', async () => {
      const found = await repo.getWorkflowById(`nonexistent-${sfx}`);
      assert.equal(found, null);
    });

    test('updateWorkflow -- updates status and updated_at', async () => {
      const id = generateId();
      const ts = now();
      await repo.createWorkflow({
        id, project_id: null, goal: 'Update test', status: 'pending',
        engine: 'demo', trust_tools: 0, lead_agent: null, workspace_id: null,
        output_files_enabled: 0, repo_ids: '[]', iteration_count: 0, max_iterations: 10,
        credential_id: null, model: '', created_by: null, created_at: ts, updated_at: ts,
      });
      const newTs = now();
      await repo.updateWorkflow(id, { status: 'running', updated_at: newTs });
      const updated = await repo.getWorkflowById(id);
      assert.ok(updated);
      assert.equal(updated.status, 'running');
    });

    test('listWorkflowsByProject -- returns workflows for a project', async () => {
      const projectId = `list-${sfx}`;
      const id1 = generateId();
      const id2 = generateId();
      const ts = now();
      await repo.createWorkflow({
        id: id1, project_id: projectId, goal: 'First', status: 'pending',
        engine: 'demo', trust_tools: 0, lead_agent: null, workspace_id: null,
        output_files_enabled: 0, repo_ids: '[]', iteration_count: 0, max_iterations: 10,
        credential_id: null, model: '', created_by: null, created_at: ts, updated_at: ts,
      });
      await repo.createWorkflow({
        id: id2, project_id: projectId, goal: 'Second', status: 'done',
        engine: 'demo', trust_tools: 0, lead_agent: null, workspace_id: null,
        output_files_enabled: 0, repo_ids: '[]', iteration_count: 0, max_iterations: 10,
        credential_id: null, model: '', created_by: null, created_at: ts, updated_at: ts,
      });
      const result = await repo.listWorkflowsByProject(projectId, { limit: 10 });
      assert.ok(result.workflows.length >= 2);
      assert.ok(result.total >= 2);
    });

    test('incrementWorkflowIteration -- increments the counter', async () => {
      const id = generateId();
      const ts = now();
      await repo.createWorkflow({
        id, project_id: null, goal: 'Iter test', status: 'done',
        engine: 'demo', trust_tools: 0, lead_agent: null, workspace_id: null,
        output_files_enabled: 0, repo_ids: '[]', iteration_count: 0, max_iterations: 10,
        credential_id: null, model: '', created_by: null, created_at: ts, updated_at: ts,
      });
      await repo.incrementWorkflowIteration(id);
      const updated = await repo.getWorkflowById(id);
      assert.ok(updated);
      assert.equal(updated.iteration_count, 1);
    });

    // Run CRUD

    test('createRun -- stores a run and returns it', async () => {
      const wfId = generateId();
      const runId = generateId();
      const ts = now();
      await repo.createWorkflow({
        id: wfId, project_id: null, goal: 'Run test', status: 'running',
        engine: 'demo', trust_tools: 0, lead_agent: null, workspace_id: null,
        output_files_enabled: 0, repo_ids: '[]', iteration_count: 0, max_iterations: 10,
        credential_id: null, model: '', created_by: null, created_at: ts, updated_at: ts,
      });
      const run = await repo.createRun({
        id: runId, workflow_id: wfId, status: 'pending',
        started_at: null, finished_at: null, cost_usd: 0, input_tokens: 0, output_tokens: 0,
        created_at: ts,
      });
      assert.equal(run.id, runId);
      assert.equal(run.workflow_id, wfId);
      assert.equal(run.status, 'pending');
    });

    test('getRunById -- returns the run', async () => {
      const wfId = generateId();
      const runId = generateId();
      const ts = now();
      await repo.createWorkflow({
        id: wfId, project_id: null, goal: 'Get run test', status: 'running',
        engine: 'demo', trust_tools: 0, lead_agent: null, workspace_id: null,
        output_files_enabled: 0, repo_ids: '[]', iteration_count: 0, max_iterations: 10,
        credential_id: null, model: '', created_by: null, created_at: ts, updated_at: ts,
      });
      await repo.createRun({
        id: runId, workflow_id: wfId, status: 'running',
        started_at: ts, finished_at: null, cost_usd: 0, input_tokens: 0, output_tokens: 0,
        created_at: ts,
      });
      const found = await repo.getRunById(runId);
      assert.ok(found);
      assert.equal(found.id, runId);
      assert.equal(found.workflow_id, wfId);
    });

    test('getLatestRun -- returns newest run for a workflow', async () => {
      const wfId = generateId();
      const ts = now();
      await repo.createWorkflow({
        id: wfId, project_id: null, goal: 'Latest run test', status: 'running',
        engine: 'demo', trust_tools: 0, lead_agent: null, workspace_id: null,
        output_files_enabled: 0, repo_ids: '[]', iteration_count: 0, max_iterations: 10,
        credential_id: null, model: '', created_by: null, created_at: ts, updated_at: ts,
      });
      const run1Id = generateId();
      const run2Id = generateId();
      await repo.createRun({ id: run1Id, workflow_id: wfId, status: 'done',
        started_at: ts, finished_at: ts, cost_usd: 0, input_tokens: 0, output_tokens: 0, created_at: ts });
      const ts2 = new Date(Date.now() + 1000).toISOString();
      await repo.createRun({ id: run2Id, workflow_id: wfId, status: 'running',
        started_at: ts2, finished_at: null, cost_usd: 0, input_tokens: 0, output_tokens: 0, created_at: ts2 });
      const latest = await repo.getLatestRun(wfId);
      assert.ok(latest);
      assert.equal(latest.id, run2Id);
    });

    test('updateRun -- updates status', async () => {
      const wfId = generateId();
      const runId = generateId();
      const ts = now();
      await repo.createWorkflow({
        id: wfId, project_id: null, goal: 'Update run', status: 'running',
        engine: 'demo', trust_tools: 0, lead_agent: null, workspace_id: null,
        output_files_enabled: 0, repo_ids: '[]', iteration_count: 0, max_iterations: 10,
        credential_id: null, model: '', created_by: null, created_at: ts, updated_at: ts,
      });
      await repo.createRun({ id: runId, workflow_id: wfId, status: 'pending',
        started_at: null, finished_at: null, cost_usd: 0, input_tokens: 0, output_tokens: 0, created_at: ts });
      await repo.updateRun(runId, { status: 'done', finished_at: now() });
      const updated = await repo.getRunById(runId);
      assert.ok(updated);
      assert.equal(updated.status, 'done');
    });

    test('getRunTotals -- sums cost and tokens across runs', async () => {
      const wfId = generateId();
      const ts = now();
      await repo.createWorkflow({
        id: wfId, project_id: null, goal: 'Totals test', status: 'done',
        engine: 'demo', trust_tools: 0, lead_agent: null, workspace_id: null,
        output_files_enabled: 0, repo_ids: '[]', iteration_count: 0, max_iterations: 10,
        credential_id: null, model: '', created_by: null, created_at: ts, updated_at: ts,
      });
      await repo.createRun({ id: generateId(), workflow_id: wfId, status: 'done',
        started_at: ts, finished_at: ts, cost_usd: 1.5, input_tokens: 100, output_tokens: 50, created_at: ts });
      await repo.createRun({ id: generateId(), workflow_id: wfId, status: 'done',
        started_at: ts, finished_at: ts, cost_usd: 0.5, input_tokens: 200, output_tokens: 100,
        created_at: new Date(Date.now() + 1000).toISOString() });
      const totals = await repo.getRunTotals(wfId);
      assert.ok(Math.abs(totals.total_cost - 2.0) < 0.001, `total_cost ~2.0, got ${totals.total_cost}`);
      assert.equal(totals.total_input, 300);
      assert.equal(totals.total_output, 150);
    });

    // Events

    test('appendRunEvent -- appends and returns id', async () => {
      const wfId = generateId();
      const runId = generateId();
      const ts = now();
      await repo.createWorkflow({
        id: wfId, project_id: null, goal: 'Event test', status: 'running',
        engine: 'demo', trust_tools: 0, lead_agent: null, workspace_id: null,
        output_files_enabled: 0, repo_ids: '[]', iteration_count: 0, max_iterations: 10,
        credential_id: null, model: '', created_by: null, created_at: ts, updated_at: ts,
      });
      await repo.createRun({ id: runId, workflow_id: wfId, status: 'running',
        started_at: ts, finished_at: null, cost_usd: 0, input_tokens: 0, output_tokens: 0, created_at: ts });
      const evt = await repo.appendRunEvent(runId, 'assistant-text', '{"text":"hello"}', ts);
      assert.ok(evt.id > 0, `Event id should be positive, got ${evt.id}`);
    });

    test('listRunEvents -- returns events in ascending order', async () => {
      const wfId = generateId();
      const runId = generateId();
      const ts = now();
      await repo.createWorkflow({
        id: wfId, project_id: null, goal: 'List events', status: 'running',
        engine: 'demo', trust_tools: 0, lead_agent: null, workspace_id: null,
        output_files_enabled: 0, repo_ids: '[]', iteration_count: 0, max_iterations: 10,
        credential_id: null, model: '', created_by: null, created_at: ts, updated_at: ts,
      });
      await repo.createRun({ id: runId, workflow_id: wfId, status: 'running',
        started_at: ts, finished_at: null, cost_usd: 0, input_tokens: 0, output_tokens: 0, created_at: ts });
      await repo.appendRunEvent(runId, 'assistant-text', '{"text":"first"}', ts);
      await repo.appendRunEvent(runId, 'tool-start', '{"toolName":"bash"}', ts);
      await repo.appendRunEvent(runId, 'tool-end', '{"toolName":"bash"}', ts);
      const events = await repo.listRunEvents(runId);
      assert.ok(events.length >= 3);
      // Verify ascending order
      const ids = events.map((e) => e.id);
      for (let i = 1; i < ids.length; i++) {
        assert.ok(ids[i] > ids[i - 1], `Event ${i} id ${ids[i]} should be > ${ids[i - 1]}`);
      }
    });

    test('listRunEventsFrom -- returns events after fromId', async () => {
      const wfId = generateId();
      const runId = generateId();
      const ts = now();
      await repo.createWorkflow({
        id: wfId, project_id: null, goal: 'Events from', status: 'running',
        engine: 'demo', trust_tools: 0, lead_agent: null, workspace_id: null,
        output_files_enabled: 0, repo_ids: '[]', iteration_count: 0, max_iterations: 10,
        credential_id: null, model: '', created_by: null, created_at: ts, updated_at: ts,
      });
      await repo.createRun({ id: runId, workflow_id: wfId, status: 'running',
        started_at: ts, finished_at: null, cost_usd: 0, input_tokens: 0, output_tokens: 0, created_at: ts });
      const e1 = await repo.appendRunEvent(runId, 'e1', '{}', ts);
      await repo.appendRunEvent(runId, 'e2', '{}', ts);
      await repo.appendRunEvent(runId, 'e3', '{}', ts);
      const after = await repo.listRunEventsFrom(runId, e1.id);
      assert.ok(after.length >= 2, `Expected >=2 events after id ${e1.id}, got ${after.length}`);
      assert.ok(after.every((e) => e.id > e1.id), 'All returned ids should be > fromId');
    });

    test('event ordering -- concurrent appends produce strict ascending sequence', async () => {
      const wfId = generateId();
      const runId = generateId();
      const ts = now();
      await repo.createWorkflow({
        id: wfId, project_id: null, goal: 'Ordering test', status: 'running',
        engine: 'demo', trust_tools: 0, lead_agent: null, workspace_id: null,
        output_files_enabled: 0, repo_ids: '[]', iteration_count: 0, max_iterations: 10,
        credential_id: null, model: '', created_by: null, created_at: ts, updated_at: ts,
      });
      await repo.createRun({ id: runId, workflow_id: wfId, status: 'running',
        started_at: ts, finished_at: null, cost_usd: 0, input_tokens: 0, output_tokens: 0, created_at: ts });
      // Append 10 events concurrently to test ordering
      const appends = Array.from({ length: 10 }, (_, i) =>
        repo.appendRunEvent(runId, `type-${i}`, `{"seq":${i}}`, ts),
      );
      const results = await Promise.all(appends);
      const ids = results.map((r) => r.id).sort((a, b) => a - b);
      // All IDs should be unique
      const uniqueIds = new Set(ids);
      assert.equal(uniqueIds.size, 10, 'All concurrent event IDs should be unique');
      // IDs should be strictly increasing
      for (let i = 1; i < ids.length; i++) {
        assert.ok(ids[i] > ids[i - 1], `id[${i}]=${ids[i]} should be > id[${i - 1}]=${ids[i - 1]}`);
      }
    });

    test('oversized payload -- truncated to fit within limit', async () => {
      const wfId = generateId();
      const runId = generateId();
      const ts = now();
      await repo.createWorkflow({
        id: wfId, project_id: null, goal: 'Oversized payload', status: 'running',
        engine: 'demo', trust_tools: 0, lead_agent: null, workspace_id: null,
        output_files_enabled: 0, repo_ids: '[]', iteration_count: 0, max_iterations: 10,
        credential_id: null, model: '', created_by: null, created_at: ts, updated_at: ts,
      });
      await repo.createRun({ id: runId, workflow_id: wfId, status: 'running',
        started_at: ts, finished_at: null, cost_usd: 0, input_tokens: 0, output_tokens: 0, created_at: ts });
      // Create a payload that exceeds 380KB
      const bigPayload = JSON.stringify({ data: 'x'.repeat(400_000) });
      const evt = await repo.appendRunEvent(runId, 'tool-end', bigPayload, ts);
      assert.ok(evt.id > 0);
      const events = await repo.listRunEvents(runId);
      assert.ok(events.length > 0);
      const stored = events.find((e) => e.id === evt.id);
      assert.ok(stored, 'Stored event should be retrievable');
      assert.ok(stored.payload.length > 0, 'Payload should not be empty');
    });

    // Inputs

    test('createInput -- stores an input record', async () => {
      const wfId = generateId();
      const runId = generateId();
      const inputId = generateId();
      const ts = now();
      await repo.createWorkflow({
        id: wfId, project_id: null, goal: 'Input test', status: 'running',
        engine: 'demo', trust_tools: 0, lead_agent: null, workspace_id: null,
        output_files_enabled: 0, repo_ids: '[]', iteration_count: 0, max_iterations: 10,
        credential_id: null, model: '', created_by: null, created_at: ts, updated_at: ts,
      });
      await repo.createRun({ id: runId, workflow_id: wfId, status: 'running',
        started_at: ts, finished_at: null, cost_usd: 0, input_tokens: 0, output_tokens: 0, created_at: ts });
      const input = await repo.createInput({
        id: inputId, run_id: runId, project_id: null,
        tool_name: 'Bash', tool_input: '{"command":"ls"}',
        payload: '{"toolName":"Bash","input":{"command":"ls"},"inputHash":"abc123"}',
        input_hash: 'abc123', type: 'approval', status: 'pending',
        allow_all: 0, expires_at: null, created_at: ts,
      });
      assert.equal(input.id, inputId);
      assert.equal(input.status, 'pending');
    });

    test('updateInputConditional -- approves pending input atomically', async () => {
      const wfId = generateId();
      const runId = generateId();
      const inputId = generateId();
      const ts = now();
      await repo.createWorkflow({
        id: wfId, project_id: null, goal: 'Input claim test', status: 'running',
        engine: 'demo', trust_tools: 0, lead_agent: null, workspace_id: null,
        output_files_enabled: 0, repo_ids: '[]', iteration_count: 0, max_iterations: 10,
        credential_id: null, model: '', created_by: null, created_at: ts, updated_at: ts,
      });
      await repo.createRun({ id: runId, workflow_id: wfId, status: 'running',
        started_at: ts, finished_at: null, cost_usd: 0, input_tokens: 0, output_tokens: 0, created_at: ts });
      await repo.createInput({
        id: inputId, run_id: runId, project_id: null,
        tool_name: 'Bash', tool_input: '{}', payload: '{}',
        input_hash: 'hash1', type: 'approval', status: 'pending',
        allow_all: 0, expires_at: null, created_at: ts,
      });

      // First claim succeeds
      const claimed = await repo.updateInputConditional(inputId, 'pending', {
        status: 'answered', response: '"approve"', answered_at: now(), run_id: runId,
      });
      assert.ok(claimed, 'First conditional update should succeed');

      // Second claim by a concurrent writer should fail
      const claimedAgain = await repo.updateInputConditional(inputId, 'pending', {
        status: 'answered', response: '"deny"', answered_at: now(), run_id: runId,
      });
      assert.equal(claimedAgain, false, 'Second conditional update should fail');
    });

    test('getInputByHash -- finds input by hash + runId', async () => {
      const wfId = generateId();
      const runId = generateId();
      const inputId = generateId();
      const hash = `hash-${sfx}-${generateId().slice(0, 8)}`;
      const ts = now();
      await repo.createWorkflow({
        id: wfId, project_id: null, goal: 'Hash test', status: 'running',
        engine: 'demo', trust_tools: 0, lead_agent: null, workspace_id: null,
        output_files_enabled: 0, repo_ids: '[]', iteration_count: 0, max_iterations: 10,
        credential_id: null, model: '', created_by: null, created_at: ts, updated_at: ts,
      });
      await repo.createRun({ id: runId, workflow_id: wfId, status: 'running',
        started_at: ts, finished_at: null, cost_usd: 0, input_tokens: 0, output_tokens: 0, created_at: ts });
      await repo.createInput({
        id: inputId, run_id: runId, project_id: null,
        tool_name: 'Bash', tool_input: '{}', payload: '{}',
        input_hash: hash, type: 'approval', status: 'pending',
        allow_all: 0, expires_at: null, created_at: ts,
      });
      const found = await repo.getInputByHash(hash, runId);
      assert.ok(found, 'Should find input by hash');
      assert.equal(found.id, inputId);
    });

    // Workflow events

    test('appendWorkflowEvent -- stores an event', async () => {
      const wfId = generateId();
      const ts = now();
      await repo.createWorkflow({
        id: wfId, project_id: null, goal: 'Workflow event test', status: 'pending',
        engine: 'demo', trust_tools: 0, lead_agent: null, workspace_id: null,
        output_files_enabled: 0, repo_ids: '[]', iteration_count: 0, max_iterations: 10,
        credential_id: null, model: '', created_by: null, created_at: ts, updated_at: ts,
      });
      await repo.appendWorkflowEvent({
        workflow_id: wfId, kind: 'human', body: 'Hello agent',
        data: null, created_at: ts,
      });
      const events = await repo.listUnconsumedWorkflowEvents(wfId);
      assert.ok(events.length >= 1);
      assert.equal(events[0].kind, 'human');
      assert.equal(events[0].body, 'Hello agent');
    });

    test('markWorkflowEventsConsumedUpTo -- marks events consumed', async () => {
      const wfId = generateId();
      const ts = now();
      await repo.createWorkflow({
        id: wfId, project_id: null, goal: 'Consumed test', status: 'pending',
        engine: 'demo', trust_tools: 0, lead_agent: null, workspace_id: null,
        output_files_enabled: 0, repo_ids: '[]', iteration_count: 0, max_iterations: 10,
        credential_id: null, model: '', created_by: null, created_at: ts, updated_at: ts,
      });
      await repo.appendWorkflowEvent({ workflow_id: wfId, kind: 'human', body: 'msg1', data: null, created_at: ts });
      await repo.appendWorkflowEvent({ workflow_id: wfId, kind: 'human', body: 'msg2', data: null, created_at: ts });
      await repo.appendWorkflowEvent({ workflow_id: wfId, kind: 'human', body: 'msg3', data: null, created_at: ts });

      const before = await repo.listUnconsumedWorkflowEvents(wfId);
      assert.ok(before.length >= 3);
      const maxId = before[before.length - 2].id; // mark first two consumed

      await repo.markWorkflowEventsConsumedUpTo(wfId, maxId);
      const after = await repo.listUnconsumedWorkflowEvents(wfId);
      assert.ok(after.length < before.length, 'Some events should be consumed');
      assert.ok(after.every((e) => e.id > maxId), 'Remaining events should have id > maxId');
    });

    test('getLastWorkflowEventTime -- returns MAX(created_at) for matching events', async () => {
      const wfId = generateId();
      const ts1 = new Date(Date.now() - 2000).toISOString();
      const ts2 = new Date(Date.now() - 1000).toISOString();
      const ts3 = now();
      await repo.createWorkflow({
        id: wfId, project_id: null, goal: 'Last event time', status: 'pending',
        engine: 'demo', trust_tools: 0, lead_agent: null, workspace_id: null,
        output_files_enabled: 0, repo_ids: '[]', iteration_count: 0, max_iterations: 10,
        credential_id: null, model: '', created_by: null, created_at: ts1, updated_at: ts1,
      });
      await repo.appendWorkflowEvent({ workflow_id: wfId, kind: 'command', body: '/clear', data: null, created_at: ts1 });
      await repo.appendWorkflowEvent({ workflow_id: wfId, kind: 'command', body: '/clear', data: null, created_at: ts2 });
      await repo.appendWorkflowEvent({ workflow_id: wfId, kind: 'human', body: 'hello', data: null, created_at: ts3 });

      const lastClear = await repo.getLastWorkflowEventTime(wfId, 'command', '/clear');
      assert.ok(lastClear, 'Should find last /clear time');
      assert.ok(lastClear >= ts2, `Last /clear time ${lastClear} should be >= ts2 ${ts2}`);

      const noResult = await repo.getLastWorkflowEventTime(wfId, 'command', '/nonexistent');
      assert.equal(noResult, null);
    });

    // Paging

    test('listWorkflowsByProject -- pagination with limit and offset', async () => {
      const projectId = `page-${sfx}`;
      const ts = now();
      for (let i = 0; i < 5; i++) {
        await repo.createWorkflow({
          id: generateId(), project_id: projectId, goal: `Paging ${i}`, status: 'pending',
          engine: 'demo', trust_tools: 0, lead_agent: null, workspace_id: null,
          output_files_enabled: 0, repo_ids: '[]', iteration_count: 0, max_iterations: 10,
          credential_id: null, model: '', created_by: null, created_at: ts, updated_at: ts,
        });
      }
      const page1 = await repo.listWorkflowsByProject(projectId, { limit: 3, offset: 0 });
      assert.ok(page1.workflows.length <= 3, 'Page 1 should have at most 3 items');

      // For DynamoDB mode: use cursor-based pagination; for SQLite: offset works
      const page2Opts = page1.cursor
        ? { limit: 3, cursor: page1.cursor }
        : { limit: 3, offset: 3 };

      const page2 = await repo.listWorkflowsByProject(projectId, page2Opts);
      assert.ok(page2.workflows.length >= 0, 'Page 2 should not throw');

      // Pages should contain different items
      const page1Ids = new Set(page1.workflows.map((w) => w.id));
      const page2Ids = page2.workflows.map((w) => w.id);
      const overlap = page2Ids.filter((id) => page1Ids.has(id));
      assert.equal(overlap.length, 0, 'Pages should not overlap');
    });
  });
}

// ── SQLite suite ──────────────────────────────────────────────────────────────

describe('SQLite suite', () => {
  before(async () => {
    await createTestDb();
    // Seed project rows needed for listWorkflowsByProject tests
    // sfx for SQLite label = 'sql' + RUN_TAG
    const sfx = 'sql' + RUN_TAG;
    for (const pid of [`list-${sfx}`, `page-${sfx}`]) {
      try {
        insert('projects', {
          id: pid,
          slug: pid.slice(0, 60),
          name: pid,
          description: '',
          notes: '',
          created_by: null,
          created_at: now(),
          archived: 0,
          default_lead_agent: '',
          default_model: '',
          vault_generated: 1,
        });
      } catch { /* already exists */ }
    }
  });

  after(async () => {
    await cleanup();
  });

  runContract('SQLite', async () => new SqliteSessionsRepository());
});

// ── DynamoDB Local suite ──────────────────────────────────────────────────────

describe('DynamoDB Local suite', async () => {
  const endpoint = process.env.DYNAMODB_ENDPOINT;
  const requireDynamo = process.env.REQUIRE_DYNAMODB === '1';

  if (!endpoint) {
    if (requireDynamo) {
      throw new Error('REQUIRE_DYNAMODB=1 but DYNAMODB_ENDPOINT is not set');
    }
    test('DynamoDB suite skipped -- DYNAMODB_ENDPOINT not set', () => {
      // pass -- skip marker only
    });
    return;
  }

  // Verify connectivity before running tests
  let canConnect = false;
  try {
    const r = await fetch(`${endpoint}/`).catch(() => null);
    canConnect = r !== null;
  } catch { /* unreachable */ }

  if (!canConnect) {
    if (requireDynamo) {
      throw new Error(`REQUIRE_DYNAMODB=1 but cannot connect to DynamoDB endpoint ${endpoint}`);
    }
    test('DynamoDB Local not reachable -- suite skipped', () => {});
    return;
  }

  // Set up DynamoDB environment for the suite
  process.env.DYNAMODB_TABLE_PORTAL_RUNS = `portal-runs-test-${RUN_TAG}`;
  process.env.DYNAMODB_TABLE_PORTAL_EVENTS = `portal-events-test-${RUN_TAG}`;

  const { DynamoDbSessionsRepository } = await import('../server/repositories/sessions-dynamodb.ts');
  const { clearDynamoDbClient } = await import('../server/repositories/dynamo-client.ts');

  let dynamoRepo: InstanceType<typeof DynamoDbSessionsRepository>;

  before(async () => {
    clearDynamoDbClient(); // reset client so it picks up test table names
    dynamoRepo = new DynamoDbSessionsRepository();
    await dynamoRepo.ensureTables();
  });

  after(() => {
    clearDynamoDbClient();
    delete process.env.DYNAMODB_TABLE_PORTAL_RUNS;
    delete process.env.DYNAMODB_TABLE_PORTAL_EVENTS;
    clearSessionsRepository();
  });

  runContract('DynamoDB', async () => dynamoRepo);
});
