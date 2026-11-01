/**
 * Contract tests for ProjectRepository.
 *
 * The same assertions run against both SQLite and DynamoDB implementations.
 * DynamoDB suite runs only when DYNAMODB_ENDPOINT is set.
 * Set REQUIRE_DYNAMODB=1 to turn the skip into a failure.
 *
 * To run the DynamoDB suite locally:
 *   docker run -d --name ddb-local -p 8000:8000 amazon/dynamodb-local
 *   DYNAMODB_ENDPOINT=http://localhost:8000 REQUIRE_DYNAMODB=1 \
 *     npm run test:affected -- --module projects --backend-only
 *   docker stop ddb-local && docker rm ddb-local
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, cleanup } from './fixtures.ts';
import { SqliteProjectRepository } from '../server/repositories/projects-sqlite.ts';
import type { ProjectRepository } from '../server/repositories/projects.ts';
import { clearProjectRepository } from '../server/repositories/projects.ts';
import { SlugAlreadyTakenError } from '../server/repositories/projects.ts';
import { now, generateId } from '../server/util.ts';
import { insert } from '../server/db.ts';

// ── Per-run unique suffix ─────────────────────────────────────────────────────
// Prevents DynamoDB Local from hitting ConditionalCheckFailedException on re-runs.
const RUN_TAG = Date.now().toString(36).slice(-5);

// ── Shared test users ─────────────────────────────────────────────────────────

const USER_A = `proj-ua-${RUN_TAG}`;
const USER_B = `proj-ub-${RUN_TAG}`;
const USER_C = `proj-uc-${RUN_TAG}`;

// ── User seeding helpers ──────────────────────────────────────────────────────

function seedUsersSqlite(): void {
  for (const [id, email, name] of [
    [USER_A, `ua-${RUN_TAG}@test.com`, 'User A'],
    [USER_B, `ub-${RUN_TAG}@test.com`, 'User B'],
    [USER_C, `uc-${RUN_TAG}@test.com`, 'User C'],
  ]) {
    insert('users', {
      id, email, name,
      password_hash: 'x',
      is_admin: 0,
      disabled: 0,
      created_at: now(),
    });
  }
}

async function seedUsersDynamodb(
  authRepo: import('../server/repositories/auth.ts').AuthRepository,
): Promise<void> {
  const { generateId: gid, now: tsNow } = await import('../server/util.ts');
  for (const [id, email, name] of [
    [USER_A, `ua-${RUN_TAG}@test.com`, 'User A'],
    [USER_B, `ub-${RUN_TAG}@test.com`, 'User B'],
    [USER_C, `uc-${RUN_TAG}@test.com`, 'User C'],
  ]) {
    try {
      await authRepo.createUser({
        id, email, name,
        password_hash: 'x',
        is_admin: 0,
        disabled: 0,
        created_at: tsNow(),
      });
    } catch {
      // User may already exist from a previous run against the same DynamoDB Local instance
    }
  }
}

// ── Shared contract suite ─────────────────────────────────────────────────────

function runContract(
  label: string,
  makeRepo: () => Promise<ProjectRepository>,
  seedUsers: () => Promise<void>,
): void {
  describe(`${label} — ProjectRepository contract`, () => {
    let repo: ProjectRepository;
    const sfx = label.replace(/[^a-z0-9]/gi, '').slice(0, 3).toLowerCase() + RUN_TAG;

    before(async () => {
      repo = await makeRepo();
      await seedUsers();
    });

    after(() => {
      clearProjectRepository();
    });

    // ── Create / get ──────────────────────────────────────────────────────────

    test('create — stores and returns a project record', async () => {
      const id = generateId();
      const slug = `test-project-${sfx}-1`;
      const record = await repo.createProject({
        id,
        slug,
        name: `Test Project ${sfx}`,
        description: 'desc',
        notes: '',
        created_by: USER_A,
        created_at: now(),
        archived: 0,
        default_lead_agent: '',
        default_model: '',
        vault_generated: 1,
      });

      assert.equal(record.id, id);
      assert.equal(record.slug, slug);
      assert.equal(record.name, `Test Project ${sfx}`);
      assert.equal(record.archived, 0);
      assert.equal(record.vault_generated, 1);
    });

    test('getProjectById — returns null for unknown id', async () => {
      const result = await repo.getProjectById('no-such-project-00000');
      assert.equal(result, null);
    });

    test('getProjectById — returns the project when it exists', async () => {
      const id = generateId();
      const slug = `get-by-id-${sfx}`;
      await repo.createProject({
        id, slug, name: 'Get By Id', description: '', notes: '',
        created_by: USER_A, created_at: now(), archived: 0,
        default_lead_agent: '', default_model: '', vault_generated: 1,
      });
      const found = await repo.getProjectById(id);
      assert.ok(found, 'should find project by id');
      assert.equal(found.id, id);
      assert.equal(found.slug, slug);
    });

    // ── By slug ───────────────────────────────────────────────────────────────

    test('getProjectBySlug — returns the project', async () => {
      const id = generateId();
      const slug = `slug-test-${sfx}`;
      await repo.createProject({
        id, slug, name: 'Slug Test', description: '', notes: '',
        created_by: USER_A, created_at: now(), archived: 0,
        default_lead_agent: '', default_model: '', vault_generated: 1,
      });
      const found = await repo.getProjectBySlug(slug);
      assert.ok(found, 'should find project by slug');
      assert.equal(found.id, id);
    });

    test('getProjectBySlug — returns null for unknown slug', async () => {
      const result = await repo.getProjectBySlug('no-such-slug-00000');
      assert.equal(result, null);
    });

    // ── Duplicate slug rejected ───────────────────────────────────────────────

    test('createProject — duplicate slug throws SlugAlreadyTakenError', async () => {
      const slug = `dup-slug-${sfx}`;
      await repo.createProject({
        id: generateId(), slug, name: 'First', description: '', notes: '',
        created_by: USER_A, created_at: now(), archived: 0,
        default_lead_agent: '', default_model: '', vault_generated: 1,
      });

      await assert.rejects(
        () => repo.createProject({
          id: generateId(), slug, name: 'Second', description: '', notes: '',
          created_by: USER_B, created_at: now(), archived: 0,
          default_lead_agent: '', default_model: '', vault_generated: 1,
        }),
        (err: unknown) => {
          assert.ok(err instanceof SlugAlreadyTakenError, `Expected SlugAlreadyTakenError, got: ${String(err)}`);
          return true;
        },
      );
    });

    test('createProject — concurrent creates with same slug: only one succeeds', async () => {
      const slug = `concurrent-${sfx}`;
      const makeProject = () => repo.createProject({
        id: generateId(), slug, name: 'Concurrent', description: '', notes: '',
        created_by: USER_A, created_at: now(), archived: 0,
        default_lead_agent: '', default_model: '', vault_generated: 1,
      });

      const results = await Promise.allSettled([makeProject(), makeProject()]);
      const successes = results.filter((r) => r.status === 'fulfilled').length;
      const failures  = results.filter((r) => r.status === 'rejected').length;
      assert.equal(successes, 1, 'exactly one create should succeed');
      assert.equal(failures, 1, 'exactly one create should fail');
    });

    // ── Update / archive ──────────────────────────────────────────────────────

    test('updateProject — updates name and description', async () => {
      const id = generateId();
      await repo.createProject({
        id, slug: `update-${sfx}`, name: 'Before', description: 'old', notes: '',
        created_by: USER_A, created_at: now(), archived: 0,
        default_lead_agent: '', default_model: '', vault_generated: 1,
      });

      const updated = await repo.updateProject(id, { name: 'After', description: 'new' });
      assert.ok(updated, 'should return updated project');
      assert.equal(updated.name, 'After');
      assert.equal(updated.description, 'new');
    });

    test('archiveProject — sets archived=1', async () => {
      const id = generateId();
      await repo.createProject({
        id, slug: `archive-${sfx}`, name: 'To Archive', description: '', notes: '',
        created_by: USER_A, created_at: now(), archived: 0,
        default_lead_agent: '', default_model: '', vault_generated: 1,
      });
      await repo.archiveProject(id);

      // listProjects should exclude it
      const projects = await repo.listProjects();
      const found = projects.find((p) => p.id === id);
      assert.equal(found, undefined, 'archived project should not appear in listProjects');
    });

    // ── listProjects ordering ─────────────────────────────────────────────────

    test('listProjects — returns non-archived projects newest-first', async () => {
      // Create two projects with deterministic timestamps
      const ts1 = `2020-01-01T00:00:00.000Z`;
      const ts2 = `2020-01-02T00:00:00.000Z`;
      const id1 = generateId();
      const id2 = generateId();

      await repo.createProject({
        id: id1, slug: `order-a-${sfx}`, name: 'Order A', description: '', notes: '',
        created_by: USER_A, created_at: ts1, archived: 0,
        default_lead_agent: '', default_model: '', vault_generated: 1,
      });
      await repo.createProject({
        id: id2, slug: `order-b-${sfx}`, name: 'Order B', description: '', notes: '',
        created_by: USER_A, created_at: ts2, archived: 0,
        default_lead_agent: '', default_model: '', vault_generated: 1,
      });

      const projects = await repo.listProjects();
      const ids = projects.map((p) => p.id);
      const pos1 = ids.indexOf(id1);
      const pos2 = ids.indexOf(id2);
      assert.ok(pos1 >= 0, 'project 1 should be in list');
      assert.ok(pos2 >= 0, 'project 2 should be in list');
      // id2 (newer) should come before id1 (older)
      assert.ok(pos2 < pos1, 'newer project should appear first (created_at DESC)');
    });

    test('listProjects — excludes archived', async () => {
      const id = generateId();
      await repo.createProject({
        id, slug: `arch-filter-${sfx}`, name: 'Archived Filter', description: '', notes: '',
        created_by: USER_A, created_at: now(), archived: 0,
        default_lead_agent: '', default_model: '', vault_generated: 1,
      });
      await repo.archiveProject(id);
      const projects = await repo.listProjects();
      assert.ok(!projects.some((p) => p.id === id), 'archived project must not be in listProjects');
    });

    // ── listMyProjects ────────────────────────────────────────────────────────

    test('listMyProjects — returns only projects the user is a member of', async () => {
      const projId = generateId();
      await repo.createProject({
        id: projId, slug: `my-proj-${sfx}`, name: 'My Project', description: '', notes: '',
        created_by: USER_A, created_at: now(), archived: 0,
        default_lead_agent: '', default_model: '', vault_generated: 1,
      });
      await repo.addMember(projId, USER_B, 'viewer');

      const userBProjects = await repo.listMyProjects(USER_B);
      assert.ok(userBProjects.some((p) => p.id === projId), 'USER_B should see the project they were added to');

      const userCProjects = await repo.listMyProjects(USER_C);
      assert.ok(!userCProjects.some((p) => p.id === projId), 'USER_C should not see a project they have no membership in');
    });

    test('listMyProjects — excludes archived projects', async () => {
      const projId = generateId();
      await repo.createProject({
        id: projId, slug: `my-arch-${sfx}`, name: 'My Archived', description: '', notes: '',
        created_by: USER_A, created_at: now(), archived: 0,
        default_lead_agent: '', default_model: '', vault_generated: 1,
      });
      await repo.addMember(projId, USER_B, 'viewer');
      await repo.archiveProject(projId);

      const projects = await repo.listMyProjects(USER_B);
      assert.ok(!projects.some((p) => p.id === projId), 'archived project must not appear in listMyProjects');
    });

    test('listMyProjects — ordering: newest first', async () => {
      const ts1 = `2019-06-01T00:00:00.000Z`;
      const ts2 = `2019-06-02T00:00:00.000Z`;
      const idA = generateId();
      const idB = generateId();

      await repo.createProject({
        id: idA, slug: `my-order-a-${sfx}`, name: 'My Order A', description: '', notes: '',
        created_by: USER_A, created_at: ts1, archived: 0,
        default_lead_agent: '', default_model: '', vault_generated: 1,
      });
      await repo.createProject({
        id: idB, slug: `my-order-b-${sfx}`, name: 'My Order B', description: '', notes: '',
        created_by: USER_A, created_at: ts2, archived: 0,
        default_lead_agent: '', default_model: '', vault_generated: 1,
      });
      await repo.addMember(idA, USER_C, 'viewer');
      await repo.addMember(idB, USER_C, 'viewer');

      const projects = await repo.listMyProjects(USER_C);
      const ids = projects.map((p) => p.id);
      const posA = ids.indexOf(idA);
      const posB = ids.indexOf(idB);
      assert.ok(posA >= 0 && posB >= 0, 'both projects should be in listMyProjects');
      assert.ok(posB < posA, 'newer project should appear first');
    });

    // ── Members ───────────────────────────────────────────────────────────────

    test('addMember / getMember — round trip', async () => {
      const projId = generateId();
      await repo.createProject({
        id: projId, slug: `member-rt-${sfx}`, name: 'Member RT', description: '', notes: '',
        created_by: USER_A, created_at: now(), archived: 0,
        default_lead_agent: '', default_model: '', vault_generated: 1,
      });

      await repo.addMember(projId, USER_A, 'owner');
      const member = await repo.getMember(projId, USER_A);
      assert.ok(member, 'should find the added member');
      assert.equal(member.role, 'owner');
      assert.equal(member.access, 'owner');
      assert.equal(member.user_id, USER_A);
      assert.equal(member.project_id, projId);
    });

    test('getMember — returns null for non-member', async () => {
      const projId = generateId();
      await repo.createProject({
        id: projId, slug: `no-member-${sfx}`, name: 'No Member', description: '', notes: '',
        created_by: USER_A, created_at: now(), archived: 0,
        default_lead_agent: '', default_model: '', vault_generated: 1,
      });
      const m = await repo.getMember(projId, USER_C);
      assert.equal(m, null);
    });

    test('updateMember — changes role', async () => {
      const projId = generateId();
      await repo.createProject({
        id: projId, slug: `role-change-${sfx}`, name: 'Role Change', description: '', notes: '',
        created_by: USER_A, created_at: now(), archived: 0,
        default_lead_agent: '', default_model: '', vault_generated: 1,
      });
      await repo.addMember(projId, USER_A, 'viewer');
      await repo.updateMember(projId, USER_A, 'editor');

      const m = await repo.getMember(projId, USER_A);
      assert.equal(m?.role, 'editor');
      assert.equal(m?.access, 'editor');
    });

    test('removeMember — returns true when found, false when not found', async () => {
      const projId = generateId();
      await repo.createProject({
        id: projId, slug: `remove-mem-${sfx}`, name: 'Remove Mem', description: '', notes: '',
        created_by: USER_A, created_at: now(), archived: 0,
        default_lead_agent: '', default_model: '', vault_generated: 1,
      });
      await repo.addMember(projId, USER_A, 'viewer');

      const removed = await repo.removeMember(projId, USER_A);
      assert.equal(removed, true, 'should return true when member existed');

      const afterRemove = await repo.getMember(projId, USER_A);
      assert.equal(afterRemove, null, 'member should be gone');

      const removedAgain = await repo.removeMember(projId, USER_A);
      assert.equal(removedAgain, false, 'should return false when member not found');
    });

    // ── Role checks ───────────────────────────────────────────────────────────

    test('isMember — true for member, false for non-member', async () => {
      const projId = generateId();
      await repo.createProject({
        id: projId, slug: `ismember-${sfx}`, name: 'Is Member', description: '', notes: '',
        created_by: USER_A, created_at: now(), archived: 0,
        default_lead_agent: '', default_model: '', vault_generated: 1,
      });
      await repo.addMember(projId, USER_A, 'viewer');

      assert.equal(await repo.isMember(projId, USER_A), true);
      assert.equal(await repo.isMember(projId, USER_C), false);
    });

    test('roleOf — returns role for member, null for non-member', async () => {
      const projId = generateId();
      await repo.createProject({
        id: projId, slug: `roleof-${sfx}`, name: 'Role Of', description: '', notes: '',
        created_by: USER_A, created_at: now(), archived: 0,
        default_lead_agent: '', default_model: '', vault_generated: 1,
      });
      await repo.addMember(projId, USER_A, 'owner');
      await repo.addMember(projId, USER_B, 'editor');

      assert.equal(await repo.roleOf(projId, USER_A), 'owner');
      assert.equal(await repo.roleOf(projId, USER_B), 'editor');
      assert.equal(await repo.roleOf(projId, USER_C), null);
    });

    // ── countOwners / countMembers ────────────────────────────────────────────

    test('countOwners — counts only owner-role members', async () => {
      const projId = generateId();
      await repo.createProject({
        id: projId, slug: `owners-count-${sfx}`, name: 'Owners Count', description: '', notes: '',
        created_by: USER_A, created_at: now(), archived: 0,
        default_lead_agent: '', default_model: '', vault_generated: 1,
      });
      await repo.addMember(projId, USER_A, 'owner');
      await repo.addMember(projId, USER_B, 'editor');

      const owners = await repo.countOwners(projId);
      const members = await repo.countMembers(projId);
      assert.equal(owners, 1, 'exactly one owner');
      assert.equal(members, 2, 'two members total');
    });

    // ── project delete removes member items ───────────────────────────────────

    test('archiveProject — members remain but project excluded from listing', async () => {
      const projId = generateId();
      await repo.createProject({
        id: projId, slug: `del-cascade-${sfx}`, name: 'Delete Cascade', description: '', notes: '',
        created_by: USER_A, created_at: now(), archived: 0,
        default_lead_agent: '', default_model: '', vault_generated: 1,
      });
      await repo.addMember(projId, USER_A, 'owner');
      await repo.addMember(projId, USER_B, 'viewer');

      await repo.archiveProject(projId);

      // Project is excluded from listProjects and listMyProjects
      const all = await repo.listProjects();
      assert.ok(!all.some((p) => p.id === projId), 'archived project absent from listProjects');

      const mine = await repo.listMyProjects(USER_A);
      assert.ok(!mine.some((p) => p.id === projId), 'archived project absent from listMyProjects');

      // member rows still accessible via getMember (soft archive, not hard delete)
      // This is intentional: archiving is a soft operation in SQLite; hard-delete cascades are
      // not tested here because the repository's archiveProject only sets archived=1.
    });

    // ── Teams ─────────────────────────────────────────────────────────────────

    test('createTeam / getTeamById — round trip', async () => {
      const id = generateId();
      const ts = now();
      const team = await repo.createTeam({
        id,
        name: `Team ${sfx}`,
        description: 'A team',
        monthly_budget_usd: null,
        created_by: USER_A,
        created_at: ts,
        updated_at: ts,
      });

      assert.equal(team.id, id);
      assert.equal(team.name, `Team ${sfx}`);

      const found = await repo.getTeamById(id);
      assert.ok(found, 'should find team by id');
      assert.equal(found.id, id);
    });

    test('getTeamById — returns null for unknown id', async () => {
      const result = await repo.getTeamById('no-such-team-00000');
      assert.equal(result, null);
    });

    test('updateTeam — changes name', async () => {
      const id = generateId();
      const ts = now();
      await repo.createTeam({
        id, name: `Before ${sfx}`, description: '', monthly_budget_usd: null,
        created_by: USER_A, created_at: ts, updated_at: ts,
      });
      await repo.updateTeam(id, { name: `After ${sfx}` });
      const updated = await repo.getTeamById(id);
      assert.equal(updated?.name, `After ${sfx}`);
    });

    test('deleteTeam — removes the team', async () => {
      const id = generateId();
      const ts = now();
      await repo.createTeam({
        id, name: `To Delete ${sfx}`, description: '', monthly_budget_usd: null,
        created_by: USER_A, created_at: ts, updated_at: ts,
      });
      await repo.deleteTeam(id);
      const found = await repo.getTeamById(id);
      assert.equal(found, null, 'deleted team should not be found');
    });

    // ── Team members ──────────────────────────────────────────────────────────

    test('addTeamMember / listTeamMembers — round trip', async () => {
      const teamId = generateId();
      const ts = now();
      await repo.createTeam({
        id: teamId, name: `TM Team ${sfx}`, description: '', monthly_budget_usd: null,
        created_by: USER_A, created_at: ts, updated_at: ts,
      });

      await repo.addTeamMember(teamId, USER_A, 'owner');
      await repo.addTeamMember(teamId, USER_B, 'member');

      const members = await repo.listTeamMembers(teamId);
      assert.equal(members.length, 2);
      const roles = new Map(members.map((m) => [m.user_id, m.role]));
      assert.equal(roles.get(USER_A), 'owner');
      assert.equal(roles.get(USER_B), 'member');
    });

    test('removeTeamMember — removes member', async () => {
      const teamId = generateId();
      const ts = now();
      await repo.createTeam({
        id: teamId, name: `RM Team ${sfx}`, description: '', monthly_budget_usd: null,
        created_by: USER_A, created_at: ts, updated_at: ts,
      });
      await repo.addTeamMember(teamId, USER_A, 'member');
      await repo.removeTeamMember(teamId, USER_A);

      const members = await repo.listTeamMembers(teamId);
      assert.ok(!members.some((m) => m.user_id === USER_A), 'USER_A should be removed');
    });

    test('deleteTeam — cascades to team members', async () => {
      const teamId = generateId();
      const ts = now();
      await repo.createTeam({
        id: teamId, name: `Cascade Team ${sfx}`, description: '', monthly_budget_usd: null,
        created_by: USER_A, created_at: ts, updated_at: ts,
      });
      await repo.addTeamMember(teamId, USER_A, 'owner');
      await repo.addTeamMember(teamId, USER_B, 'member');

      await repo.deleteTeam(teamId);

      const members = await repo.listTeamMembers(teamId);
      assert.equal(members.length, 0, 'members should be gone after team delete');
    });

    // ── Security / correctness fixes (items 1–5) ──────────────────────────────

    test('updateMember — no-op when member does not exist', async () => {
      const projId = generateId();
      await repo.createProject({
        id: projId, slug: `upd-nomem-${sfx}`, name: 'Upd No Mem', description: '', notes: '',
        created_by: USER_A, created_at: now(), archived: 0,
        default_lead_agent: '', default_model: '', vault_generated: 1,
      });
      // USER_C is not a member — updateMember must be a no-op, not an upsert
      await repo.updateMember(projId, USER_C, 'editor');
      const m = await repo.getMember(projId, USER_C);
      assert.equal(m, null, 'updateMember on a non-member must not create a membership item');
    });

    test('addMember — no-op on existing member (original role preserved)', async () => {
      const projId = generateId();
      await repo.createProject({
        id: projId, slug: `add-existing-${sfx}`, name: 'Add Existing', description: '', notes: '',
        created_by: USER_A, created_at: now(), archived: 0,
        default_lead_agent: '', default_model: '', vault_generated: 1,
      });
      await repo.addMember(projId, USER_A, 'owner');
      // Try to add again with a different role — must be a no-op
      await repo.addMember(projId, USER_A, 'viewer');
      const m = await repo.getMember(projId, USER_A);
      assert.equal(m?.role, 'owner', 'existing member role must not change on duplicate addMember');
    });

    test('vault_generated — value 0 round-trips correctly', async () => {
      const id = generateId();
      const slug = `vault-zero-${sfx}`;
      const record = await repo.createProject({
        id, slug, name: 'Vault Zero', description: '', notes: '',
        created_by: USER_A, created_at: now(), archived: 0,
        default_lead_agent: '', default_model: '', vault_generated: 0,
      });
      assert.equal(record.vault_generated, 0, 'createProject must return vault_generated=0 as stored');

      const found = await repo.getProjectById(id);
      assert.ok(found, 'project must be findable');
      assert.equal(found.vault_generated, 0, 'vault_generated=0 must survive a round-trip through getProjectById');
    });

    test('createProjectWithOwner — project exists and owner is listed', async () => {
      const id = generateId();
      const slug = `with-owner-${sfx}`;
      const project = await repo.createProjectWithOwner(
        {
          id, slug, name: 'With Owner', description: '', notes: '',
          created_by: USER_A, created_at: now(), archived: 0,
          default_lead_agent: '', default_model: '', vault_generated: 1,
        },
        USER_A,
      );

      assert.equal(project.id, id, 'returned record must have the correct id');

      // Owner must be in the member list immediately — atomicity check
      const members = await repo.listMembers(id);
      assert.ok(
        members.some((m) => m.user_id === USER_A && m.role === 'owner'),
        'createProjectWithOwner must add the owner atomically',
      );

      const member = await repo.getMember(id, USER_A);
      assert.ok(member, 'owner should be retrievable via getMember');
      assert.equal(member.role, 'owner');
      assert.equal(member.access, 'owner');
    });

    test('createProjectWithOwner — duplicate slug throws SlugAlreadyTakenError', async () => {
      const slug = `dup-owner-${sfx}`;
      await repo.createProjectWithOwner(
        {
          id: generateId(), slug, name: 'Owner Dup First', description: '', notes: '',
          created_by: USER_A, created_at: now(), archived: 0,
          default_lead_agent: '', default_model: '', vault_generated: 1,
        },
        USER_A,
      );

      await assert.rejects(
        () => repo.createProjectWithOwner(
          {
            id: generateId(), slug, name: 'Owner Dup Second', description: '', notes: '',
            created_by: USER_B, created_at: now(), archived: 0,
            default_lead_agent: '', default_model: '', vault_generated: 1,
          },
          USER_B,
        ),
        (err: unknown) => {
          assert.ok(err instanceof SlugAlreadyTakenError, `Expected SlugAlreadyTakenError, got: ${String(err)}`);
          return true;
        },
        'duplicate slug via createProjectWithOwner must throw SlugAlreadyTakenError',
      );
    });
  });
}

// ── SQLite suite ───────────────────────────────────────────────────────────────

runContract('SQLite', async () => {
  createTestDb();
  const repo = new SqliteProjectRepository();
  return repo;
}, async () => {
  seedUsersSqlite();
});

// ── DynamoDB Local suite ───────────────────────────────────────────────────────

const ddbEndpoint = process.env.DYNAMODB_ENDPOINT;
const requireDynamoDb = process.env.REQUIRE_DYNAMODB === '1';

describe('DynamoDB Local suite', async () => {
  if (!ddbEndpoint) {
    if (requireDynamoDb) {
      throw new Error(
        'REQUIRE_DYNAMODB=1 is set but DYNAMODB_ENDPOINT is not configured. ' +
        'Start DynamoDB Local and set DYNAMODB_ENDPOINT=http://localhost:8000',
      );
    }
    // Skip gracefully when DynamoDB Local is not available
    test.skip('DynamoDB suite — DYNAMODB_ENDPOINT not set', () => {});
    return;
  }

  // Verify connectivity before importing the DynamoDB module
  try {
    const resp = await fetch(`${ddbEndpoint}/`, {
      method: 'GET',
      signal: AbortSignal.timeout(3000),
    });
    // DynamoDB Local returns 400 for an empty GET, which is fine — it means it is up.
    void resp;
  } catch {
    if (requireDynamoDb) {
      throw new Error(`REQUIRE_DYNAMODB=1 is set but DynamoDB Local at ${ddbEndpoint} is not reachable`);
    }
    test.skip('DynamoDB suite — endpoint not reachable', () => {});
    return;
  }

  const { DynamoDbProjectRepository, ensurePortalProjectsTableExists } = await import(
    '../server/repositories/projects-dynamodb.ts'
  );
  const { getDynamoDbClient, clearDynamoDbClient } = await import(
    '../server/repositories/dynamo-client.ts'
  );

  const TABLE_NAME = process.env.DYNAMODB_TABLE_PORTAL_PROJECTS ?? 'portal-projects-test';
  const USERS_TABLE = process.env.DYNAMODB_TABLE_PORTAL_USERS ?? 'portal-users-test';

  // Set up the table once before all DynamoDB tests
  before(async () => {
    // Override endpoint for tests
    process.env.DYNAMODB_ENDPOINT = ddbEndpoint;
    clearDynamoDbClient();
    const client = getDynamoDbClient();
    await ensurePortalProjectsTableExists(client, TABLE_NAME);

    // Also create the users table (needed for seedUsersDynamodb)
    const { ensurePortalUsersTableExists } = await import(
      '../server/repositories/auth-dynamodb.ts'
    );
    await ensurePortalUsersTableExists(client, USERS_TABLE);
  });

  after(() => {
    clearDynamoDbClient();
    clearProjectRepository();
  });

  runContract('DynamoDB', async () => {
    clearDynamoDbClient();
    const client = getDynamoDbClient();
    return new DynamoDbProjectRepository({ client, tableName: TABLE_NAME });
  }, async () => {
    // Seed users via auth repository so FK lookups work in DynamoDB
    const { DynamoDbAuthRepository } = await import(
      '../server/repositories/auth-dynamodb.ts'
    );
    clearDynamoDbClient();
    const client = getDynamoDbClient();
    const authRepo = new DynamoDbAuthRepository({ client, tableName: USERS_TABLE });
    await seedUsersDynamodb(authRepo);
  });
});

// ── Module-level cleanup ──────────────────────────────────────────────────────

after(async () => {
  await cleanup();
});
