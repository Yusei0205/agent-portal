/**
 * createReview(): called directly (no HTTP), as automatic pull requests will.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup } from './fixtures.ts';
import { createReview, ReviewCreateError } from '../server/review.ts';
import { run } from '../server/db.ts';
import { generateId, now } from '../server/util.ts';
import { getSessionsRepository } from '../server/repositories/sessions.ts';
import { getReviewsRepository } from '../server/repositories/reviews.ts';

function insertProject(): string {
  const id = generateId();
  run(
    `INSERT INTO projects (id, slug, name, description, notes, created_at) VALUES (?,?,?,?,?,?)`,
    id, `rc-${Date.now()}-${Math.random().toString(36).slice(2)}`, 'Create Review Project', '', '', now(),
  );
  return id;
}

function insertRepo(projectId: string): string {
  const id = generateId();
  run(
    `INSERT INTO repositories (id, project_id, name, url, provider, status, created_at) VALUES (?,?,?,?,?,?,?)`,
    id, projectId, 'rc-repo', 'https://example.com/o/rc-repo.git', 'other', 'ready', now(),
  );
  return id;
}

describe('createReview', () => {
  let projectId: string;
  let repoId: string;
  const userId = generateId();

  before(async () => {
    await createTestServer();
    run('INSERT INTO users (id, email, name, password_hash, is_admin, disabled, created_at) VALUES (?,?,?,?,0,0,?)',
      userId, `${userId}@example.com`, 'U', 'x', now());
    projectId = insertProject();
    repoId = insertRepo(projectId);
  });

  after(async () => { await cleanup(); });

  it('starts the session of a new review, and asks the reviewer for a findings report', async () => {
    const review = await createReview({ projectId, userId, repoId, baseRef: 'main', headRef: 'feature/starts', prNumber: 7 });
    const workflowId = String(review.workflow_id);
    const wf = await getSessionsRepository().getWorkflowById(workflowId);
    assert.match(String(wf?.goal), /End your reply with one JSON block/, 'the goal asks for the report the portal reads');
    assert.equal(wf?.kind, 'review');
    const runs = await getSessionsRepository().listRunsByWorkflow(workflowId);
    assert.equal(runs.length, 1, 'a run was started, so the session is not left pending with nothing running');
    // The run reports back and the review moves on from "pending".
    let seen = review.status;
    for (let i = 0; i < 100 && (seen === 'pending' || seen === 'running'); i++) {
      await new Promise((r) => setTimeout(r, 50));
      seen = String((await getReviewsRepository().getById(review.id))?.status);
    }
    assert.notEqual(seen, 'pending', 'the review moved on once its run finished');
  });

  it('creates a review with repository, PR number and Jira key', async () => {
    const review = await createReview({
      projectId, userId, repoId,
      baseRef: 'main', headRef: 'feature/x', prNumber: 42, jiraKey: 'ABC-123',
      postMode: 'draft', sourceSha: 'a'.repeat(40), destSha: 'b'.repeat(40),
    });
    assert.equal(review.project_id, projectId);
    assert.equal(review.repo_id, repoId);
    assert.equal(review.pr_number, 42);
    assert.equal(review.base_ref, 'main');
    assert.equal(review.head_ref, 'feature/x');
    assert.equal(review.post_mode, 'draft');
    assert.equal(review.status, 'pending');
    assert.equal(review.created_by, userId);
    assert.equal(review.head_commit_sha, 'a'.repeat(40));
    assert.equal(JSON.parse(review.jira_context as string).key, 'ABC-123');
    assert.ok(review.workflow_id);
  });

  it('throws ReviewCreateError 400 when baseRef is missing', async () => {
    await assert.rejects(
      createReview({ projectId, userId: 'u', baseRef: '', headRef: 'h' }),
      (e: unknown) => e instanceof ReviewCreateError && e.status === 400 && e.message === 'baseRef is required',
    );
  });

  it('throws ReviewCreateError 400 for a repository of another project', async () => {
    const otherRepo = insertRepo(insertProject());
    await assert.rejects(
      createReview({ projectId, userId: 'u', repoId: otherRepo, baseRef: 'main', headRef: 'h' }),
      (e: unknown) => e instanceof ReviewCreateError && e.status === 400
        && e.message === 'That repository belongs to another project',
    );
  });
});
