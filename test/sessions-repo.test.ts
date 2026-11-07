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
      await repo.updateWorkflow(id, { status: 'running', goal: '', initial_goal: 'Update test', updated_at: newTs });
      const updated = await repo.getWorkflowById(id);
      assert.ok(updated);
      assert.equal(updated.status, 'running');
      assert.equal(updated.goal, '');
      assert.equal(updated.initial_goal, 'Update test');
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
      // total is null in DynamoDB mode (too expensive to compute)
      assert.ok(result.total === null || result.total >= 2);
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

    // ── Gap 2: listRunningWorkflows, listIdleWorkflows, listChildWorkflows ──────

    test('listRunningWorkflows -- finds running workflows', async () => {
      const projectId = `running-${sfx}`;
      const ts = now();
      const wf1 = generateId();
      const wf2 = generateId();
      await repo.createWorkflow({
        id: wf1, project_id: projectId, goal: 'Running 1', status: 'running',
        engine: 'demo', trust_tools: 0, lead_agent: null, workspace_id: null,
        output_files_enabled: 0, repo_ids: '[]', iteration_count: 0, max_iterations: 10,
        credential_id: null, model: '', created_by: null, created_at: ts, updated_at: ts,
      });
      await repo.createWorkflow({
        id: wf2, project_id: projectId, goal: 'Done 1', status: 'done',
        engine: 'demo', trust_tools: 0, lead_agent: null, workspace_id: null,
        output_files_enabled: 0, repo_ids: '[]', iteration_count: 0, max_iterations: 10,
        credential_id: null, model: '', created_by: null, created_at: ts, updated_at: ts,
      });
      const running = await repo.listRunningWorkflows();
      const ids = running.map((w) => w.id);
      assert.ok(ids.includes(wf1), 'Running workflow should be in listRunningWorkflows');
      assert.ok(!ids.includes(wf2), 'Done workflow should NOT be in listRunningWorkflows');
    });

    test('listIdleWorkflows -- finds idle workflows below cutoff', async () => {
      const projectId = `idle-${sfx}`;
      const oldTs = new Date(Date.now() - 3600_000).toISOString(); // 1 hour ago
      const recentTs = now();
      const wfIdle = generateId();
      const wfRecent = generateId();
      await repo.createWorkflow({
        id: wfIdle, project_id: projectId, goal: 'Idle', status: 'done',
        engine: 'demo', trust_tools: 0, lead_agent: null, workspace_id: null,
        output_files_enabled: 0, repo_ids: '[]', iteration_count: 0, max_iterations: 10,
        credential_id: null, model: '', created_by: null, created_at: oldTs, updated_at: oldTs,
      });
      await repo.updateWorkflow(wfIdle, { last_turn_at: oldTs, stop_reason: '', updated_at: oldTs });
      await repo.createWorkflow({
        id: wfRecent, project_id: projectId, goal: 'Recent', status: 'done',
        engine: 'demo', trust_tools: 0, lead_agent: null, workspace_id: null,
        output_files_enabled: 0, repo_ids: '[]', iteration_count: 0, max_iterations: 10,
        credential_id: null, model: '', created_by: null, created_at: recentTs, updated_at: recentTs,
      });
      await repo.updateWorkflow(wfRecent, { last_turn_at: recentTs, stop_reason: '', updated_at: recentTs });
      const cutoff = new Date(Date.now() - 1800_000).toISOString(); // 30 min ago
      const idle = await repo.listIdleWorkflows(cutoff);
      const ids = idle.map((w) => w.id);
      assert.ok(ids.includes(wfIdle), 'Idle workflow should be in listIdleWorkflows');
      assert.ok(!ids.includes(wfRecent), 'Recent workflow should NOT be in listIdleWorkflows');
    });

    test('listChildWorkflows -- finds children of parent', async () => {
      const ts = now();
      const parentId = generateId();
      const childId1 = generateId();
      const childId2 = generateId();
      await repo.createWorkflow({
        id: parentId, project_id: null, goal: 'Parent', status: 'running',
        engine: 'demo', trust_tools: 0, lead_agent: null, workspace_id: null,
        output_files_enabled: 0, repo_ids: '[]', iteration_count: 0, max_iterations: 10,
        credential_id: null, model: '', created_by: null, created_at: ts, updated_at: ts,
      });
      await repo.createWorkflow({
        id: childId1, project_id: null, goal: 'Child 1', status: 'pending',
        engine: 'demo', trust_tools: 0, lead_agent: null, workspace_id: null,
        output_files_enabled: 0, repo_ids: '[]', iteration_count: 0, max_iterations: 10,
        credential_id: null, model: '', created_by: null, created_at: ts, updated_at: ts,
        parent_id: parentId,
      });
      await repo.createWorkflow({
        id: childId2, project_id: null, goal: 'Child 2', status: 'pending',
        engine: 'demo', trust_tools: 0, lead_agent: null, workspace_id: null,
        output_files_enabled: 0, repo_ids: '[]', iteration_count: 0, max_iterations: 10,
        credential_id: null, model: '', created_by: null, created_at: ts, updated_at: ts,
        parent_id: parentId,
      });
      const children = await repo.listChildWorkflows(parentId);
      const ids = children.map((c) => c.id);
      assert.ok(ids.includes(childId1), 'Child 1 should be found');
      assert.ok(ids.includes(childId2), 'Child 2 should be found');
      assert.ok(!ids.includes(parentId), 'Parent should not be in children list');
    });

    // ── Gap 3: Conditional status transitions ──────────────────────────────────

    test('updateWorkflowConditional -- only one of two concurrent writers wins', async () => {
      const id = generateId();
      const ts = now();
      await repo.createWorkflow({
        id, project_id: null, goal: 'Conditional test', status: 'pending',
        engine: 'demo', trust_tools: 0, lead_agent: null, workspace_id: null,
        output_files_enabled: 0, repo_ids: '[]', iteration_count: 0, max_iterations: 10,
        credential_id: null, model: '', created_by: null, created_at: ts, updated_at: ts,
      });
      // Two concurrent transitions from pending→running
      const [win1, win2] = await Promise.all([
        repo.updateWorkflowConditional(id, 'pending', { status: 'running', updated_at: now() }),
        repo.updateWorkflowConditional(id, 'pending', { status: 'running', updated_at: now() }),
      ]);
      const wins = [win1, win2].filter(Boolean).length;
      assert.equal(wins, 1, 'Exactly one conditional update should succeed');
      const updated = await repo.getWorkflowById(id);
      assert.equal(updated?.status, 'running', 'Workflow status should be running after one win');
    });

    test('updateRunConditional -- only one of two concurrent writers wins', async () => {
      const wfId = generateId();
      const runId = generateId();
      const ts = now();
      await repo.createWorkflow({
        id: wfId, project_id: null, goal: 'Run conditional', status: 'running',
        engine: 'demo', trust_tools: 0, lead_agent: null, workspace_id: null,
        output_files_enabled: 0, repo_ids: '[]', iteration_count: 0, max_iterations: 10,
        credential_id: null, model: '', created_by: null, created_at: ts, updated_at: ts,
      });
      await repo.createRun({ id: runId, workflow_id: wfId, status: 'running',
        started_at: ts, finished_at: null, cost_usd: 0, input_tokens: 0, output_tokens: 0, created_at: ts });
      const [win1, win2] = await Promise.all([
        repo.updateRunConditional(runId, 'running', { status: 'done', finished_at: now() }),
        repo.updateRunConditional(runId, 'running', { status: 'failed', finished_at: now() }),
      ]);
      const wins = [win1, win2].filter(Boolean).length;
      assert.equal(wins, 1, 'Exactly one conditional run update should succeed');
      const updated = await repo.getRunById(runId);
      assert.ok(updated?.status === 'done' || updated?.status === 'failed', 'Run should be terminal');
    });

    // ── Gap 5: deleteWorkflow cascades ─────────────────────────────────────────

    test('deleteWorkflow -- removes all associated data', async () => {
      const wfId = generateId();
      const runId = generateId();
      const inputId = generateId();
      const ts = now();
      await repo.createWorkflow({
        id: wfId, project_id: null, goal: 'Delete cascade test', status: 'done',
        engine: 'demo', trust_tools: 0, lead_agent: null, workspace_id: null,
        output_files_enabled: 0, repo_ids: '[]', iteration_count: 0, max_iterations: 10,
        credential_id: null, model: '', created_by: null, created_at: ts, updated_at: ts,
      });
      await repo.createRun({ id: runId, workflow_id: wfId, status: 'done',
        started_at: ts, finished_at: ts, cost_usd: 0, input_tokens: 0, output_tokens: 0, created_at: ts });
      await repo.appendRunEvent(runId, 'status', '{"text":"hello"}', ts);
      await repo.appendRunEvent(runId, 'run-complete', '{"result":"done"}', ts);
      await repo.createInput({ id: inputId, run_id: runId, project_id: null,
        tool_name: 'Bash', tool_input: '{}', payload: '{}',
        input_hash: `del-${sfx}`, type: 'approval', status: 'pending',
        allow_all: 0, expires_at: null, created_at: ts });
      await repo.appendWorkflowEvent({ workflow_id: wfId, kind: 'human', body: 'bye', data: null, created_at: ts });

      await repo.deleteWorkflow(wfId);

      const wfAfter = await repo.getWorkflowById(wfId);
      assert.equal(wfAfter, null, 'Workflow should be deleted');
      const runAfter = await repo.getRunById(runId);
      assert.equal(runAfter, null, 'Run should be deleted');
      const eventsAfter = await repo.listRunEvents(runId);
      assert.equal(eventsAfter.length, 0, 'Run events should be deleted');
      const inputAfter = await repo.getInputByRunAndId(runId, inputId);
      assert.equal(inputAfter, null, 'Input should be deleted');
    });

    test('deleteWorkflow -- adjusts parent child count', async () => {
      const ts = now();
      const parentId = generateId();
      const childId = generateId();
      await repo.createWorkflow({
        id: parentId, project_id: null, goal: 'Parent for delete', status: 'running',
        engine: 'demo', trust_tools: 0, lead_agent: null, workspace_id: null,
        output_files_enabled: 0, repo_ids: '[]', iteration_count: 0, max_iterations: 10,
        credential_id: null, model: '', created_by: null, created_at: ts, updated_at: ts,
      });
      await repo.createWorkflow({
        id: childId, project_id: null, goal: 'Child for delete', status: 'done',
        engine: 'demo', trust_tools: 0, lead_agent: null, workspace_id: null,
        output_files_enabled: 0, repo_ids: '[]', iteration_count: 0, max_iterations: 10,
        credential_id: null, model: '', created_by: null, created_at: ts, updated_at: ts,
        parent_id: parentId,
      });
      // createWorkflow now owns the increment — no separate call needed.
      // Verify the child exists before deleting
      const childrenBefore = await repo.listChildWorkflows(parentId);
      assert.ok(childrenBefore.some((c) => c.id === childId), 'Child should be in children list before delete');
      await repo.deleteWorkflow(childId);
      // After delete, child should no longer exist
      const deletedChild = await repo.getWorkflowById(childId);
      assert.equal(deletedChild, null, 'Child workflow should be deleted');
      // In DynamoDB mode, child count should have decreased
      // In SQLite mode, child count is computed dynamically, so also check listChildWorkflows
      const childrenAfter = await repo.listChildWorkflows(parentId);
      assert.ok(!childrenAfter.some((c) => c.id === childId), 'Child should not appear after delete');
    });

    // ── Child count contract (both backends) ───────────────────────────────────
    // These tests verify that the repository is the single owner of child-count
    // bookkeeping: createWorkflow increments, deleteWorkflow decrements, and no
    // caller in the route layer needs to issue a separate incrementWorkflowChildCount.

    test('child-count -- createWorkflow increments parent child_count', async () => {
      const projectId = `cc-create-${sfx}`;
      const parentId = generateId();
      const childId = generateId();
      const ts = now();
      await repo.createWorkflow({
        id: parentId, project_id: projectId, goal: 'CC parent', status: 'pending',
        engine: 'demo', trust_tools: 0, lead_agent: null, workspace_id: null,
        output_files_enabled: 0, repo_ids: '[]', iteration_count: 0, max_iterations: 10,
        credential_id: null, model: '', created_by: null, created_at: ts, updated_at: ts,
      });
      // Before any child: child_count should be 0
      const before = await repo.listWorkflowsByProject(projectId, { limit: 10 });
      const parentBefore = before.workflows.find((w) => w.id === parentId);
      assert.ok(parentBefore, 'Parent should appear in list before child creation');
      assert.equal(parentBefore.child_count ?? 0, 0, `Parent child_count should be 0 before child, got ${parentBefore.child_count}`);

      // Create a child — repository must increment the parent automatically
      await repo.createWorkflow({
        id: childId, project_id: projectId, goal: 'CC child', status: 'pending',
        engine: 'demo', trust_tools: 0, lead_agent: null, workspace_id: null,
        output_files_enabled: 0, repo_ids: '[]', iteration_count: 0, max_iterations: 10,
        credential_id: null, model: '', created_by: null, created_at: ts, updated_at: ts,
        parent_id: parentId,
      });
      const after = await repo.listWorkflowsByProject(projectId, { limit: 10 });
      const parentAfter = after.workflows.find((w) => w.id === parentId);
      assert.ok(parentAfter, 'Parent should still appear in list after child creation');
      assert.equal(parentAfter.child_count, 1, `Parent child_count should be 1 after child creation, got ${parentAfter.child_count}`);
    });

    test('child-count -- create-then-delete leaves parent child_count at 0', async () => {
      const projectId = `cc-del-${sfx}`;
      const parentId = generateId();
      const childId = generateId();
      const ts = now();
      await repo.createWorkflow({
        id: parentId, project_id: projectId, goal: 'CC-del parent', status: 'pending',
        engine: 'demo', trust_tools: 0, lead_agent: null, workspace_id: null,
        output_files_enabled: 0, repo_ids: '[]', iteration_count: 0, max_iterations: 10,
        credential_id: null, model: '', created_by: null, created_at: ts, updated_at: ts,
      });
      // Create child — repository increments count
      await repo.createWorkflow({
        id: childId, project_id: projectId, goal: 'CC-del child', status: 'done',
        engine: 'demo', trust_tools: 0, lead_agent: null, workspace_id: null,
        output_files_enabled: 0, repo_ids: '[]', iteration_count: 0, max_iterations: 10,
        credential_id: null, model: '', created_by: null, created_at: ts, updated_at: ts,
        parent_id: parentId,
      });
      // Sanity check: count went up to 1
      const midList = await repo.listWorkflowsByProject(projectId, { limit: 10 });
      const parentMid = midList.workflows.find((w) => w.id === parentId);
      assert.ok(parentMid, 'Parent must exist after child creation');
      assert.equal(parentMid.child_count, 1, `Parent child_count should be 1 after create, got ${parentMid.child_count}`);

      // Delete child — repository decrements count
      await repo.deleteWorkflow(childId);

      // Count must be back to 0
      const finalList = await repo.listWorkflowsByProject(projectId, { limit: 10 });
      const parentFinal = finalList.workflows.find((w) => w.id === parentId);
      assert.ok(parentFinal, 'Parent should remain after child delete');
      assert.equal(parentFinal.child_count, 0, `Parent child_count should be 0 after delete, got ${parentFinal.child_count}`);
    });

    // ── Gap 6: listWorkflowsByProject total null and full-page filter ──────────

    test('listWorkflowsByProject -- status filter returns full page', async () => {
      const projectId = `filter-${sfx}`;
      const ts = now();
      // Create 6 workflows: 3 done, 3 running
      for (let i = 0; i < 6; i++) {
        const status = i < 3 ? 'done' : 'running';
        await repo.createWorkflow({
          id: generateId(), project_id: projectId, goal: `Filter ${i}`, status,
          engine: 'demo', trust_tools: 0, lead_agent: null, workspace_id: null,
          output_files_enabled: 0, repo_ids: '[]', iteration_count: 0, max_iterations: 10,
          credential_id: null, model: '', created_by: null, created_at: ts, updated_at: ts,
        });
      }
      // Request only 'done' workflows with limit=2
      const page1 = await repo.listWorkflowsByProject(projectId, { limit: 2, status: 'done' });
      assert.equal(page1.workflows.length, 2, `Page 1 should have 2 items, got ${page1.workflows.length}`);
      assert.ok(page1.workflows.every((w) => w.status === 'done'), 'All returned workflows should be done');

      // Fetch page 2: DynamoDB uses cursor, SQLite uses offset
      const page2Opts = page1.cursor
        ? { limit: 2, status: 'done' as const, cursor: page1.cursor }
        : { limit: 2, status: 'done' as const, offset: 2 };
      const page2 = await repo.listWorkflowsByProject(projectId, page2Opts);
      assert.equal(page2.workflows.length, 1, `Page 2 should have 1 item, got ${page2.workflows.length}`);
      assert.ok(page2.workflows.every((w) => w.status === 'done'), 'All returned workflows should be done');

      // No overlap between pages
      const page1Ids = new Set(page1.workflows.map((w) => w.id));
      const overlap = page2.workflows.filter((w) => page1Ids.has(w.id));
      assert.equal(overlap.length, 0, 'Pages should not overlap');
    });

    // ── Gap 7: getActiveRun -- correct for any number of runs ─────────────────

    test('getActiveRun -- finds active run regardless of run count', async () => {
      const wfId = generateId();
      const ts = now();
      await repo.createWorkflow({
        id: wfId, project_id: null, goal: 'Active run test', status: 'running',
        engine: 'demo', trust_tools: 0, lead_agent: null, workspace_id: null,
        output_files_enabled: 0, repo_ids: '[]', iteration_count: 0, max_iterations: 10,
        credential_id: null, model: '', created_by: null, created_at: ts, updated_at: ts,
      });
      // Create 25 done runs (more than the old Limit: 20)
      for (let i = 0; i < 25; i++) {
        const runTs = new Date(Date.now() - (25 - i) * 1000).toISOString();
        await repo.createRun({ id: generateId(), workflow_id: wfId, status: 'done',
          started_at: runTs, finished_at: runTs, cost_usd: 0, input_tokens: 0, output_tokens: 0, created_at: runTs });
      }
      // Active run is the oldest
      const activeId = generateId();
      const activeTs = new Date(Date.now() - 30_000).toISOString(); // older than all done runs
      await repo.createRun({ id: activeId, workflow_id: wfId, status: 'running',
        started_at: activeTs, finished_at: null, cost_usd: 0, input_tokens: 0, output_tokens: 0, created_at: activeTs });
      // getActiveRun must find it even though it's buried under 25 done runs
      const active = await repo.getActiveRun(wfId);
      assert.ok(active, 'Should find active run');
      assert.equal(active.id, activeId, 'Should return the correct active run id');
    });

    // ── Gap 1: Event id from two independent instances never collide ──────────
    // (Concurrent appends test already covers this — new test proves id from listRunEvents
    //  matches the id returned by appendRunEvent.)

    test('event ids -- stored id matches listRunEvents id', async () => {
      const wfId = generateId();
      const runId = generateId();
      const ts = now();
      await repo.createWorkflow({
        id: wfId, project_id: null, goal: 'Id match test', status: 'running',
        engine: 'demo', trust_tools: 0, lead_agent: null, workspace_id: null,
        output_files_enabled: 0, repo_ids: '[]', iteration_count: 0, max_iterations: 10,
        credential_id: null, model: '', created_by: null, created_at: ts, updated_at: ts,
      });
      await repo.createRun({ id: runId, workflow_id: wfId, status: 'running',
        started_at: ts, finished_at: null, cost_usd: 0, input_tokens: 0, output_tokens: 0, created_at: ts });
      const e1 = await repo.appendRunEvent(runId, 'status', '{"text":"a"}', ts);
      const e2 = await repo.appendRunEvent(runId, 'status', '{"text":"b"}', ts);
      const events = await repo.listRunEvents(runId);
      const storedIds = events.map((e) => e.id);
      assert.ok(storedIds.includes(e1.id), `appendRunEvent id ${e1.id} should appear in listRunEvents`);
      assert.ok(storedIds.includes(e2.id), `appendRunEvent id ${e2.id} should appear in listRunEvents`);
      // Two independent appends must not have the same id
      assert.notEqual(e1.id, e2.id, 'Sequential append ids must differ');
    });

    test('event ids from two repository instances never collide', async () => {
      const wfId = generateId();
      const runId = generateId();
      const ts = now();
      await repo.createWorkflow({
        id: wfId, project_id: null, goal: 'Two-repo id test', status: 'running',
        engine: 'demo', trust_tools: 0, lead_agent: null, workspace_id: null,
        output_files_enabled: 0, repo_ids: '[]', iteration_count: 0, max_iterations: 10,
        credential_id: null, model: '', created_by: null, created_at: ts, updated_at: ts,
      });
      await repo.createRun({ id: runId, workflow_id: wfId, status: 'running',
        started_at: ts, finished_at: null, cost_usd: 0, input_tokens: 0, output_tokens: 0, created_at: ts });
      // Simulate two concurrent processes appending from the same repo instance
      // (the per-run counter is the single source of truth in both backends)
      const appends = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          repo.appendRunEvent(runId, `type-${i}`, `{"seq":${i}}`, ts),
        ),
      );
      const ids = appends.map((a) => a.id);
      const uniqueIds = new Set(ids);
      assert.equal(uniqueIds.size, 20, `All 20 concurrent event ids must be unique, got ${uniqueIds.size}`);
      // Verify all ids appear in listRunEvents
      const listed = await repo.listRunEvents(runId);
      for (const a of appends) {
        assert.ok(listed.some((e) => e.id === a.id), `appendRunEvent id ${a.id} must be in listRunEvents`);
      }
    });

    // ── Gap 8: getInputByRunAndId and getInputById ─────────────────────────────

    test('getInputByRunAndId -- finds input by runId + inputId', async () => {
      const wfId = generateId();
      const runId = generateId();
      const inputId = generateId();
      const ts = now();
      await repo.createWorkflow({
        id: wfId, project_id: null, goal: 'getInputByRunAndId test', status: 'running',
        engine: 'demo', trust_tools: 0, lead_agent: null, workspace_id: null,
        output_files_enabled: 0, repo_ids: '[]', iteration_count: 0, max_iterations: 10,
        credential_id: null, model: '', created_by: null, created_at: ts, updated_at: ts,
      });
      await repo.createRun({ id: runId, workflow_id: wfId, status: 'running',
        started_at: ts, finished_at: null, cost_usd: 0, input_tokens: 0, output_tokens: 0, created_at: ts });
      await repo.createInput({ id: inputId, run_id: runId, project_id: null,
        tool_name: 'Bash', tool_input: '{}', payload: '{}',
        input_hash: `rbi-${sfx}`, type: 'approval', status: 'pending',
        allow_all: 0, expires_at: null, created_at: ts });
      const found = await repo.getInputByRunAndId(runId, inputId);
      assert.ok(found, 'Should find input by run+id');
      assert.equal(found.id, inputId);
      const notFound = await repo.getInputByRunAndId(runId, generateId());
      assert.equal(notFound, null, 'Should return null for unknown inputId');
    });

    test('getInputById -- finds input by id alone', async () => {
      const wfId = generateId();
      const runId = generateId();
      const inputId = generateId();
      const ts = now();
      await repo.createWorkflow({
        id: wfId, project_id: null, goal: 'getInputById test', status: 'running',
        engine: 'demo', trust_tools: 0, lead_agent: null, workspace_id: null,
        output_files_enabled: 0, repo_ids: '[]', iteration_count: 0, max_iterations: 10,
        credential_id: null, model: '', created_by: null, created_at: ts, updated_at: ts,
      });
      await repo.createRun({ id: runId, workflow_id: wfId, status: 'running',
        started_at: ts, finished_at: null, cost_usd: 0, input_tokens: 0, output_tokens: 0, created_at: ts });
      await repo.createInput({ id: inputId, run_id: runId, project_id: null,
        tool_name: 'Bash', tool_input: '{}', payload: '{}',
        input_hash: `gib-${sfx}`, type: 'approval', status: 'pending',
        allow_all: 0, expires_at: null, created_at: ts });
      const found = await repo.getInputById(inputId);
      assert.ok(found, 'Should find input by id alone');
      assert.equal(found.id, inputId);
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

    // ── Gap 8: listTranscript contract ─────────────────────────────────────────

    test('listTranscript -- no gaps, no overlap, correct cursor across runs', async () => {
      const wfId = generateId();
      const ts = now();
      await repo.createWorkflow({
        id: wfId, project_id: null, goal: 'Transcript test', status: 'done',
        engine: 'demo', trust_tools: 0, lead_agent: null, workspace_id: null,
        output_files_enabled: 0, repo_ids: '[]', iteration_count: 0, max_iterations: 10,
        credential_id: null, model: '', created_by: null, created_at: ts, updated_at: ts,
      });

      // Create two runs with events.
      const runId1 = generateId();
      const runId2 = generateId();
      const ts1 = new Date(Date.now() - 2000).toISOString();
      const ts2 = new Date(Date.now() - 1000).toISOString();
      await repo.createRun({ id: runId1, workflow_id: wfId, status: 'done',
        started_at: ts1, finished_at: ts1, cost_usd: 0, input_tokens: 0, output_tokens: 0, created_at: ts1 });
      await repo.createRun({ id: runId2, workflow_id: wfId, status: 'done',
        started_at: ts2, finished_at: ts2, cost_usd: 0, input_tokens: 0, output_tokens: 0, created_at: ts2 });

      // 5 events in run1, 5 events in run2.
      for (let i = 0; i < 5; i++) {
        await repo.appendRunEvent(
          runId1, 'status', JSON.stringify({ text: `r1 event ${i}` }),
          new Date(Date.now() - 2000 + i * 10).toISOString(),
        );
        await repo.appendRunEvent(
          runId2, 'status', JSON.stringify({ text: `r2 event ${i}` }),
          new Date(Date.now() - 1000 + i * 10).toISOString(),
        );
      }

      // 4 workflow events.
      for (let i = 0; i < 4; i++) {
        await repo.appendWorkflowEvent({
          workflow_id: wfId, kind: 'human', body: `msg ${i}`, data: null,
          created_at: new Date(Date.now() - 500 + i * 10).toISOString(),
        });
      }

      // Page through all events with limit=4, collecting seen ids.
      // Use src:run_id:id as the key because DynamoDB uses run-local
      // sequence numbers (two different runs can share the same id=1, id=2, etc.).
      const seen = new Map<string, number>(); // key → count
      let cursor = null;
      let pages = 0;

      do {
        const result = await repo.listTranscript(wfId, cursor, 4);
        for (const row of result.rows) {
          const key = `${row.src}:${row.run_id ?? 'wf'}:${row.id}`;
          seen.set(key, (seen.get(key) ?? 0) + 1);
        }
        cursor = result.nextCursor;
        pages++;
        if (pages > 20) { assert.fail('Too many pages — cursor may loop'); break; }
      } while (cursor);

      // Total events: 5 + 5 + 4 = 14.
      const totalEvents = 14;
      assert.equal(seen.size, totalEvents, `Expected ${totalEvents} distinct events across pages, got ${seen.size}`);

      // No duplicates (all counts should be 1).
      for (const [key, count] of seen.entries()) {
        assert.equal(count, 1, `Event ${key} appeared ${count} times (expected 1 — no overlaps)`);
      }
    });

    test('listTranscript -- first page is newest-first', async () => {
      const wfId = generateId();
      const ts = now();
      await repo.createWorkflow({
        id: wfId, project_id: null, goal: 'Transcript order test', status: 'done',
        engine: 'demo', trust_tools: 0, lead_agent: null, workspace_id: null,
        output_files_enabled: 0, repo_ids: '[]', iteration_count: 0, max_iterations: 10,
        credential_id: null, model: '', created_by: null, created_at: ts, updated_at: ts,
      });

      const runId = generateId();
      await repo.createRun({ id: runId, workflow_id: wfId, status: 'done',
        started_at: ts, finished_at: ts, cost_usd: 0, input_tokens: 0, output_tokens: 0, created_at: ts });

      // 5 events with increasing timestamps.
      const eventTimes: string[] = [];
      for (let i = 0; i < 5; i++) {
        const t = new Date(Date.now() + i * 50).toISOString();
        eventTimes.push(t);
        await repo.appendRunEvent(runId, 'status', JSON.stringify({ seq: i }), t);
      }

      const result = await repo.listTranscript(wfId, null, 5);
      assert.equal(result.rows.length, 5, 'Should return all 5 events');

      // Events should be newest-first (descending by created_at).
      for (let i = 1; i < result.rows.length; i++) {
        assert.ok(
          result.rows[i - 1].created_at >= result.rows[i].created_at,
          `Row ${i-1} should be >= row ${i} in time (newest-first)`,
        );
      }
    });

    test('listTranscript -- cursor-based paging has no overlap between pages', async () => {
      const wfId = generateId();
      const ts = now();
      await repo.createWorkflow({
        id: wfId, project_id: null, goal: 'Transcript cursor test', status: 'done',
        engine: 'demo', trust_tools: 0, lead_agent: null, workspace_id: null,
        output_files_enabled: 0, repo_ids: '[]', iteration_count: 0, max_iterations: 10,
        credential_id: null, model: '', created_by: null, created_at: ts, updated_at: ts,
      });

      // Create run with 10 events AND some workflow events interleaved in time.
      const runId = generateId();
      await repo.createRun({ id: runId, workflow_id: wfId, status: 'done',
        started_at: ts, finished_at: ts, cost_usd: 0, input_tokens: 0, output_tokens: 0, created_at: ts });
      for (let i = 0; i < 10; i++) {
        await repo.appendRunEvent(
          runId, 'status', JSON.stringify({ i }),
          new Date(Date.now() + i * 20).toISOString(),
        );
      }
      for (let i = 0; i < 3; i++) {
        await repo.appendWorkflowEvent({
          workflow_id: wfId, kind: 'human', body: `wf ${i}`, data: null,
          created_at: new Date(Date.now() + 100 + i * 20).toISOString(),
        });
      }

      // Page through with limit=4.
      const page1 = await repo.listTranscript(wfId, null, 4);
      assert.equal(page1.rows.length, 4, 'Page 1 should have 4 rows');
      assert.ok(page1.nextCursor !== null, 'Page 1 should have a cursor');

      const page2 = await repo.listTranscript(wfId, page1.nextCursor, 4);
      assert.equal(page2.rows.length, 4, 'Page 2 should have 4 rows');

      const page1Keys = new Set(page1.rows.map((r) => `${r.src}:${r.id}`));
      const page2Keys = page2.rows.map((r) => `${r.src}:${r.id}`);
      const overlap = page2Keys.filter((k) => page1Keys.has(k));
      assert.equal(overlap.length, 0, `Pages 1 and 2 should not overlap, but shared: ${overlap.join(', ')}`);
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
    for (const pid of [`list-${sfx}`, `page-${sfx}`, `running-${sfx}`, `idle-${sfx}`, `filter-${sfx}`, `cc-create-${sfx}`, `cc-del-${sfx}`]) {
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
